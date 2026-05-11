"""Frame-decoding helper shared by every heuristic module.

Carved out of the original ``frame_helpers.py`` during the modular
refactor. Every individual heuristic accepts either a raw JPEG byte
blob or an already-decoded BGR ndarray; this helper hides the
distinction so the call sites stay focused on the heuristic logic."""
from __future__ import annotations

import cv2
import numpy as np

# Minimum decoded dimensions before we even bother heuristic-ing.
_MIN_FRAME_W = 32
_MIN_FRAME_H = 24


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
