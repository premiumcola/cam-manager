"""Frame validation helpers shared by the timelapse capture loops.

Single source of truth for "is this frame worth keeping?". The full pipeline
(``is_valid_frame``) bundles every individual heuristic so callers don't have
to chain them. The retry wrapper ``grab_valid_frame`` lets a caller turn a
single-shot frame fetch into a 3-attempt retry without each capture loop
inventing its own backoff loop.

All thresholds are module constants so they're easy to retune later without
hunting through call sites. The functions are stateless and side-effect free
apart from the retry helper's ``time.sleep``."""
from __future__ import annotations
from dataclasses import dataclass, asdict, field
from datetime import datetime
from pathlib import Path
import json
import logging
import time

import cv2
import numpy as np

log = logging.getLogger(__name__)


# ── Tunables ─────────────────────────────────────────────────────────────────
# Bytes/pixels: minimum decoded dimensions before we even bother heuristic-ing.
_MIN_FRAME_W = 32
_MIN_FRAME_H = 24

# Brightness: completely-black or completely-white frames never carry useful
# imagery — these come from missing/oversaturated streams.
_BRIGHTNESS_FLOOR = 2.0
_BRIGHTNESS_CEIL = 253.0

# Pink/magenta H.265 corruption pattern: heavy red dominance on the whole
# frame OR on a single quadrant.
_PINK_FULL_R_MIN = 160.0
_PINK_FULL_RATIO = 2.5
_PINK_QUAD_R_MIN = 180.0
_PINK_QUAD_RATIO = 3.0

# Spatial-detail floor in grayscale std. A truly flat frame (single color,
# no texture, no noise) sits below ~2; legitimate dark frames at night still
# have sensor noise and easily clear this bar.
_FLAT_GRAY_STD_FLOOR = 2.0

# Grey-hickup heuristic — addresses the specific "Reolink substream returns
# a uniform mid-grey frame" issue. Two complementary rules:
#  1. Sum of per-channel std < this threshold → frame is essentially uniform
#     across all three channels (flat grey, flat black, flat white). IR/night
#     frames have far more texture than this and clear the bar comfortably.
#  2. Mean brightness inside a mid-grey band combined with low total std
#     catches the specific "encoder gave us 50% grey" hickup that escapes
#     rule 1 because it has just enough JPEG noise.
_GREY_CHANNEL_STD_SUM = 8.0
_GREY_MIDBAND_MIN = 115.0
_GREY_MIDBAND_MAX = 140.0
_GREY_MIDBAND_TOTAL_STD = 12.0

# Colorbar / SMPTE pattern detection: cameras that switch IR mode mid-stream
# can briefly emit a multi-band test pattern. Heuristic: the frame has high
# horizontal-row uniformity (each row is one solid color) but very different
# colors between rows. Cheap because we sample 9 rows.
_COLORBAR_ROW_SAMPLES = 9
_COLORBAR_PER_ROW_STD = 6.0   # each sampled row must be near-uniform
_COLORBAR_BETWEEN_ROW_STD = 35.0  # but row-to-row variance is huge

# Tile-based dead-area scoring — catches three real-world corruption modes
# that slip past the global heuristics above:
#   (a) Frame is mostly uniform grey but a thin band at the top still
#       contains the live OSD timestamp (decoder partial-block-loss).
#   (b) Whole frame is grey-toned macroblock noise (lost reference frames in
#       H.264) where per-channel std lands around 15–25 — too high for the
#       grey-uniform rule but with no real edges anywhere.
#   (c) Half the frame is a glitched colourful smear, the other half grey
#       noise — neither half on its own trips the existing per-quadrant
#       checks.
# Tile a frame into _TILE_GRID_W × _TILE_GRID_H cells; flag a tile as "dead"
# when it has no real spatial detail (low std AND low Laplacian variance,
# OR mid-grey-band mean with low edge density). Reject the frame when more
# than _TILE_DEAD_FRACTION of tiles are dead. 8×5 tiles is a good balance
# between resolution (catches a 12.5 % strip) and CPU cost (~40 calls per
# frame, all numpy/cv2 vectorised).
_TILE_GRID_W = 8
_TILE_GRID_H = 5
# A 5×5 box blur preserves real low-frequency structure and collapses
# pixel-level random noise. Comparing the tile's std against the *blurred*
# tile's std separates "real imagery" (blur survives) from "white noise"
# (blur kills it). Macroblock corruption produces tiles with high raw std
# but low blurred std — exactly what we want to flag.
_TILE_BLUR_KSIZE = 5
_TILE_DEAD_BLURRED_STD_FLOOR = 3.0   # blurred std under this → no real structure
_TILE_GREY_BAND_MIN = 100.0          # mid-grey band lower bound
_TILE_GREY_BAND_MAX = 160.0          # mid-grey band upper bound
_TILE_GREY_BAND_BLURRED_STD = 6.0    # mid-grey tile passes only with real low-freq detail
# Per-tile chroma uniformity floor — catches macroblock smears that have
# luma structure (bstd above floor) but no chroma variation (B≈G≈R per
# pixel). Gated to the mid-grey luma band so IR/dark/sky tiles
# (legitimately near-monochrome) don't trip it.
_TILE_CHROMA_STD_FLOOR = 4.0
# Threshold tightened from 0.55 → 0.35: a bottom-half macroblock smear
# (the dominant cluster in user-reported timelapse corruption) lands
# around 50 % dead-tile fraction and previously passed; a quarter-frame
# corruption lands around 25 % and still passes.
_TILE_DEAD_FRACTION = 0.35           # > 35 % dead tiles → reject the frame

# Frame-level "grey-toned mid-luma" gate. Catches H.264 macroblock-corruption
# frames that escape the per-tile dead-area test because each tile has
# variance from block-to-block randomness — but the WHOLE FRAME is grey-toned
# (B≈G≈R) and sits at mid-luma. Real IR-night frames are also chroma-flat but
# they're dark (luma well below 80), so the luma-band guard prevents false
# positives. Real daytime frames have plenty of inter-channel variation and
# easily clear the chroma threshold.
_GREY_TONED_LUMA_MIN = 100.0
_GREY_TONED_LUMA_MAX = 160.0
_GREY_TONED_CHROMA_STD_MAX = 8.0


# ── Decoding helper ──────────────────────────────────────────────────────────
def _decode(img_or_bytes) -> "np.ndarray | None":
    """Accept either a decoded BGR ndarray or JPEG bytes; return ndarray or None."""
    if img_or_bytes is None:
        return None
    if isinstance(img_or_bytes, (bytes, bytearray, memoryview)):
        try:
            arr = np.frombuffer(bytes(img_or_bytes), dtype=np.uint8)
            return cv2.imdecode(arr, cv2.IMREAD_COLOR)
        except Exception:
            return None
    return img_or_bytes


# ── Individual heuristics ────────────────────────────────────────────────────
def is_grey_frame(img) -> tuple[bool, str]:
    """True when the frame is a uniform mid-grey hickup. False on real imagery
    (including IR/night frames, which have plenty of noise across channels)."""
    img = _decode(img)
    if img is None or img.size == 0:
        return False, ""
    if img.ndim < 3 or img.shape[2] < 3:
        return False, ""
    std_b = float(img[:, :, 0].std())
    std_g = float(img[:, :, 1].std())
    std_r = float(img[:, :, 2].std())
    std_sum = std_b + std_g + std_r
    if std_sum < _GREY_CHANNEL_STD_SUM:
        return True, f"grey_uniform(std_sum={std_sum:.1f})"
    mean_brightness = float((img[:, :, 0].mean() + img[:, :, 1].mean() + img[:, :, 2].mean()) / 3.0)
    if (_GREY_MIDBAND_MIN <= mean_brightness <= _GREY_MIDBAND_MAX
            and std_sum < _GREY_MIDBAND_TOTAL_STD):
        return True, f"grey_midband(brightness={mean_brightness:.0f},std_sum={std_sum:.1f})"
    return False, ""


def dead_area_score(img) -> tuple[float, int, int]:
    """Score a frame for "dead area" using a fixed tile grid.

    Returns (dead_fraction, dead_tile_count, total_tile_count). A tile is
    "dead" when ANY of:
      (1) blurred std < _TILE_DEAD_BLURRED_STD_FLOOR — no real texture
      (2) mid-grey band tile with low blurred std — flat grey block
      (3) mid-grey band tile with B≈G≈R chroma std < _TILE_CHROMA_STD_FLOOR
          — luma-structured but chroma-flat macroblock smear
    Genuine dark/IR frames have noisy texture in every tile and stay near
    zero; corrupted frames with a thin live strip on top score around
    0.85 (the strip has texture, everything below is dead). The chroma
    check (3) is gated to the mid-grey luma band so IR/dark tiles
    (legitimately monochrome) and bright sky tiles (also legitimately
    near-monochrome) never trip it."""
    img = _decode(img)
    if img is None or img.size == 0:
        return 1.0, 0, 0
    h, w = img.shape[:2]
    if h < _TILE_GRID_H * 4 or w < _TILE_GRID_W * 4:
        return 0.0, 0, 0  # too small to tile usefully — caller has other gates
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # Blur once across the whole frame, then crop tiles. The blur kills
    # pixel-level noise (random or macroblock jitter) but preserves real
    # low-frequency structure, so std on the blurred tile is the cleanest
    # "is there real imagery in this tile" signal.
    blurred = cv2.blur(gray, (_TILE_BLUR_KSIZE, _TILE_BLUR_KSIZE))
    th, tw = h // _TILE_GRID_H, w // _TILE_GRID_W
    dead = 0
    total = 0
    for ty in range(_TILE_GRID_H):
        for tx in range(_TILE_GRID_W):
            y0, y1 = ty * th, (ty + 1) * th
            x0, x1 = tx * tw, (tx + 1) * tw
            blurred_tile = blurred[y0:y1, x0:x1]
            bstd = float(blurred_tile.std())
            tmean = float(blurred_tile.mean())
            tile_dead = False
            if bstd < _TILE_DEAD_BLURRED_STD_FLOOR:
                tile_dead = True
            elif (_TILE_GREY_BAND_MIN <= tmean <= _TILE_GREY_BAND_MAX
                  and bstd < _TILE_GREY_BAND_BLURRED_STD):
                tile_dead = True
            elif _TILE_GREY_BAND_MIN <= tmean <= _TILE_GREY_BAND_MAX:
                # Chroma uniformity check — only fires inside the
                # mid-grey luma band where macroblock corruption lives.
                # IR/night/sky tiles (luma outside the band) skip this
                # branch and stay alive.
                tile_bgr = img[y0:y1, x0:x1]
                if tile_bgr.size > 0 and tile_bgr.ndim >= 3 and tile_bgr.shape[2] >= 3:
                    b = tile_bgr[:, :, 0].astype(np.int16)
                    g = tile_bgr[:, :, 1].astype(np.int16)
                    r = tile_bgr[:, :, 2].astype(np.int16)
                    chroma_std = float(
                        (np.abs(b - g).std() + np.abs(b - r).std()) / 2.0
                    )
                    if chroma_std < _TILE_CHROMA_STD_FLOOR:
                        tile_dead = True
            if tile_dead:
                dead += 1
            total += 1
    if total == 0:
        return 0.0, 0, 0
    return dead / total, dead, total


def is_split_frame(img) -> tuple[bool, str]:
    """Detect "half-corrupt" frames where one quadrant or one half of
    the image is dead grey while the opposite half carries real
    chroma. Classic H.264 reference-frame corruption mode that slips
    past dead_area_score because only ~50 % of tiles are dead — under
    the global threshold but the visual result is unusable.

    Returns (True, reason) when one half's chroma activity is well
    below the other half's, with a wide gap (3.0 vs 12.0) so that
    legitimate compositional asymmetry (e.g. one half is a flat sky,
    the other is a textured tree line) doesn't trip. False on every
    other frame including IR/night (both halves equally chroma-flat
    → both scores low → no split detected)."""
    img = _decode(img)
    if img is None or img.size == 0:
        return False, ""
    if img.ndim < 3 or img.shape[2] < 3:
        return False, ""
    h, w = img.shape[:2]
    if h < 80 or w < 80:
        return False, ""

    def _chroma_score(region):
        if region.size == 0:
            return 0.0
        b = region[:, :, 0].astype(np.int16)
        g = region[:, :, 1].astype(np.int16)
        r = region[:, :, 2].astype(np.int16)
        return float(np.abs(b - g).mean() + np.abs(b - r).mean())

    halves = {
        "left":   img[:, :w // 2],
        "right":  img[:, w // 2:],
        "top":    img[:h // 2, :],
        "bottom": img[h // 2:, :],
    }
    scores = {k: _chroma_score(v) for k, v in halves.items()}
    # Split is declared when one side falls below the dead threshold
    # AND the opposite side clears the alive threshold. The wide gap
    # (3.0 vs 12.0) protects against legitimate asymmetry: a flat sky
    # half (~5-8) plus a textured ground half (~15) is NOT a split —
    # only when one half collapses well below 5 does the heuristic
    # trip.
    pairs = [("left", "right"), ("top", "bottom")]
    for a, b in pairs:
        sa, sb = scores[a], scores[b]
        if sa < 3.0 and sb > 12.0:
            return True, f"split_{a}_dead(scores={sa:.1f}/{sb:.1f})"
        if sb < 3.0 and sa > 12.0:
            return True, f"split_{b}_dead(scores={sa:.1f}/{sb:.1f})"
    return False, ""


def is_colorbar(img) -> tuple[bool, str]:
    """True when the frame looks like a horizontal-stripe test pattern: each
    row is near-uniform but rows differ wildly. False on real imagery."""
    img = _decode(img)
    if img is None or img.size == 0:
        return False, ""
    h, w = img.shape[:2]
    if h < _COLORBAR_ROW_SAMPLES or w < _COLORBAR_ROW_SAMPLES:
        return False, ""
    # Grayscale rows so colourful-but-uniform bars (e.g. SMPTE pattern) get
    # a low per-row std even when their channels differ — we only care
    # whether each row is internally uniform along x.
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    sample_rows = np.linspace(2, h - 3, _COLORBAR_ROW_SAMPLES, dtype=int)
    row_means = []
    per_row_stds = []
    for ry in sample_rows:
        row_g = gray[ry, :]
        per_row_stds.append(float(row_g.std()))
        row_means.append(float(row_g.mean()))
    if max(per_row_stds) > _COLORBAR_PER_ROW_STD:
        return False, ""
    between = float(np.std(row_means))
    if between > _COLORBAR_BETWEEN_ROW_STD:
        return True, f"colorbar(per_row_std<{max(per_row_stds):.1f},between={between:.1f})"
    return False, ""


def is_valid_frame(img) -> tuple[bool, str]:
    """Bundled validity check used by every timelapse capture and build path.

    Returns (True, "") when the frame is suitable for inclusion in a
    timelapse, otherwise (False, "<reason>"). Conservative: night/dark/IR
    frames pass, only truly broken inputs (null, too small, blown-out
    brightness, pink corruption, flat fill, mid-grey hickup, colorbar) fail."""
    img = _decode(img)
    if img is None or img.size == 0:
        return False, "null/empty"
    h, w = img.shape[:2]
    if w < _MIN_FRAME_W or h < _MIN_FRAME_H:
        return False, "too_small"

    b = float(img[:, :, 0].mean())
    g = float(img[:, :, 1].mean())
    r = float(img[:, :, 2].mean())
    brightness = (b + g + r) / 3.0
    if brightness < _BRIGHTNESS_FLOOR:
        return False, f"too_dark(brightness={brightness:.1f})"
    if brightness > _BRIGHTNESS_CEIL:
        return False, f"too_bright(brightness={brightness:.1f})"

    # Full-frame pink/magenta H.265 artifact
    if r > _PINK_FULL_R_MIN and r > g * _PINK_FULL_RATIO and r > b * _PINK_FULL_RATIO:
        return False, f"pink_artifact(r={r:.0f},g={g:.0f},b={b:.0f})"
    # Quadrant-level partial pink check
    qh, qw = h // 2, w // 2
    for qi, (rs, cs) in enumerate([(slice(0, qh), slice(0, qw)),
                                    (slice(0, qh), slice(qw, None)),
                                    (slice(qh, None), slice(0, qw)),
                                    (slice(qh, None), slice(qw, None))]):
        sub = img[rs, cs]
        sb = float(sub[:, :, 0].mean())
        sg = float(sub[:, :, 1].mean())
        sr = float(sub[:, :, 2].mean())
        if sr > _PINK_QUAD_R_MIN and sr > sg * _PINK_QUAD_RATIO and sr > sb * _PINK_QUAD_RATIO:
            return False, f"partial_pink_q{qi}(r={sr:.0f},g={sg:.0f},b={sb:.0f})"

    # Truly flat frame (any solid color)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray_std = float(gray.std())
    if gray_std < _FLAT_GRAY_STD_FLOOR:
        return False, f"no_detail(std={gray_std:.2f})"

    # Mid-grey hickup specifically (catches encoder/IR-cut artefacts that
    # have just enough JPEG noise to clear gray_std but no real imagery).
    grey, grey_reason = is_grey_frame(img)
    if grey:
        return False, grey_reason

    # Tile-based dead-area scoring — catches partially-corrupt frames where
    # only a thin strip carries real imagery (the rest is mid-grey or
    # macroblock noise).
    dead_frac, dead_n, total_n = dead_area_score(img)
    if total_n > 0 and dead_frac > _TILE_DEAD_FRACTION:
        return False, f"dead_area({dead_n}/{total_n}={dead_frac:.0%})"

    # Split-frame heuristic — catches the half-corrupt cluster where
    # exactly one half is dead grey and the other half is real
    # imagery. dead_area_score lands near 0.5 in that case, just under
    # the threshold above, but the visual is unusable.
    split, split_reason = is_split_frame(img)
    if split:
        return False, split_reason

    # Grey-toned mid-luma gate — frame-level fallback for blocky H.264
    # macroblock corruption. Such frames have inter-channel variance ≈ 0
    # (B=G=R from chroma drop-out) and luma stuck in the mid-grey band.
    # IR/night passes because it's dark; daytime passes because real
    # scenes carry chroma even under desaturated lighting.
    luma = (b + g + r) / 3.0
    chroma_std_bg = float(np.abs(img[:, :, 0].astype(np.int16) - img[:, :, 1]).std())
    chroma_std_br = float(np.abs(img[:, :, 0].astype(np.int16) - img[:, :, 2]).std())
    chroma_std = (chroma_std_bg + chroma_std_br) / 2.0
    if (_GREY_TONED_LUMA_MIN <= luma <= _GREY_TONED_LUMA_MAX
            and chroma_std < _GREY_TONED_CHROMA_STD_MAX):
        return False, (f"grey_toned(luma={luma:.0f},chroma_std={chroma_std:.1f})")

    # Test-pattern colorbar
    bar, bar_reason = is_colorbar(img)
    if bar:
        return False, bar_reason

    return True, ""


# ── Retry wrapper ────────────────────────────────────────────────────────────
def grab_valid_frame(grab_fn, attempts: int = 3, sleep_s: float = 0.7
                     ) -> tuple[object, int, str]:
    """Call ``grab_fn`` up to ``attempts`` times; return the first frame that
    passes ``is_valid_frame``.

    Returns (frame_or_None, attempt_index_used_or_attempts, last_reason).
    A first-attempt success returns attempt_index_used=0; the caller can use
    that to bump a "retry recoveries" counter when index > 0.

    grab_fn() may return either a decoded BGR ndarray or JPEG bytes — both
    are handled transparently by ``is_valid_frame``."""
    last_reason = ""
    for i in range(max(1, attempts)):
        try:
            frame = grab_fn()
        except Exception as e:
            last_reason = f"grab_exception:{e}"
            frame = None
        if frame is not None:
            ok, reason = is_valid_frame(frame)
            if ok:
                return frame, i, ""
            last_reason = reason or last_reason or "invalid"
        else:
            last_reason = last_reason or "grab_returned_none"
        if i < attempts - 1:
            time.sleep(sleep_s)
    return None, attempts, last_reason


# ── Per-session capture stats ────────────────────────────────────────────────
@dataclass
class CaptureStats:
    """Per-session frame-capture stats. One instance per timelapse window
    (legacy day folder, profile window, sun phase, weather event scratch).

    The flush() method is fault-tolerant — write failures degrade to a
    warning rather than crashing the capture loop, because no stats file
    is ever as important as keeping the capture running."""
    out_dir: Path
    expected_frames: int = 0
    started_at: str = field(default_factory=lambda: datetime.now().isoformat(timespec="seconds"))
    captured_frames: int = 0
    invalid_frames: int = 0
    retry_recoveries: int = 0

    def record_capture(self, attempt_used: int = 0):
        """attempt_used==0 means first try succeeded; >0 means a retry saved it."""
        self.captured_frames += 1
        if attempt_used > 0:
            self.retry_recoveries += 1

    def record_invalid(self):
        self.invalid_frames += 1

    def flush(self):
        try:
            path = Path(self.out_dir) / "_stats.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "started_at": self.started_at,
                "expected_frames": int(self.expected_frames),
                "captured_frames": int(self.captured_frames),
                "invalid_frames": int(self.invalid_frames),
                "retry_recoveries": int(self.retry_recoveries),
            }
            path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        except Exception as e:
            log.warning("[timelapse] could not write _stats.json in %s: %s", self.out_dir, e)


def read_capture_stats(frames_dir: Path) -> dict:
    """Return the per-session stats blob from frames_dir/_stats.json, or
    empty dict if missing/corrupt. Used by the build path to merge into the
    final MP4 manifest."""
    try:
        p = Path(frames_dir) / "_stats.json"
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}
