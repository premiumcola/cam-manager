"""Validator profiles + the global threshold tunables every heuristic
reads. Carved out of the original ``frame_helpers.py`` during the
modular refactor; tunable constants live HERE so siblings can import
the names they care about without dragging the whole module."""
from __future__ import annotations

import logging
from dataclasses import dataclass

import cv2
import numpy as np

from ._decode import _decode

log = logging.getLogger(__name__)


# ── Tunables ─────────────────────────────────────────────────────────────────
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
