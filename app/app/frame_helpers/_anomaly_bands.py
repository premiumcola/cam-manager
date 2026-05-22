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
_ANOMALY_BAND_SMOOTH_WIN = 16  # row-window for the smoothing pass
_ANOMALY_BAND_BASELINE_PCT = 30  # robust baseline percentile
_ANOMALY_BAND_BASELINE_MULT = 3.0  # row_delta threshold = baseline * this
_ANOMALY_BAND_DELTA_FLOOR = 5.0  # …or this floor, whichever is higher
_ANOMALY_BAND_MIN_HEIGHT = 30  # rows — shorter runs are noise
_ANOMALY_BAND_MAX_HEIGHT_FRAC = 0.60  # bands covering > this much of the frame
# are "the whole image" not "a band" —
# skip them so a complex daytime scene
# with abrupt region boundaries doesn't
# trip the detector top-to-bottom.
_ANOMALY_BAND_MIN_Z = 2.5  # row-delta z-score threshold
# Was 1.5 until 2026-05-12; the
# sunset test on garten-dach-terrasse
# showed a borderline false-positive
# cluster at score≈2.5 (clock-strip
# row-delta from the timestamp
# overlay; the per-camera zone
# exclusion above catches those
# cleanly when they fit the zone,
# but a slightly tighter floor kills
# the remaining 2.4-2.5 borderline
# cases that fall just outside the
# zone too). 3.0 was the original
# target but regressed the
# TestHorizontalAnomalyBand mid-
# band synthetic at z=2.99 — that
# detector unit test is the closest
# ground-truth we have, so the
# floor stays just below it.
_ANOMALY_CHROMA_HUE_LO = 10  # warm-amber hue range (lamps/IR-cut)
_ANOMALY_CHROMA_HUE_HI = 40
_ANOMALY_CHROMA_SAT_MIN = 60  # only saturated pixels count
_ANOMALY_CHROMA_ROW_FRAC = 0.01  # threshold = 1 % of row width
_ANOMALY_CHROMA_MIN_HEIGHT = 20  # rows — minimum band height
_ANOMALY_CHROMA_PEAK_PCT = 1.0  # peak fraction of row width

# Per-camera timestamp-overlay exclusion ──────────────────────────────────
# Many cameras burn a 1-line clock into the lower-middle of the frame.
# That single-line text reads as a thin row-delta spike — the row above
# is sky/scene, the row through the text is high-contrast — and the
# detector flags it as a corruption band (score ~2–3, y≈68 %, h≈4 %).
# The fix: a per-camera zone the operator declares as "where my camera's
# clock lives". Bands that fit ENTIRELY within zone ± fudge are
# suppressed; bands that extend above/below or span the full frame
# still reject. The fudge factor compensates for the 1-row jitter in
# how the row-delta smoothing locates the band centre.
#
# Defaults match the dominant false-positive cluster in the 2026-05-12
# sunset test run on garten-dach-terrasse: 34 of 86 horizontal_anomaly_band
# rejects had identical parameters (y=68 %, h=4 %), a 4-row band 68 %
# down the frame — exactly the timestamp strip on Reolink CX810
# firmware. Users whose camera burns its clock somewhere else override
# via cameras[].timestamp_overlay_zone = {"y_pct": …, "h_pct": …};
# explicit ``{"enabled": false}`` turns the exclusion off completely.
_DEFAULT_TIMESTAMP_ZONE_Y_PCT = 68
_DEFAULT_TIMESTAMP_ZONE_H_PCT = 6
_TIMESTAMP_ZONE_FUDGE_PCT = 2


def _resolve_timestamp_zone(zone) -> tuple[int, int] | None:
    """Pick the effective (y_pct, h_pct) tuple for a per-camera setting.

    Returns ``None`` when the camera opted out via ``{"enabled": false}``.
    A missing / empty dict falls back to the module defaults so a fresh
    install benefits from the exclusion without anyone editing JSON."""
    if isinstance(zone, dict) and zone.get("enabled") is False:
        return None
    if isinstance(zone, dict):
        return (
            int(zone.get("y_pct", _DEFAULT_TIMESTAMP_ZONE_Y_PCT)),
            int(zone.get("h_pct", _DEFAULT_TIMESTAMP_ZONE_H_PCT)),
        )
    return (_DEFAULT_TIMESTAMP_ZONE_Y_PCT, _DEFAULT_TIMESTAMP_ZONE_H_PCT)


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


def _row_delta_anomaly_band(
    gray: np.ndarray,
    *,
    min_z: float = _ANOMALY_BAND_MIN_Z,
) -> tuple[int, int, float] | None:
    """Stage A — find a contiguous run of rows whose row-to-row delta
    is z>1.5 above the image's robust baseline. Returns
    (band_y_start, band_height, z_score) or None.

    ``gray`` is uint8 H×W. ``min_z`` overrides the module-level
    z-score floor; the validator profiles use this to loosen the
    detector during twilight (Reolink IR-cut transitions trigger a
    z ≈ 2.5-3.5 band that's a false positive)."""
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
    threshold = max(baseline * _ANOMALY_BAND_BASELINE_MULT, _ANOMALY_BAND_DELTA_FLOOR)
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
    band_mean = float(smooth[start : start + length].mean())
    z = (band_mean - baseline) / max(float(np.std(smooth)), 0.5)
    if z < min_z:
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
    wrong_mask = ((H < _ANOMALY_CHROMA_HUE_LO) | (H > _ANOMALY_CHROMA_HUE_HI)) & (
        S > _ANOMALY_CHROMA_SAT_MIN
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


def is_horizontal_anomaly_band(
    img,
    *,
    timestamp_zone=None,
    profile=None,
) -> tuple[bool, str]:
    """Detect a horizontal band of corruption rows anywhere in the
    frame. Backwards-compat: when the band sits in the bottom 25 %
    the reason head emitted is the legacy ``bottom_strip_white`` /
    ``bottom_strip_bright`` so existing log greps and reject-folder
    layouts keep working unchanged. Otherwise the head is the
    location-agnostic ``horizontal_anomaly_band`` and the parens
    carry the band's y%/h%/score so the rejected-folder name (built
    by the test-mode reject sink) groups corrupt frames by failure
    location.

    ``timestamp_zone`` (per-camera setting from settings.json) names
    the strip the camera burns its clock into. When the detected band
    fits entirely within that zone (± fudge) AND the chroma stage did
    NOT independently fire, the band is suppressed — that signature
    matches a clock readout (single-row text spike, no chroma leak),
    not a NAL/slice-loss corruption (which produces both row-delta
    AND wrong-colour evidence).

    ``profile`` (FrameValidatorProfile) lets the caller override the
    row-delta z-score floor — twilight passes a profile whose value
    is raised to 4.0 so Reolink IR-cut transition stripes (z≈2.5-3.5)
    aren't misclassified as corruption. ``None`` keeps the historic
    module-level default 2.5."""
    img = _decode(img)
    if img is None or img.size == 0:
        return False, ""
    if img.ndim < 3 or img.shape[2] < 3:
        return False, ""
    h, _w = img.shape[:2]
    if h < 40:
        return False, ""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    min_z = getattr(profile, "horizontal_anomaly_band_min_z", _ANOMALY_BAND_MIN_Z)
    a = _row_delta_anomaly_band(gray, min_z=float(min_z))
    b = _chroma_anomaly_band(img)
    if a is None and b is None:
        return False, ""
    # Prefer the row-delta result when both fire — it carries the
    # more precise z-score and is what catches the macroblock-smear
    # cluster the user reported.
    band_y, band_h, score = a if a is not None else b
    band_y_pct = int(round(100.0 * band_y / h))
    band_h_pct = int(round(100.0 * band_h / h))
    # Timestamp-overlay exclusion ─ a clock readout only trips the
    # row-delta stage (high-contrast text, low chroma). Real codec
    # corruption trips BOTH stages, so requiring ``b is None`` keeps
    # the suppression narrow to the false-positive cluster while
    # still rejecting any real corruption that happens to overlap the
    # timestamp strip.
    zone = _resolve_timestamp_zone(timestamp_zone)
    if zone is not None and b is None:
        zone_y, zone_h = zone
        zone_lo = zone_y - _TIMESTAMP_ZONE_FUDGE_PCT
        zone_hi = zone_y + zone_h + _TIMESTAMP_ZONE_FUDGE_PCT
        if zone_lo <= band_y_pct and (band_y_pct + band_h_pct) <= zone_hi:
            return False, ""
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
def is_bottom_strip_anomaly(
    img,
    *,
    timestamp_zone=None,
    profile=None,
) -> tuple[bool, str]:
    return is_horizontal_anomaly_band(
        img,
        timestamp_zone=timestamp_zone,
        profile=profile,
    )


# Cheap pink/rainbow H.264 bottom-strip detector. Originally a static
# method on the camera-runtime capture mixin; lifted to a free function
# so the test-detection endpoint can call it without instantiating the
# runtime class. Single source of truth: the runtime mixin imports
# this and forwards. The richer ``is_horizontal_anomaly_band`` above
# generalises this idea over the whole frame, but the legacy detector
# is intentionally less sensitive (no row-delta z-score, no chroma-
# hue carving) so a clean test frame doesn't get rejected by the
# stricter band heuristic.
def has_corrupt_strip(frame, strip_height: int = 60) -> bool:
    """Detect H.264 corrupt bottom strip (pink/rainbow codec artifact).
    Returns True when the bottom ``strip_height`` rows show the
    hue-saturation signature of a chroma-buffer flush."""
    if frame is None:
        return False
    if frame.ndim < 3 or frame.shape[2] < 3:
        return False
    if frame.shape[0] < strip_height * 2:
        return False
    strip = frame[-strip_height:, :, :]
    hsv = cv2.cvtColor(strip, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1].astype(np.float32)
    return float(sat.mean()) > 120 and float(sat.std()) > 60
