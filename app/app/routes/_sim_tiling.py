"""SIM-only tiling / ROI detection helpers for the Simulieren panel.

Used EXCLUSIVELY by routes/coral_test_detection.py to let the operator
compare full-frame vs SAHI-style tiling / motion-ROI in the live-detect
simulator. This is diagnostic only — the production alarm/recording
pipeline (camera_runtime/*) is governed separately and is NOT affected.

The B-experiment (storage/_diag/substream_test_*.md) showed full-frame
inference is blind to small/distant subjects (dog 0.00) while a 2×2 / 3×3
tiling pass recovers them (dog 0.76). This module makes that recovery
visible + adjustable inside the sim.
"""

from __future__ import annotations

import cv2
import numpy as np

from ..bbox_utils import iou

VALID_MODES = ("off", "roi", "2x2", "3x3")


def _tile_regions(w: int, h: int, gx: int, gy: int, overlap: float = 0.15):
    """Split a W×H frame into gx·gy overlapping tile rectangles."""
    tw, th = w / gx, h / gy
    ox, oy = int(tw * overlap), int(th * overlap)
    regions = []
    for iy in range(gy):
        for ix in range(gx):
            x1 = max(0, int(ix * tw) - ox)
            y1 = max(0, int(iy * th) - oy)
            x2 = min(w, int((ix + 1) * tw) + ox)
            y2 = min(h, int((iy + 1) * th) + oy)
            regions.append((x1, y1, x2, y2))
    return regions


def _detect_region(detector, frame, region, threshold):
    """Run the detector on one cropped region; map boxes back to frame coords.
    detect_frame_raw upscales the crop to the model input internally, so a
    small subject occupies more model-input pixels than in the full frame."""
    x1, y1, x2, y2 = region
    crop = frame[y1:y2, x1:x2]
    if crop.size == 0:
        return []
    out = []
    for d in detector.detect_frame_raw(crop, threshold=threshold):
        bx1, by1, bx2, by2 = d.bbox
        d.bbox = (bx1 + x1, by1 + y1, bx2 + x1, by2 + y1)
        out.append(d)
    return out


def _nms(dets, iou_thresh: float = 0.45):
    """Greedy per-label NMS — keeps the highest-scoring box of each cluster
    so a subject straddling a tile seam isn't double-counted."""
    kept = []
    for d in sorted(dets, key=lambda x: x.score, reverse=True):
        if any(d.label == k.label and iou(d.bbox, k.bbox) >= iou_thresh for k in kept):
            continue
        kept.append(d)
    return kept


def motion_bbox(prev_gray, gray, frame_area: float, min_area_frac: float = 0.0008):
    """SIM-local frame-diff motion bbox (mirrors camera_runtime/_motion.py's
    absdiff→threshold→dilate→contour recipe, at a low area floor so small
    subjects survive). Returns (x, y, w, h) or None. Does NOT touch the
    production motion gate — it operates on the sim's own cached frames."""
    if prev_gray is None or gray is None or prev_gray.shape != gray.shape:
        return None
    diff = cv2.absdiff(prev_gray, gray)
    _, thresh = cv2.threshold(diff, 28, 255, cv2.THRESH_BINARY)
    thresh = cv2.dilate(thresh, None, iterations=2)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    floor = max(1.0, frame_area * min_area_frac)
    big = [c for c in contours if cv2.contourArea(c) >= floor]
    if not big:
        return None
    return tuple(int(v) for v in cv2.boundingRect(np.concatenate(big)))


def prep_gray(frame):
    """Grayscale + blur, matching the motion gate's preprocessing."""
    return cv2.GaussianBlur(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (15, 15), 0)


def tiled_detect(detector, frame, mode: str, threshold: float = 0.20, motion_box=None):
    """Hybrid full-frame + tiling/ROI detection for the sim.

    Returns (merged_detections, diag) where diag carries the SAHI counters.
    mode: 'off' (full only) | '2x2' | '3x3' | 'roi' (motion bbox crop).
    A full-frame pass always runs and is NMS-merged with the tile/ROI hits.
    """
    h, w = frame.shape[:2]
    full = detector.detect_frame_raw(frame, threshold=threshold)
    if mode not in ("2x2", "3x3", "roi"):
        return list(full), {
            "mode": "off",
            "tiles": 0,
            "raw": len(full),
            "merged": len(full),
            "tile_hits": [],
        }

    if mode == "2x2":
        regions = _tile_regions(w, h, 2, 2)
    elif mode == "3x3":
        regions = _tile_regions(w, h, 3, 3)
    else:  # roi
        regions = []
        if motion_box:
            mx, my, mw, mh = motion_box
            pad = int(0.25 * max(mw, mh)) + 8
            rx1, ry1 = max(0, mx - pad), max(0, my - pad)
            rx2, ry2 = min(w, mx + mw + pad), min(h, my + mh + pad)
            if rx2 > rx1 and ry2 > ry1:
                regions = [(rx1, ry1, rx2, ry2)]

    tile_hits = []
    tiled = []
    for r in regions:
        rd = _detect_region(detector, frame, r, threshold)
        tile_hits.append(len(rd))
        tiled.extend(rd)
    raw_all = list(full) + tiled
    merged = _nms(raw_all)
    diag = {
        "mode": mode,
        "tiles": len(regions),
        "raw": len(raw_all),
        "merged": len(merged),
        "tile_hits": tile_hits,
    }
    return merged, diag


def sahi_trace_line(diag: dict) -> str | None:
    """Render the M4 SAHI diag line for the decision-trace block, or None
    when tiling is off (nothing extra to report)."""
    mode = diag.get("mode", "off")
    if mode == "off":
        return None
    label = {"2x2": "2×2", "3x3": "3×3", "roi": "ROI"}.get(mode, mode)
    return (
        f"[sahi] {label} +full · roh {diag.get('raw', 0)} → "
        f"nach NMS {diag.get('merged', 0)} · Kachel-Treffer {diag.get('tile_hits', [])}"
    )
