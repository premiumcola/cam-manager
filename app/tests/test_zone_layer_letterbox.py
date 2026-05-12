"""Pin the contain-letterbox math used by
``app/web/static/js/mediaview/canvas/zone-layer.js#mapPolygonToCanvas``.

The JS function is the only thing rendering zone polygons in every
read-only overlay context (lightbox, live view, coral test,
timelapse). If the math drifts here, polygons land off the
displayed pixels everywhere at once. We don't ship a JS test
harness yet, so the canonical algorithm is replicated in Python
below and the invariants tested against the same inputs the JS
function consumes.

Keep this in lockstep with the JS:
   sx = fitted.w / srcW
   sy = fitted.h / srcH
   on_canvas_x = fitted.x + src_x * sx
   on_canvas_y = fitted.y + src_y * sy

   fittedRect( box, src ):
       scale = min(box.w / srcW, box.h / srcH)
       w = srcW * scale
       h = srcH * scale
       x = (box.w - w) / 2
       y = (box.h - h) / 2
"""
from __future__ import annotations


def _fitted_rect(box_w: float, box_h: float, src_w: float, src_h: float):
    if src_w <= 0 or src_h <= 0 or box_w <= 0 or box_h <= 0:
        return (0.0, 0.0, box_w, box_h)
    scale = min(box_w / src_w, box_h / src_h)
    w = src_w * scale
    h = src_h * scale
    x = (box_w - w) / 2
    y = (box_h - h) / 2
    return (x, y, w, h)


def _map_point(src_x: float, src_y: float,
               src_w: float, src_h: float,
               fitted) -> tuple[float, float]:
    fx, fy, fw, fh = fitted
    sx = fw / src_w
    sy = fh / src_h
    return (fx + src_x * sx, fy + src_y * sy)


def test_centre_maps_to_centre_landscape_source():
    """src 1920×1080, canvas 800×600. Source aspect (1.78) > canvas
    aspect (1.33) → contain limits by width. Letterbox is full-width
    (w=800) with vertical gutters above + below. Centre maps to
    centre regardless of which way the letterbox falls."""
    fitted = _fitted_rect(800, 600, 1920, 1080)
    x, y, w, h = fitted
    assert abs(w - 800) < 1e-9, f"letterbox should fill width: {w}"
    assert abs(h - 450) < 1e-9, f"letterbox h scales by 800/1920: {h}"
    assert abs(x - 0) < 1e-9, f"no horizontal gutter: x={x}"
    assert abs(y - 75) < 1e-9, f"vertical gutter splits 150 px: y={y}"
    cx, cy = _map_point(960, 540, 1920, 1080, fitted)
    assert abs(cx - 400) < 1e-9
    assert abs(cy - 300) < 1e-9


def test_origin_maps_into_letterbox_top_left():
    """Source (0, 0) lands at the top-left CORNER of the letterbox
    rect, not the canvas corner. With src 1920×1080 / canvas 800×600
    that's (0, 75) — the vertical-gutter top."""
    fitted = _fitted_rect(800, 600, 1920, 1080)
    x0, y0 = _map_point(0, 0, 1920, 1080, fitted)
    assert abs(x0 - 0) < 1e-9
    assert abs(y0 - 75) < 1e-9


def test_corner_maps_into_letterbox_bottom_right():
    """Source (srcW, srcH) lands at the bottom-right corner of the
    letterbox — at canvas (800, 525) for the same example."""
    fitted = _fitted_rect(800, 600, 1920, 1080)
    cx, cy = _map_point(1920, 1080, 1920, 1080, fitted)
    assert abs(cx - 800) < 1e-9
    assert abs(cy - 525) < 1e-9


def test_portrait_source_letterboxes_horizontally():
    """A 1080×1920 (portrait phone) source against an 800×600
    landscape canvas → contain limits by height. Letterbox is
    full-height with horizontal gutters."""
    fitted = _fitted_rect(800, 600, 1080, 1920)
    x, y, w, h = fitted
    assert abs(h - 600) < 1e-9, f"letterbox fills canvas height: {h}"
    expected_w = 1080 * (600 / 1920)
    assert abs(w - expected_w) < 1e-9, f"letterbox w = src_aspect * canvas_h: {w}"
    expected_x = (800 - expected_w) / 2
    assert abs(x - expected_x) < 1e-9
    assert abs(y - 0) < 1e-9
    # Source centre maps to canvas centre regardless of orientation.
    cx, cy = _map_point(540, 960, 1080, 1920, fitted)
    assert abs(cx - 400) < 1e-9
    assert abs(cy - 300) < 1e-9


def test_equal_aspect_no_letterbox():
    """When source and canvas share an aspect ratio, the letterbox
    fills the canvas exactly — no gutters anywhere."""
    fitted = _fitted_rect(1280, 720, 1920, 1080)
    x, y, w, h = fitted
    assert abs(x - 0) < 1e-9
    assert abs(y - 0) < 1e-9
    assert abs(w - 1280) < 1e-9
    assert abs(h - 720) < 1e-9


def test_zero_dimensions_return_safe_defaults():
    """Pre-decode, the media element has videoWidth=0. The fallback
    branch in fittedRect returns the full content box so the overlay
    still mounts (caller's ResizeObserver re-fires once metadata
    loads)."""
    fitted = _fitted_rect(800, 600, 0, 0)
    assert fitted == (0.0, 0.0, 800, 600)
