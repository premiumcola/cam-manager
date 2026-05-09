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

import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

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

# Patterned-magenta detector — catches H.265 corruption blobs that have
# real spatial texture (so means+std-based rules above pass) but a
# huge fraction of pixels stuck in the magenta wedge of colour space.
# A "magenta pixel" here = R high AND B high AND G clearly lower than
# both, plus a minimum dominance margin so legitimate dawn/dusk pinks
# (which lift G almost as much as R/B) don't trip. We downscale the
# frame before the per-pixel pass so the cost stays bounded — even on
# a full-day timelapse rebuild this is cheap.
_PATTERN_MAGENTA_DOWNSCALE = 256        # max width for the per-pixel scan
_PATTERN_MAGENTA_R_MIN = 130            # red channel must reach this
_PATTERN_MAGENTA_B_MIN = 130            # blue channel must reach this
_PATTERN_MAGENTA_GREEN_MAX = 110        # green must be clearly below R+B
_PATTERN_MAGENTA_DOMINANCE = 25         # min(R,B) must beat G by this much
_PATTERN_MAGENTA_AREA_FRAC = 0.20       # ≥ 20 % of pixels in the wedge → reject

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


# ── Validator profiles (DAY / TWILIGHT / NIGHT) ──────────────────────────────
# A real night IR scene legitimately has dead_area ≈ 95-100 %, std_sum
# ≈ 8-11, gray_std ≈ 1.5 — none of which is corruption, just a quiet
# dark scene. Running the daytime thresholds against IR night frames
# rejected 8/23 frames in the November test capture even though every
# frame was a perfectly valid empty terrace at midnight.
#
# A FrameValidatorProfile freezes every threshold is_valid_frame reads
# into one frozen-dataclass-shaped bundle. Three named profiles cover
# the three clusters — DAY (current daytime tunings, no behavioural
# change), TWILIGHT (sunset/sunrise mid-band), NIGHT (true IR night).
# The default is DAY so callers that don't opt in keep the existing
# behaviour bit-identical to before this change.
@dataclass(frozen=True)
class FrameValidatorProfile:
    """Bundle of every threshold ``is_valid_frame`` reads. The defaults
    mirror the existing module-level constants so DAY_PROFILE is a
    pure no-op for daytime callers."""
    name: str = "day"
    # Brightness gates (unchanged across profiles — too dark = too dark
    # regardless of which profile we picked).
    brightness_floor: float = _BRIGHTNESS_FLOOR
    brightness_ceil: float  = _BRIGHTNESS_CEIL
    # Pink/magenta gates — corruption looks the same at any time of day.
    pink_full_r_min: float = _PINK_FULL_R_MIN
    pink_full_ratio: float = _PINK_FULL_RATIO
    pink_quad_r_min: float = _PINK_QUAD_R_MIN
    pink_quad_ratio: float = _PINK_QUAD_RATIO
    # Patterned-magenta detector.
    pattern_magenta_area_frac: float = _PATTERN_MAGENTA_AREA_FRAC
    # Spatial-detail floor (relaxed at night because IR sensor noise
    # produces less variance than a daytime scene).
    flat_gray_std_floor: float = _FLAT_GRAY_STD_FLOOR
    # Grey-hickup heuristic.
    grey_channel_std_sum: float = _GREY_CHANNEL_STD_SUM
    grey_midband_total_std: float = _GREY_MIDBAND_TOTAL_STD
    # Tile-based dead-area scoring (relaxed at twilight + night because
    # legitimate dark scenes legitimately have many empty tiles).
    tile_dead_fraction: float = _TILE_DEAD_FRACTION
    # Frame-level grey-toned mid-luma gate.
    grey_toned_chroma_std_max: float = _GREY_TONED_CHROMA_STD_MAX
    # Colorbar — same shape regardless of time of day.
    colorbar_per_row_std: float = _COLORBAR_PER_ROW_STD
    colorbar_between_row_std: float = _COLORBAR_BETWEEN_ROW_STD


DAY_PROFILE = FrameValidatorProfile(name="day")
TWILIGHT_PROFILE = FrameValidatorProfile(
    name="twilight",
    flat_gray_std_floor=1.2,
    tile_dead_fraction=0.55,
    grey_midband_total_std=8.0,
)
NIGHT_PROFILE = FrameValidatorProfile(
    name="night",
    flat_gray_std_floor=0.8,
    tile_dead_fraction=0.85,
    grey_midband_total_std=5.0,
)


# Picker sanity-gate constants — a sample whose mean sits in
# [115, 145] AND whose grayscale std is < 10 is a flat-grey decoder
# corruption frame, not real scene content. Letting such samples
# influence the profile choice is what produced the slot-287 false-
# positive wave: corruption baseline → mean ≈ 130 → picker chose DAY
# → DAY's strict 35 % dead-tile threshold rejected genuine 38 %-dead
# twilight frames. The gate drops these samples before the median.
_FLAT_GRAY_STD_MAX = 10.0
_FLAT_GRAY_BAND_MIN = 115.0
_FLAT_GRAY_BAND_MAX = 145.0


def _is_flat_gray_corruption_sample(img: np.ndarray) -> bool:
    """A sample whose mean is in [115, 145] AND whose grayscale std
    is < 10 has no real scene content — it's a flat mid-grey decoder
    corruption frame. Not used to influence the profile choice."""
    if img is None or img.size == 0:
        return False
    try:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
        m = float(gray.mean())
        s = float(gray.std())
    except Exception:
        return False
    return (_FLAT_GRAY_BAND_MIN <= m <= _FLAT_GRAY_BAND_MAX
            and s < _FLAT_GRAY_STD_MAX)


def pick_profile_from_baseline(samples) -> FrameValidatorProfile:
    """Pick a validator profile based on the median scene brightness
    of 2-3 reference frames. The capture loop takes a few quick
    snapshots before the slot loop starts so the chosen profile
    matches the actual lighting regardless of clock-vs-real-sun
    drift.

    Bands:
      median brightness < 50  → NIGHT
      50 ≤ median < 110       → TWILIGHT
      median ≥ 110            → DAY

    ``samples`` may contain decoded BGR ndarrays or raw JPEG bytes;
    each is decoded via the module-private ``_decode`` helper.

    Sanity gate: any sample matching the flat-grey corruption
    fingerprint is dropped before the median. If EVERY sample was
    flat-grey corruption (i.e. an entire baseline burst sat inside
    a decoder hickup), we fall back to NIGHT — the loose end of the
    profile spectrum — because letting DAY through here is what
    triggered the slot-287 false-positive wave that motivated this
    fix. NIGHT's relaxed thresholds let real scene content survive,
    and an actual bright-day capture is unlikely to produce three
    all-corruption baselines in a row. ``DAY`` is still the default
    on a "no samples at all" callsite — a literal no-signal call
    shouldn't accidentally inherit night-loose thresholds.
    """
    means: list[float] = []
    rejected_corruption = 0
    total = 0
    for s in samples or []:
        img = _decode(s)
        if img is None or img.size == 0 or img.ndim < 2:
            continue
        total += 1
        if _is_flat_gray_corruption_sample(img):
            rejected_corruption += 1
            continue
        try:
            means.append(float(img.mean()))
        except Exception:
            continue
    if not means:
        if rejected_corruption > 0:
            log.info(
                "[picker] %d/%d baseline samples rejected as flat-grey "
                "corruption; using night",
                rejected_corruption, total,
            )
            return NIGHT_PROFILE
        return DAY_PROFILE
    means.sort()
    med = means[len(means) // 2]
    if med < 50.0:
        picked = NIGHT_PROFILE
    elif med < 110.0:
        picked = TWILIGHT_PROFILE
    else:
        picked = DAY_PROFILE
    if rejected_corruption > 0:
        log.info(
            "[picker] %d/%d baseline samples rejected as flat-grey "
            "corruption; using %s",
            rejected_corruption, total, picked.name,
        )
    return picked


# ── Decoding helper ──────────────────────────────────────────────────────────
def _decode(img_or_bytes) -> np.ndarray | None:
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
def is_grey_frame(img, profile: "FrameValidatorProfile | None" = None) -> tuple[bool, str]:
    """True when the frame is a uniform mid-grey hickup. False on real imagery
    (including IR/night frames, which have plenty of noise across channels).
    ``profile`` lets the caller relax the mid-grey total-std threshold for
    night/twilight scenes where legitimate IR frames have less channel
    variance than a daytime scene.

    Reolink date OSDs render in the top-right corner and add enough
    channel std to push an otherwise-uniform-grey frame above the
    grey_uniform floor. Std is computed on a cropped working region
    that excludes the top 12 % of rows AND the right 25 % of columns
    so OSD text noise can't hide a grey hickup. Mean brightness
    still uses the full frame because the OSD is too small to
    materially shift overall brightness."""
    img = _decode(img)
    if img is None or img.size == 0:
        return False, ""
    if img.ndim < 3 or img.shape[2] < 3:
        return False, ""
    h, w = img.shape[:2]
    cy = max(1, int(h * 0.12))
    cx = max(1, int(w * 0.75))
    # Fall back to the full frame on tiny inputs where the OSD-aware
    # crop would leave too little to measure.
    if (h - cy) > 8 and cx > 8:
        work = img[cy:, :cx]
    else:
        work = img
    std_b = float(work[:, :, 0].std())
    std_g = float(work[:, :, 1].std())
    std_r = float(work[:, :, 2].std())
    std_sum = std_b + std_g + std_r
    grey_channel_std_sum = (
        profile.grey_channel_std_sum if profile is not None else _GREY_CHANNEL_STD_SUM
    )
    grey_midband_total_std = (
        profile.grey_midband_total_std if profile is not None else _GREY_MIDBAND_TOTAL_STD
    )
    if std_sum < grey_channel_std_sum:
        return True, f"grey_uniform(std_sum={std_sum:.1f})"
    mean_brightness = float((img[:, :, 0].mean() + img[:, :, 1].mean() + img[:, :, 2].mean()) / 3.0)
    if (_GREY_MIDBAND_MIN <= mean_brightness <= _GREY_MIDBAND_MAX
            and std_sum < grey_midband_total_std):
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
            if bstd < _TILE_DEAD_BLURRED_STD_FLOOR or (_TILE_GREY_BAND_MIN <= tmean <= _TILE_GREY_BAND_MAX
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


# ── Flat-gray full-frame corruption ──────────────────────────────────────────
# Whole-frame mid-grey decoder corruption: H.265 outputs a uniform
# mid-grey buffer (mean ∈ [115, 145], std < 10). dead_area also
# catches this case in practice — every tile passes the dead-tile
# test on a uniform frame — but giving it its own reason head means
# the per-reason _rejected/ folder splits the two failure modes
# cleanly. The thresholds match the picker's _is_flat_gray_corruption_sample
# so a sample that the picker treats as corruption is also rejected
# by the validator.
def is_flat_gray_full_frame(img) -> tuple[bool, str]:
    """Whole frame is flat mid-grey decoder corruption — H.265
    output a uniform mid-grey buffer with no scene structure.
    Distinct from dead_area because there's no spatial information
    at all, not just thin texture."""
    img = _decode(img)
    if img is None or img.size == 0:
        return False, ""
    try:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
        m = float(gray.mean())
        s = float(gray.std())
    except Exception:
        return False, ""
    if (_FLAT_GRAY_BAND_MIN <= m <= _FLAT_GRAY_BAND_MAX
            and s < _FLAT_GRAY_STD_MAX):
        return True, f"flat_gray_full_frame(mean={m:.0f},std={s:.1f})"
    return False, ""


# ── Bottom-strip anomaly thresholds ──────────────────────────────────────────
# H.265 decode failures on Reolink streams produce a near-white-saturated
# horizontal band across the bottom 10–25 % of a dark frame, sometimes
# mixed with violet macroblock smears. None of the global gates
# (pink_artifact, patterned_magenta, colorbar, split_*_dead, grey_*) flag
# this — they look for whole-frame or half-frame anomalies, not localised
# bottom-strip corruption. Empirical thresholds verified on 7 sample
# frames from a real night capture: 4/4 corrupt rejected, 3/3 clean
# preserved. Top vs bottom luminance delta is +171…+220 in corrupt frames
# vs +18 in clean — clean separation that survives a generous threshold.
_BOTTOM_STRIP_TOP_FRAC = 0.70   # rows used for "top luminance"
_BOTTOM_STRIP_BOT_FRAC = 0.20   # rows used for "bottom luminance"
_BOTTOM_NEAR_WHITE_CHAN = 235   # all 3 channels ≥ this → "near white" pixel
_BOTTOM_NEAR_WHITE_FRAC = 0.15  # ≥ 15 % near-white pixels in bottom strip
_BOTTOM_TOP_DARK_LUMA = 60.0    # the top must be this dark for rule 1
_BOTTOM_TOP_DARK_RULE2 = 80.0   # less strict for rule 2
_BOTTOM_DELTA_FLOOR = 100.0     # rule 2 fires above this top→bottom delta


def is_bottom_strip_anomaly(img) -> tuple[bool, str]:
    """Detect localised bottom-strip corruption: near-white saturation
    band OR macroblock smear that's much brighter than the top of the
    frame. Returns (True, reason) when the bottom of a dark scene
    contains a corruption signature, (False, "") otherwise.

    Two separable rules:
      • bottom_strip_white  — top is dark AND ≥ 15 % of pixels in the
        bottom 20 % are near-white (all three channels ≥ 235).
      • bottom_strip_bright — top is dark AND bottom mean luminance
        exceeds top mean luminance by > 100. Catches macroblock
        smears that don't saturate to white but still glow against
        the dark scene.
    Both rules require a dark top so daytime scenes with naturally
    bright foreground (path / pavement / illuminated wall) don't
    falsely trip the detector.
    """
    img = _decode(img)
    if img is None or img.size == 0:
        return False, ""
    if img.ndim < 3 or img.shape[2] < 3:
        return False, ""
    h, w = img.shape[:2]
    if h < 20:
        return False, ""
    # Luma is computed off the BGR channels with the standard 601
    # weights. Cheaper than cvtColor(BGR2GRAY) because we only need
    # two regional means.
    b = img[:, :, 0].astype(np.float32)
    g = img[:, :, 1].astype(np.float32)
    r = img[:, :, 2].astype(np.float32)
    luma = 0.114 * b + 0.587 * g + 0.299 * r
    top_rows = max(1, int(h * _BOTTOM_STRIP_TOP_FRAC))
    bot_rows = max(1, int(h * _BOTTOM_STRIP_BOT_FRAC))
    top_lum = float(luma[:top_rows, :].mean())
    bot_lum = float(luma[h - bot_rows:, :].mean())
    bot_band = img[h - bot_rows:, :, :]
    near_white = (
        (bot_band[:, :, 0] >= _BOTTOM_NEAR_WHITE_CHAN)
        & (bot_band[:, :, 1] >= _BOTTOM_NEAR_WHITE_CHAN)
        & (bot_band[:, :, 2] >= _BOTTOM_NEAR_WHITE_CHAN)
    )
    bot_white_frac = float(near_white.sum()) / float(near_white.size or 1)
    # Rule 1 — white-saturation band on a dark scene.
    if top_lum < _BOTTOM_TOP_DARK_LUMA and bot_white_frac > _BOTTOM_NEAR_WHITE_FRAC:
        return True, (
            f"bottom_strip_white(top_lum={top_lum:.1f},"
            f"bot_white_pct={bot_white_frac * 100:.1f}%)"
        )
    # Rule 2 — macroblock smear (bright bottom on a dark scene).
    delta = bot_lum - top_lum
    if delta > _BOTTOM_DELTA_FLOOR and top_lum < _BOTTOM_TOP_DARK_RULE2:
        return True, (
            f"bottom_strip_bright(delta={delta:.0f},top_lum={top_lum:.1f})"
        )
    return False, ""


def is_valid_frame(img, profile: FrameValidatorProfile = DAY_PROFILE) -> tuple[bool, str]:
    """Bundled validity check used by every timelapse capture and build path.

    Returns (True, "") when the frame is suitable for inclusion in a
    timelapse, otherwise (False, "<reason>"). Conservative: night/dark/IR
    frames pass, only truly broken inputs (null, too small, blown-out
    brightness, pink corruption, flat fill, mid-grey hickup, colorbar) fail.

    ``profile`` lets the capture loop swap thresholds for IR-night /
    twilight scenes — the default keeps the historic daytime tunings.
    Per-call (not module-level) so a single process can run different
    profiles for different cameras at the same time."""
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
    if brightness < profile.brightness_floor:
        return False, f"too_dark(brightness={brightness:.1f})"
    if brightness > profile.brightness_ceil:
        return False, f"too_bright(brightness={brightness:.1f})"

    # Full-frame pink/magenta H.265 artifact
    if r > profile.pink_full_r_min and r > g * profile.pink_full_ratio and r > b * profile.pink_full_ratio:
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
        if sr > profile.pink_quad_r_min and sr > sg * profile.pink_quad_ratio and sr > sb * profile.pink_quad_ratio:
            return False, f"partial_pink_q{qi}(r={sr:.0f},g={sg:.0f},b={sb:.0f})"

    # Patterned-magenta detector — counts the *fraction* of pixels in
    # the magenta wedge (high R + high B, low G) regardless of whether
    # those pixels form a smooth fill or a corruption pattern. Catches
    # H.265 partial-block-loss frames where the broken region carries
    # real spatial texture (variance survives) but the colour stays
    # locked in magenta. Downscaled first so the cost is bounded.
    if w > _PATTERN_MAGENTA_DOWNSCALE:
        scale = _PATTERN_MAGENTA_DOWNSCALE / float(w)
        small = cv2.resize(img,
                           (_PATTERN_MAGENTA_DOWNSCALE, max(1, int(h * scale))),
                           interpolation=cv2.INTER_AREA)
    else:
        small = img
    sb_ch = small[:, :, 0].astype("int16")
    sg_ch = small[:, :, 1].astype("int16")
    sr_ch = small[:, :, 2].astype("int16")
    # Per-pixel magenta mask. min(R,B) must beat G by the dominance
    # margin so dawn/dusk pinks (which lift G almost as high as R/B)
    # don't trigger. Numpy-vectorised — single pass.
    rb_min = np.minimum(sr_ch, sb_ch)
    mask = ((sr_ch >= _PATTERN_MAGENTA_R_MIN)
            & (sb_ch >= _PATTERN_MAGENTA_B_MIN)
            & (sg_ch <= _PATTERN_MAGENTA_GREEN_MAX)
            & ((rb_min - sg_ch) >= _PATTERN_MAGENTA_DOMINANCE))
    total = mask.size
    if total > 0:
        mfrac = float(mask.sum()) / float(total)
        if mfrac >= profile.pattern_magenta_area_frac:
            return False, f"patterned_magenta(area={mfrac:.0%})"

    # Whole-frame flat-grey decoder corruption — H.265 dumped a
    # uniform mid-grey buffer with no scene structure. Catch this
    # FIRST so it gets its own reason head ("flat_gray_full_frame")
    # in the per-reason _rejected/ folder instead of being lumped
    # in with dead_area. dead_area would otherwise also fire on
    # this frame because every tile is uniform.
    fg, fg_reason = is_flat_gray_full_frame(img)
    if fg:
        return False, fg_reason

    # Localised bottom-strip corruption — H.265 NAL/slice loss produces
    # a near-white saturation band OR a bright macroblock smear glued
    # to the bottom of an otherwise dark scene. Has to run BEFORE the
    # scene-level gates (no_detail / dead_area) — those would otherwise
    # let a corrupt frame through on a low-texture night, where it
    # could become the "last_valid" backfill reference.
    bs, bs_reason = is_bottom_strip_anomaly(img)
    if bs:
        return False, bs_reason

    # Truly flat frame (any solid color)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray_std = float(gray.std())
    if gray_std < profile.flat_gray_std_floor:
        return False, f"no_detail(std={gray_std:.2f})"

    # Mid-grey hickup specifically (catches encoder/IR-cut artefacts that
    # have just enough JPEG noise to clear gray_std but no real imagery).
    grey, grey_reason = is_grey_frame(img, profile=profile)
    if grey:
        return False, grey_reason

    # Tile-based dead-area scoring — catches partially-corrupt frames where
    # only a thin strip carries real imagery (the rest is mid-grey or
    # macroblock noise).
    dead_frac, dead_n, total_n = dead_area_score(img)
    if total_n > 0 and dead_frac > profile.tile_dead_fraction:
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
    #
    # Chroma std uses a TRIMMED metric (drop the top 10 % of pixel-level
    # |B-G| and |B-R| differences before std) so a mostly-grey frame
    # with a small chroma island (e.g. the green LED of a clock or a
    # red OSD pixel) doesn't escape the gate via the bright outliers.
    # np.partition is O(n) — no full sort needed.
    luma = (b + g + r) / 3.0
    diff_bg = np.abs(img[:, :, 0].astype(np.int16) - img[:, :, 1]).flatten()
    diff_br = np.abs(img[:, :, 0].astype(np.int16) - img[:, :, 2]).flatten()
    def _trimmed_std(arr, drop_frac=0.10):
        if arr.size == 0:
            return 0.0
        cut = max(1, int(arr.size * (1.0 - drop_frac)))
        if cut >= arr.size:
            return float(arr.std())
        # partition keeps the smallest `cut` elements in the first slots
        # — order within the kept slice is undefined but std doesn't care.
        kept = np.partition(arr, cut - 1)[:cut]
        return float(kept.std())
    chroma_std = (_trimmed_std(diff_bg) + _trimmed_std(diff_br)) / 2.0
    if (_GREY_TONED_LUMA_MIN <= luma <= _GREY_TONED_LUMA_MAX
            and chroma_std < profile.grey_toned_chroma_std_max):
        return False, (f"grey_toned(luma={luma:.0f},chroma_std={chroma_std:.1f})")

    # Test-pattern colorbar
    bar, bar_reason = is_colorbar(img)
    if bar:
        return False, bar_reason

    return True, ""


# ── Retry classification ─────────────────────────────────────────────────────
# Two reason buckets drive the retry strategy:
#   transient — encoder hickups, partial corruption, codec-state bugs.
#               Retrying ~0.4 s later genuinely helps because the next
#               frame is a fresh decode that won't carry the hickup.
#   scene     — the actual scene is empty / dark / blown out. Retrying
#               doesn't make texture appear; the camera is fine, the
#               scene is just like that. Cap retries at 2 for these so
#               an empty terrace at midnight doesn't burn the full
#               6-attempt budget for every slot.
_TRANSIENT_REASONS: frozenset[str] = frozenset({
    "grey_uniform", "grey_midband", "colorbar",
    "pink_artifact", "patterned_magenta",
    "split_left_dead", "split_right_dead",
    "split_top_dead", "split_bottom_dead",
    "grey_toned",
    # H.265 bottom-strip corruption — encoder/decoder hickup, the
    # next frame is usually clean, so retrying within the wall-clock
    # budget genuinely helps.
    "bottom_strip_white", "bottom_strip_bright",
    # Whole-frame flat-grey corruption — same encoder/decoder
    # hickup family, retry within budget can recover.
    "flat_gray_full_frame",
})
_SCENE_REASONS: frozenset[str] = frozenset({
    "dead_area", "no_detail", "too_dark", "too_bright",
})


def _classify_reason(reason: str) -> str:
    """Return ``"transient"`` / ``"scene"`` / ``"other"`` for a
    rejection reason. Strips diagnostic detail before lookup. ``other``
    covers grab_exception / grab_returned_none / null/empty / too_small
    — these get the full retry budget so a flaky single-shot grab can
    still recover."""
    if not reason:
        return "other"
    # Inline the head-extraction (also done by _normalise_rejection_reason
    # further down) so this helper can be called before that one is
    # defined in the module — both are module-level and resolved
    # lazily at call time, but inlining keeps the read-order intuitive.
    head = reason.split("|", 1)[0].split("(", 1)[0].strip()
    if head in _SCENE_REASONS:
        return "scene"
    if head in _TRANSIENT_REASONS:
        return "transient"
    return "other"


# ── Retry wrapper ────────────────────────────────────────────────────────────
def grab_valid_frame(grab_fn, attempts: int = 6, sleep_s: float = 0.4,
                     max_total_seconds: float = 5.0,
                     on_reject=None,
                     profile: FrameValidatorProfile = DAY_PROFILE,
                     ) -> tuple[object, int, str]:
    """Call ``grab_fn`` up to ``attempts`` times OR
    ``max_total_seconds`` wall-clock, whichever comes first.

    Returns (frame_or_None, attempt_index_used_or_final_attempts,
    last_reason). A first-attempt success returns
    attempt_index_used=0; the caller can use that to bump a "retry
    recoveries" counter when index > 0.

    Defaults bumped from 3 attempts × 0.7 s (2.1 s typical, no hard
    cap) to 6 attempts × 0.4 s (2.4 s typical) plus a 5 s wall-clock
    ceiling. The extra attempts catch cluster-E cases where the
    corrupt region wanders frame-to-frame; the wall-clock ceiling
    guarantees a single bad camera can never stall the entire
    capture loop for a full interval. If the budget fires before
    `attempts` is exhausted, last_reason gets a
    "budget_exceeded(<seconds>s)" suffix appended so the caller's
    diagnostics see why we gave up.

    grab_fn() may return either a decoded BGR ndarray or JPEG bytes
    — both are handled transparently by ``is_valid_frame``.

    The function intentionally stays stats-agnostic — callers fold
    the returned ``last_reason`` into a CaptureStats via
    ``stats.record_invalid(reason)`` so per-reason breakdowns
    bookkeep through a single path regardless of whether the caller
    uses this retry helper or its own loop.

    ``on_reject`` (optional) is fired once per rejected attempt with
    ``(frame, reason, attempt_idx)`` — the raw value returned by
    ``grab_fn`` (ndarray or JPEG bytes), the validator's reason
    string, and the zero-based attempt index. The callback is
    invoked for every retry that fails, including the final one.
    Default ``None`` keeps the current behaviour bit-identical for
    callers that don't opt in. Exceptions raised inside the
    callback are caught and logged at DEBUG so a flaky disk save
    can never abort the capture loop — the diagnostic save path is
    best-effort by design."""
    t0 = time.monotonic()
    last_reason = ""
    attempt = 0
    n = max(1, attempts)
    # Per-call effective cap. Starts at the caller's `attempts` value;
    # gets clamped down to 2 the moment a scene-level reject is observed
    # because retrying scene rejects (empty terrace, too dark, no detail)
    # never makes texture appear. Transient rejects keep the full budget.
    effective_cap = n
    while attempt < effective_cap:
        if time.monotonic() - t0 >= max_total_seconds:
            last_reason = (
                (last_reason + "|" if last_reason else "")
                + f"budget_exceeded({max_total_seconds}s)"
            )
            break
        try:
            frame = grab_fn()
        except Exception as e:
            last_reason = f"grab_exception:{e}"
            frame = None
        if frame is not None:
            ok, reason = is_valid_frame(frame, profile=profile)
            if ok:
                return frame, attempt, ""
            last_reason = reason or last_reason or "invalid"
        else:
            last_reason = last_reason or "grab_returned_none"
        # Best-effort diagnostic save — fire AFTER last_reason has been
        # finalised for this attempt so the caller sees the same string
        # we'd return at the end of the loop. ``frame`` may be None
        # (grab_fn returned None or raised) — the callback decides
        # whether None is worth persisting.
        if on_reject is not None:
            try:
                on_reject(frame, last_reason, attempt)
            except Exception as cb_exc:
                log.debug("[frame_helpers] on_reject callback raised: %s", cb_exc)
        # Scene-level rejects get capped at total=2 — one more attempt
        # past the first reject in case the camera was mid-AGC, then
        # we give up. The wall-clock cap still applies; this just
        # prevents a per-slot 5 s burn on empty IR night scenes.
        if _classify_reason(last_reason) == "scene":
            effective_cap = min(effective_cap, 2)
        attempt += 1
        if attempt < effective_cap:
            time.sleep(sleep_s)
    return None, attempt, last_reason


# ── Per-session capture stats ────────────────────────────────────────────────
def _normalise_rejection_reason(reason: str | None) -> str:
    """Strip the diagnostic detail from a is_valid_frame / grab_valid_frame
    reason string so a per-reason tally stays readable. Reasons come back
    as "grey_uniform(std_sum=4.2)" or "split_left_dead(...)|budget_exceeded(5.0s)";
    we want bare keys like "grey_uniform" / "split_left_dead" for the
    breakdown.
    """
    if not reason:
        return "unknown"
    head = reason.split("|", 1)[0]
    head = head.split("(", 1)[0]
    return head.strip() or "unknown"


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
    # Per-reason rejection tally. Keys are the bare reason heads
    # (grey_uniform / dead_area / split_left_dead / grey_toned /
    # no_detail / pink_artifact / colorbar / too_dark / too_bright /
    # budget_exceeded / grab_exception / grab_returned_none) — no
    # parenthesised detail. Lets per-timelapse logs answer "which
    # cluster dominated this window?" without re-parsing the raw
    # log lines.
    rejected_by_reason: dict = field(default_factory=dict)
    # Same shape, but sub-tally for slots that gave up early because the
    # reject was scene-level (dead_area / no_detail / too_dark /
    # too_bright). These don't represent camera failure — the scene
    # genuinely had nothing worth keeping. Surface separately so the
    # operator can read "23 dead_area" vs "23 dead_area (all scene-skip)"
    # at a glance.
    scene_skips_by_reason: dict = field(default_factory=dict)
    # First observed full reason string per reason head — keeps a
    # representative diagnostic blob (e.g. "dead_area(40/40=100%)") so
    # the UI can show a concrete number under the bare key. Populated
    # on the first hit per head; subsequent hits are ignored.
    rejected_by_reason_examples: dict = field(default_factory=dict)
    # Number of times the slot loop discarded its ``last_valid_jpg``
    # backfill cache because a strict re-validation flagged it after
    # > 3 consecutive uses — a self-defence guard against a corrupt
    # frame that slipped through the validator becoming the reference
    # for many adjacent slots. Surfaced on the live test panel so
    # the operator sees "we caught one" rather than wondering why a
    # block of slots ended up empty.
    backfill_cache_drops: int = 0
    # Optional capture-context metadata. Populated by the caller right
    # before flush() lands to ``_stats.json`` and surfaces in the UI.
    # All optional so the existing call sites that don't set them
    # produce the same _stats.json shape as before.
    validator_profile: str | None = None
    baseline_brightness: float | None = None
    phase_drift_min: int | None = None
    phase_drift_warning: str | None = None

    def record_capture(self, attempt_used: int = 0):
        """attempt_used==0 means first try succeeded; >0 means a retry saved it."""
        self.captured_frames += 1
        if attempt_used > 0:
            self.retry_recoveries += 1

    def record_invalid(self, reason: str | None = None):
        """Record a frame the capture loop gave up on. Optionally pass
        the last is_valid_frame reason so it aggregates into the
        per-reason breakdown. Scene-level rejects (dead_area /
        no_detail / too_dark / too_bright) also bump the
        ``scene_skips_by_reason`` mirror so the UI can distinguish
        "validator threw it away" from "scene was genuinely empty"."""
        self.invalid_frames += 1
        if reason:
            key = _normalise_rejection_reason(reason)
            self.rejected_by_reason[key] = self.rejected_by_reason.get(key, 0) + 1
            if _classify_reason(reason) == "scene":
                self.scene_skips_by_reason[key] = (
                    self.scene_skips_by_reason.get(key, 0) + 1
                )
            # Keep the FIRST full reason string per head — the value
            # carries the diagnostic detail (e.g. "(40/40=100%)") that
            # the UI shows alongside the bare key.
            if key not in self.rejected_by_reason_examples:
                self.rejected_by_reason_examples[key] = reason

    # ── Derived breakdown ───────────────────────────────────────────────
    # The user reads the panel and asks "how many slots in the MP4 are
    # actually fresh content?" — the raw counters answer half of that.
    # These properties decompose ``invalid_frames`` into:
    #   • backfilled_slots — invalid slots filled with a copy of the
    #     last valid frame (encoder-friendly continuity, but not
    #     "new" imagery)
    #   • skipped_slots    — scene-level rejects we deliberately gave
    #     up on early (empty terrace at midnight) — these stay empty
    #     in the MP4 sequence
    # ``total_written`` is fresh + backfilled. The MP4's slot count is
    # always at most ``total_written``; ffmpeg padding fills any gaps.
    @property
    def fresh_captures(self) -> int:
        return int(self.captured_frames)

    @property
    def scene_skips_total(self) -> int:
        return int(sum(self.scene_skips_by_reason.values()))

    @property
    def backfilled_slots(self) -> int:
        # Clamp at zero — defensive against a counter race we don't
        # currently have but might invent if the loop is rewritten.
        return max(0, int(self.invalid_frames) - self.scene_skips_total)

    @property
    def skipped_slots(self) -> int:
        return self.scene_skips_total

    @property
    def total_written(self) -> int:
        return self.fresh_captures + self.backfilled_slots

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
                "rejected_by_reason": dict(self.rejected_by_reason),
                "scene_skips_by_reason": dict(self.scene_skips_by_reason),
                "rejected_by_reason_examples": dict(self.rejected_by_reason_examples),
                "backfill_cache_drops": int(self.backfill_cache_drops),
                # Derived breakdown — denormalised here so consumers
                # don't have to recompute. fresh+backfilled+skipped is
                # the "how many slots in the MP4 are real content"
                # answer the user asks every time they read the panel.
                "fresh_captures":   self.fresh_captures,
                "backfilled_slots": self.backfilled_slots,
                "skipped_slots":    self.skipped_slots,
                "total_written":    self.total_written,
                "validator_profile": self.validator_profile,
                "baseline_brightness": self.baseline_brightness,
                "phase_drift_min": self.phase_drift_min,
                "phase_drift_warning": self.phase_drift_warning,
            }
            path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        except Exception as e:
            log.warning("[timelapse] could not write _stats.json in %s: %s", self.out_dir, e)
        # Per-flush log line so docker logs surface which cluster is
        # dominating an in-progress capture without waiting for the
        # window to close. Compact format keeps it grep-friendly.
        try:
            log.info(
                "[capture-stats] %s · captured=%d retries=%d invalid=%d rejected=%s scene_skips=%s",
                Path(self.out_dir).name,
                self.captured_frames, self.retry_recoveries,
                self.invalid_frames, dict(self.rejected_by_reason),
                dict(self.scene_skips_by_reason),
            )
        except Exception:
            pass


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
