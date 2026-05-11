"""Colorbar / SMPTE test-pattern detector. Carved out of the original
``frame_helpers.py`` during the modular refactor; behaviour
unchanged."""
from __future__ import annotations

import cv2
import numpy as np

from ._decode import _decode
from ._profile import (
    _COLORBAR_BETWEEN_ROW_STD,
    _COLORBAR_PER_ROW_STD,
    _COLORBAR_ROW_SAMPLES,
)


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
