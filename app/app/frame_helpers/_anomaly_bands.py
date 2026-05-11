"""Horizontal anomaly-band detection. Carved out of the original
``frame_helpers.py`` during the modular refactor; behaviour
unchanged."""
from __future__ import annotations

import cv2
import numpy as np

from ._decode import _decode


# ── Horizontal anomaly band ──────────────────────────────────────────────────
# H.265 NAL/slice loss produces a horizontal band of corrupted rows
# anywhere in the frame — bottom 10–25 %, middle (y≈44–58 %), or
# upper-bottom (y≈85–95 %). The previous bottom_strip-only detector
# missed mid-frame and lower-but-not-bottom variants; the location-
# agnostic two-stage detector below catches all three failure modes.
#
# Stage A — row-delta band finder
#   Mean abs delta between row i and row i-1 spikes inside a
#   corrupted band because each row is a different scrambled block.
#   Smooth that 1D signal in a 16-row window, baseline at the 30th
#   percentile (which excludes the corruption band itself), and
#   threshold at the larger of 3× baseline OR a 5.0 floor.
# Stage B — chroma band finder
#   Saturated non-warm hues (everything outside the warm-amber
#   wedge that scene lights occupy) mark macroblock colour leaks.
#   Per-row count the "wrong colour" pixels, smooth, threshold at
#   1 % of row width.
# Both stages return (band_y_start, band_height, score) of the
# longest contiguous run; either one tripping is enough to reject
# the frame.
_ANOMALY_BAND_SMOOTH_WIN = 16        # row-window for the smoothing pass
_ANOMALY_BAND_BASELINE_PCT = 30      # robust baseline percentile
_ANOMALY_BAND_BASELINE_MULT = 3.0    # row_delta threshold = baseline * this
_ANOMALY_BAND_DELTA_FLOOR = 5.0      # …or this floor, whichever is higher
_ANOMALY_BAND_MIN_HEIGHT = 30        # rows — shorter runs are noise
_ANOMALY_BAND_MAX_HEIGHT_FRAC = 0.60 # bands covering > this much of the frame
                                     # are "the whole image" not "a band" —
                                     # skip them so a complex daytime scene
                                     # with abrupt region boundaries doesn't
                                     # trip the detector top-to-bottom.
_ANOMALY_BAND_MIN_Z = 1.5            # row-delta z-score threshold
_ANOMALY_CHROMA_HUE_LO = 10          # warm-amber hue range (lamps/IR-cut)
_ANOMALY_CHROMA_HUE_HI = 40
_ANOMALY_CHROMA_SAT_MIN = 60         # only saturated pixels count
_ANOMALY_CHROMA_ROW_FRAC = 0.01      # threshold = 1 % of row width
_ANOMALY_CHROMA_MIN_HEIGHT = 20      # rows — minimum band height
_ANOMALY_CHROMA_PEAK_PCT = 1.0       # peak fraction of row width


def _longest_above(mask: np.ndarray) -> tuple[int, int]:
    """Return (start_index, length) of the longest contiguous True
    run in a 1-D boolean array. Both 0 when no run exists."""
    longest_start, longest_len = -1, 0
    cur_start, cur_len = -1, 0
    for i, v in enumerate(mask):
        if v:
            if cur_start < 0:
                cur_start = i
            cur_len += 1
            if cur_len > longest_len:
                longest_len, longest_start = cur_len, cur_start
        else:
            cur_start, cur_len = -1, 0
    return (longest_start if longest_len > 0 else 0), longest_len


def _row_delta_anomaly_band(gray: np.ndarray) -> tuple[int, int, float] | None:
    """Stage A — find a contiguous run of rows whose row-to-row delta
    is z>1.5 above the image's robust baseline. Returns
    (band_y_start, band_height, z_score) or None.

    ``gray`` is uint8 H×W."""
    h = gray.shape[0]
    if h < _ANOMALY_BAND_SMOOTH_WIN * 2:
        return None
    # Mean abs delta between row i and row i-1 → 1D signal of length h-1.
    row_delta = np.abs(np.diff(gray.astype(np.float32), axis=0)).mean(axis=1)
    smooth = cv2.blur(
        row_delta.reshape(-1, 1),
        (1, _ANOMALY_BAND_SMOOTH_WIN),
    ).flatten()
    baseline = float(np.percentile(smooth, _ANOMALY_BAND_BASELINE_PCT))
    threshold = max(baseline * _ANOMALY_BAND_BASELINE_MULT,
                    _ANOMALY_BAND_DELTA_FLOOR)
    above = smooth > threshold
    start, length = _longest_above(above)
    if length < _ANOMALY_BAND_MIN_HEIGHT:
        return None
    if length / float(h) > _ANOMALY_BAND_MAX_HEIGHT_FRAC:
        # Whole image is "above" — that's a busy scene, not a
        # localised band. Real corruption bands span 2–25 % of frame
        # height; the 60 % cap here keeps daytime scenes with abrupt
        # region boundaries out.
        return None
    band_mean = float(smooth[start:start + length].mean())
    z = (band_mean - baseline) / max(float(np.std(smooth)), 0.5)
    if z < _ANOMALY_BAND_MIN_Z:
        return None
    return (start, length, z)


def _chroma_anomaly_band(img_bgr: np.ndarray) -> tuple[int, int, float] | None:
    """Stage B — find the most intense horizontal chroma band, where
    "wrong colour" means saturated pixels outside the warm-amber
    hue wedge (which scene lamps occupy). Returns
    (band_y_start, band_height, peak_pct) or None.

    Filters out warm scene lights by hue range — corruption colours
    (magenta/cyan/green) only appear outside [10, 40]° on OpenCV's
    H ∈ 0..179 scale."""
    h, w = img_bgr.shape[:2]
    if h < _ANOMALY_BAND_SMOOTH_WIN * 2 or w < 32:
        return None
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    H = hsv[:, :, 0]
    S = hsv[:, :, 1]
    wrong_mask = (
        ((H < _ANOMALY_CHROMA_HUE_LO) | (H > _ANOMALY_CHROMA_HUE_HI))
        & (S > _ANOMALY_CHROMA_SAT_MIN)
    )
    wrong_per_row = wrong_mask.sum(axis=1).astype(np.float32)
    smooth = cv2.blur(
        wrong_per_row.reshape(-1, 1),
        (1, _ANOMALY_BAND_SMOOTH_WIN),
    ).flatten()
    threshold = float(w) * _ANOMALY_CHROMA_ROW_FRAC
    above = smooth > threshold
    start, length = _longest_above(above)
    if length < _ANOMALY_CHROMA_MIN_HEIGHT:
        return None
    if length / float(h) > _ANOMALY_BAND_MAX_HEIGHT_FRAC:
        return None
    peak_pct = float(smooth.max()) / float(w) * 100.0
    if peak_pct < _ANOMALY_CHROMA_PEAK_PCT:
        return None
    return (start, length, peak_pct)


def is_horizontal_anomaly_band(img) -> tuple[bool, str]:
    """Detect a horizontal band of corruption rows anywhere in the
    frame. Backwards-compat: when the band sits in the bottom 25 %
    the reason head emitted is the legacy ``bottom_strip_white`` /
    ``bottom_strip_bright`` so existing log greps and reject-folder
    layouts keep working unchanged. Otherwise the head is the
    location-agnostic ``horizontal_anomaly_band`` and the parens
    carry the band's y%/h%/score so the rejected-folder name (built
    by the test-mode reject sink) groups corrupt frames by failure
    location."""
    img = _decode(img)
    if img is None or img.size == 0:
        return False, ""
    if img.ndim < 3 or img.shape[2] < 3:
        return False, ""
    h, _w = img.shape[:2]
    if h < 40:
        return False, ""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    a = _row_delta_anomaly_band(gray)
    b = _chroma_anomaly_band(img)
    if a is None and b is None:
        return False, ""
    # Prefer the row-delta result when both fire — it carries the
    # more precise z-score and is what catches the macroblock-smear
    # cluster the user reported.
    band_y, band_h, score = a if a is not None else b
    band_y_pct = int(round(100.0 * band_y / h))
    band_h_pct = int(round(100.0 * band_h / h))
    head = "horizontal_anomaly_band"
    # Backwards compat: when the band is in the bottom 25 % keep
    # emitting the legacy head so existing log greps survive.
    if band_y_pct >= 75:
        head = "bottom_strip_white" if a is None else "bottom_strip_bright"
    return True, f"{head}(y={band_y_pct}%,h={band_h_pct}%,score={score:.1f})"


# Back-compat shim — older callers (and the test suite) still import
# ``is_bottom_strip_anomaly``. Forwards to the new location-agnostic
# detector so behaviour is the new behaviour everywhere; the only
# difference is the name kept in the public symbol set.
def is_bottom_strip_anomaly(img) -> tuple[bool, str]:
    return is_horizontal_anomaly_band(img)
