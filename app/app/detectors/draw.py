"""Bbox overlay renderer used by the Coral test panel and the lightbox
preview path. Carved out of the original detectors.py during R02.1."""

from __future__ import annotations

import cv2
import numpy as np

from ._types import Detection


def draw_detections(frame: np.ndarray, detections: list[Detection]) -> np.ndarray:
    if frame is None:
        return frame
    out = frame.copy()
    colors = {
        "bird": (84, 214, 98),
        "cat": (160, 110, 255),
        "person": (110, 110, 255),
        # BGR — same dark brown #7c2d12 (RGB 124,45,18) used everywhere else.
        "dog": (18, 45, 124),
    }
    for det in detections:
        x1, y1, x2, y2 = det.bbox
        color = colors.get(det.label, (255, 180, 0))
        cv2.rectangle(out, (x1, y1), (x2, y2), color, 2)
        parts = [det.label]
        if det.species:
            parts.append(det.species)
        if det.identity:
            parts.append(det.identity)
        parts.append(f"{det.score:.2f}")
        text = " | ".join(parts)
        cv2.putText(
            out, text, (x1, max(24, y1 - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.58, color, 2, cv2.LINE_AA
        )
    return out
