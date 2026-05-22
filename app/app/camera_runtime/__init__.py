"""camera_runtime package — CameraRuntime decomposed into mixins.

The public API stays unchanged. External callers import the same names
as before:
    from app.camera_runtime import CameraRuntime, WeatherPrebuffer
plus the module-level constants and helpers a few callers reach into:
    from app.camera_runtime import _PROFILES, _PROFILE_PERIOD_DEFAULTS
    from app.camera_runtime import _SPECIES_TO_ACH_ID, _bbox_iou
"""

from ._consts import (
    _FFMPEG_AVAILABLE,
    _PROFILE_PERIOD_DEFAULTS,
    _PROFILES,
    _SPECIES_TO_ACH_ID,
    _WILDLIFE_BBOX_DONORS,
    _bbox_iou,
    _refine_wildlife_bbox,
    _suppress_overlap,
)
from .runtime import CameraRuntime, WeatherPrebuffer

__all__ = [
    "CameraRuntime",
    "WeatherPrebuffer",
    "_FFMPEG_AVAILABLE",
    "_PROFILES",
    "_PROFILE_PERIOD_DEFAULTS",
    "_SPECIES_TO_ACH_ID",
    "_WILDLIFE_BBOX_DONORS",
    "_bbox_iou",
    "_refine_wildlife_bbox",
    "_suppress_overlap",
]
