"""Module-level constants, loggers, and helper functions for camera_runtime.

Lives in its own file so the mixin modules can import from it without
creating a circular dependency with runtime.py (which imports the mixins).
"""
from __future__ import annotations

import logging
import shutil as _shutil
# Does this container have an ffmpeg binary? If so, motion recording uses the
# fast stream-copy path (direct RTSP → mp4, no CPU re-encode). Otherwise we
# fall back to the OpenCV frame-buffer approach, which loses timestamps.
_FFMPEG_AVAILABLE = _shutil.which('ffmpeg') is not None
if not _FFMPEG_AVAILABLE:
    logging.getLogger(__name__).warning(
        "ffmpeg binary not found — motion recording falls back to OpenCV frame buffer "
        "(playback speed may be incorrect)"
    )

# Species name → achievement ID mapping (German species names → normalised IDs)
# Birds: LBV Stunde der Gartenvögel 2025 Bayern — Top 20.
_SPECIES_TO_ACH_ID = {
    # Vögel (Top 20 Bayern)
    "haussperling": "haussperling",
    "amsel": "amsel",
    "kohlmeise": "kohlmeise",
    "star": "star",
    "feldsperling": "feldsperling",
    "blaumeise": "blaumeise",
    "ringeltaube": "ringeltaube",
    "mauersegler": "mauersegler",
    "elster": "elster",
    "mehlschwalbe": "mehlschwalbe",
    "buchfink": "buchfink",
    "rotkehlchen": "rotkehlchen",
    "grünfink": "gruenfink",
    "gruenfink": "gruenfink",
    "rabenkrähe": "rabenkraehe",
    "rabenkraehe": "rabenkraehe",
    "hausrotschwanz": "hausrotschwanz",
    "mönchsgrasmücke": "moenchsgrasmucke",
    "moenchsgrasmucke": "moenchsgrasmucke",
    "stieglitz": "stieglitz",
    "buntspecht": "buntspecht",
    "kleiber": "kleiber",
    "eichelhäher": "eichelhaher",
    "eichelhaher": "eichelhaher",
    # Säugetiere
    "eichhörnchen": "eichhoernchen",
    "eichhoernchen": "eichhoernchen",
    "igel": "igel",
    "feldhase": "feldhase",
    "reh": "reh",
    "fuchs": "fuchs",
}

# Logger names are pinned to the legacy module path so log filters and
# external grepping still match (the package split moved this code into
# camera_runtime/_consts but the logging surface stays "app.camera_runtime").
log = logging.getLogger("app.camera_runtime")
log_tl = logging.getLogger("app.camera_runtime.timelapse")   # timelapse-specific logs
log_cam = logging.getLogger("app.camera_runtime.camera")     # connection/stream logs

_PROFILES = ("daily", "weekly", "monthly", "custom")
_PROFILE_PERIOD_DEFAULTS = {"daily": 86400, "weekly": 604800, "monthly": 2592000, "custom": 600}

# COCO classes whose geometry usually localises a small ground mammal even
# when the label is wrong (squirrels read as "cat" head-on, "bear" furry,
# "teddy bear" sitting upright, etc.). When wildlife confirms squirrel /
# fox / hedgehog we re-run COCO at a low threshold and steal the bbox
# of any of these — purely as a localisation hint, ignoring the label.
_WILDLIFE_BBOX_DONORS = ("cat", "dog", "bear", "sheep", "cow", "teddy bear")


from ..bbox_utils import iou
# Backwards-compat alias — many camera_runtime siblings still import
# `_bbox_iou` directly from this module. Keep the name available so
# the dedup is a no-op at every consumer.
_bbox_iou = iou


def _refine_wildlife_bbox(detector, frame, motion_bbox, frame_size):
    """Best-guess bbox for a wildlife hit.

    Re-runs COCO at threshold 0.25 and returns the bbox of any donor-class
    detection (the first one — they're score-sorted). Falls back to
    `motion_bbox` (which is `(x, y, w, h)`), then the full frame.
    """
    w0, h0 = frame_size
    try:
        low = detector.detect_frame(frame, min_score=0.25) or []
    except Exception:
        low = []
    for d in low:
        if d.label in _WILDLIFE_BBOX_DONORS:
            return d.bbox
    if motion_bbox is not None:
        mx, my, mw, mh = motion_bbox
        return (int(mx), int(my), int(mx + mw), int(my + mh))
    return (0, 0, int(w0), int(h0))


def _suppress_overlap(dets, ref_bbox, drop_labels, iou_min: float = 0.3):
    """Drop detections whose label is in `drop_labels` AND whose bbox
    overlaps `ref_bbox` (IoU >= iou_min). Used to silence COCO's
    cat/teddy-bear false positives once wildlife confirms a squirrel."""
    if not dets:
        return dets
    out = []
    for d in dets:
        if d.label in drop_labels and iou(d.bbox, ref_bbox) >= iou_min:
            continue
        out.append(d)
    return out

