"""Frame validation helpers shared by the timelapse capture loops.

Single source of truth for "is this frame worth keeping?". The full pipeline
(``is_valid_frame``) bundles every individual heuristic so callers don't have
to chain them. The retry wrapper ``grab_valid_frame`` lets a caller turn a
single-shot frame fetch into a 3-attempt retry without each capture loop
inventing its own backoff loop.

All thresholds are module constants so they're easy to retune later without
hunting through call sites. The functions are stateless and side-effect free
apart from the retry helper's ``time.sleep``.

This package is the post-refactor home of the original monolithic
``frame_helpers.py``. Every public name remains importable from
``app.frame_helpers`` exactly as before — the split is purely
mechanical, no behavior change."""
from __future__ import annotations

from ._anomaly_bands import (
    is_bottom_strip_anomaly,
    is_horizontal_anomaly_band,
)
from ._colorbar import is_colorbar
from ._dedup import (
    hamming_distance,
    is_near_duplicate,
    perceptual_hash,
)
from ._grey import (
    dead_area_score,
    is_flat_gray_full_frame,
    is_grey_frame,
)
from ._macroblock import is_local_macroblock_anomaly
from ._profile import (
    DAY_PROFILE,
    NIGHT_PROFILE,
    TWILIGHT_PROFILE,
    FrameValidatorProfile,
    pick_profile_from_baseline,
)
from ._split import is_split_frame
from ._stats import (
    CaptureStats,
    read_capture_stats,
)
from ._validator import (
    grab_valid_frame,
    is_valid_frame,
)

__all__ = [
    "CaptureStats",
    "DAY_PROFILE",
    "FrameValidatorProfile",
    "NIGHT_PROFILE",
    "TWILIGHT_PROFILE",
    "dead_area_score",
    "grab_valid_frame",
    "hamming_distance",
    "is_bottom_strip_anomaly",
    "is_colorbar",
    "is_flat_gray_full_frame",
    "is_grey_frame",
    "is_horizontal_anomaly_band",
    "is_local_macroblock_anomaly",
    "is_near_duplicate",
    "is_split_frame",
    "is_valid_frame",
    "perceptual_hash",
    "pick_profile_from_baseline",
    "read_capture_stats",
]
