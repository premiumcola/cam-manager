"""Bounding-box math primitives — single source of truth.

Two near-identical IoU implementations had been growing in parallel
(``tracking_worker._iou`` and ``camera_runtime._consts._bbox_iou``);
this module is where any future call site should land instead of
introducing a third copy.
"""
from __future__ import annotations


def iou(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> float:
    """Intersection-over-union for axis-aligned bboxes ``(x1, y1, x2, y2)``.

    Returns 0.0 when the boxes don't overlap or either has zero area
    (so callers can compare against a fixed threshold without a
    separate "empty" check)."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    a_area = max(0, ax2 - ax1) * max(0, ay2 - ay1)
    b_area = max(0, bx2 - bx1) * max(0, by2 - by1)
    union = a_area + b_area - inter
    return inter / union if union > 0 else 0.0


def bbox_centroid_dist(a: dict, b: dict) -> float:
    """Centre-to-centre distance in pixels between two bbox dicts.

    Accepts dicts shaped like the ``tracks.json`` sample bbox:
    ``{"x1", "y1", "x2", "y2"}``. Used by the tracking worker to
    suppress sparse samples whose centroid hasn't moved meaningfully
    between successive frames — tiny shimmer would inflate the JSON
    without adding visual information."""
    acx = (a["x1"] + a["x2"]) / 2.0
    acy = (a["y1"] + a["y2"]) / 2.0
    bcx = (b["x1"] + b["x2"]) / 2.0
    bcy = (b["y1"] + b["y2"]) / 2.0
    return ((acx - bcx) ** 2 + (acy - bcy) ** 2) ** 0.5
