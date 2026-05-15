// ─── mediaview/canvas/zone-layer.js ────────────────────────────────────────
// Read-only camera-zone / mask polygon overlay shared by every
// viewing context (lightbox, live view, coral test, timelapse).
// Pure function — caller owns the canvas + the redraw cadence (RAF
// or ResizeObserver). Reads colours / line widths from
// core/zone-tokens.js so the visual matches the cam-edit polygon
// editor 1 : 1; nothing else in the codebase should be drawing
// zones / masks except by calling this.
//
// Coordinate handling — the hard part:
//   * Polygons arrive as arrays of {x, y} in SOURCE pixel space
//     (srcW × srcH).
//   * The canvas is sized to the OUTER element's CSS pixel rect
//     (typically the <video> / <img>'s getBoundingClientRect()).
//   * The media element itself uses `object-fit: contain` so the
//     visible pixels sit inside a letterbox sub-rect of that
//     bounding box. fittedRect() returns that sub-rect.
//
// The transform is:
//   on_canvas_x = fitted.x + (src_x / srcW) * fitted.w
//   on_canvas_y = fitted.y + (src_y / srcH) * fitted.h
//
// hideMasks=true draws zones only (timelapse playback hides masks
// because they'd visually clutter a sped-up overview without
// adding info).

import {
  ZONE_STROKE, ZONE_FILL, MASK_STROKE, MASK_FILL, LINE_W,
} from '../../core/zone-tokens.js';
import { fittedRect } from '../../core/video-fit.js';

/**
 * Compute the source-to-canvas-coord mapping for a single polygon.
 * Exposed so tests can pin the letterbox math without invoking the
 * full render pass.
 */
export function mapPolygonToCanvas(poly, srcW, srcH, fitted){
  if (!poly || !Array.isArray(poly) || srcW <= 0 || srcH <= 0) return [];
  const sx = fitted.w / srcW;
  const sy = fitted.h / srcH;
  return poly.map(pt => {
    const px = (pt && (pt.x ?? pt[0])) ?? 0;
    const py = (pt && (pt.y ?? pt[1])) ?? 0;
    return {
      x: fitted.x + px * sx,
      y: fitted.y + py * sy,
    };
  });
}

function _drawPoly(ctx, mapped, stroke, fill){
  if (!mapped || mapped.length < 2) return;
  ctx.beginPath();
  for (let i = 0; i < mapped.length; i++){
    const p = mapped[i];
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = LINE_W;
  ctx.stroke();
}

/**
 * Public entry — clear the canvas + render every zone + mask
 * polygon scaled into the source-to-canvas coordinate space.
 *
 * @param {HTMLCanvasElement} canvas  — the overlay canvas. Caller
 *   pre-sizes its `width`/`height` attributes to match the displayed
 *   element's rect (CSS px × devicePixelRatio is fine; the function
 *   doesn't introspect transform).
 * @param {{zones?: Array, masks?: Array}} polygons — each polygon is
 *   an array of `{x, y}` or `[x, y]` points in source coords.
 * @param {number} srcW — source image width (e.g. videoWidth).
 * @param {number} srcH — source image height (e.g. videoHeight).
 * @param {{hideMasks?: boolean}} opts — set `hideMasks` true to
 *   suppress masks (timelapse playback uses this).
 * @param {{x:number,y:number,w:number,h:number}} fitted — fitted
 *   rect from `core/video-fit.js#fittedRect`. Caller computes this
 *   once per redraw — the renderer is pure.
 */
export function renderZoneLayer(canvas, polygons, srcW, srcH, opts = {}, fitted = null){
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!polygons || (!polygons.zones?.length && !polygons.masks?.length)) return;
  const fit = fitted || { x: 0, y: 0, w: canvas.width, h: canvas.height };
  if (fit.w <= 0 || fit.h <= 0) return;
  const zones = polygons.zones || [];
  const masks = opts.hideMasks ? [] : (polygons.masks || []);
  // pn834 — each polygon may stamp its own source_w / source_h
  // (saved by the editor at commit time). When present, those win
  // over the media-element's videoWidth/Height so a polygon drawn
  // against a 640×360 substream snapshot maps correctly onto a
  // 2560×1440 main-stream recorded clip. Legacy polygons without
  // these fields fall back to the caller-supplied srcW/srcH.
  const _src = (p) => {
    const w = (p && typeof p === 'object' && p.source_w) || srcW;
    const h = (p && typeof p === 'object' && p.source_h) || srcH;
    return { w, h };
  };
  // Masks drawn FIRST so the green inclusion lines sit on top — when
  // a zone overlaps a mask the user sees the inclusion edge clearly.
  for (const m of masks){
    const poly = Array.isArray(m) ? m : (m?.points || m?.poly || []);
    const { w, h } = _src(m);
    const mapped = mapPolygonToCanvas(poly, w, h, fit);
    _drawPoly(ctx, mapped, MASK_STROKE, MASK_FILL);
  }
  for (const z of zones){
    const poly = Array.isArray(z) ? z : (z?.points || z?.poly || []);
    const { w, h } = _src(z);
    const mapped = mapPolygonToCanvas(poly, w, h, fit);
    _drawPoly(ctx, mapped, ZONE_STROKE, ZONE_FILL);
  }
}

/**
 * Caller helper — convenience to size canvas + draw in one call,
 * given an outer media element (the <video> / <img>). The canvas's
 * CSS width / height should already match the element's bounding
 * rect (parent's position:absolute inset:0 covers this).
 */
export function renderZoneLayerForMediaEl(canvas, mediaEl, polygons, opts = {}){
  if (!canvas || !mediaEl) return;
  const srcW = mediaEl.videoWidth || mediaEl.naturalWidth || 0;
  const srcH = mediaEl.videoHeight || mediaEl.naturalHeight || 0;
  // K2 · don't bail when the media element is transiently 0×0.
  // The previous early-return on box=0 caused the user's mask-toggle
  // round-trip (off → on) to leave the canvas blank: the visibility
  // setter cleared the canvas, then the redraw fired against a
  // transiently-zero box and never re-painted. ResizeObserver only
  // fires on size CHANGES — if the box flicked 0 mid-event, it
  // didn't re-trigger after the box was restored to its prior size.
  // Fallback: when the media box is 0 but the canvas has a known
  // previous size, draw against the canvas's own buffer dims. The
  // polygon mapping math is independent of mediaEl, so the redraw
  // lands on the right pixels at the same scale as the last good
  // paint.
  const box = mediaEl.getBoundingClientRect();
  let drawW = Math.round(box.width);
  let drawH = Math.round(box.height);
  if (drawW <= 0 || drawH <= 0){
    if (canvas.width > 0 && canvas.height > 0){
      drawW = canvas.width;
      drawH = canvas.height;
    } else {
      return;
    }
  }
  if (canvas.width !== drawW || canvas.height !== drawH){
    canvas.width = drawW;
    canvas.height = drawH;
  }
  // fittedRect handles the srcW/srcH=0 case internally; the
  // drawing buffer dims feed the fit math via the canvas itself.
  const fit = (box.width > 0 && box.height > 0)
    ? fittedRect(mediaEl)
    : { x: 0, y: 0, w: drawW, h: drawH };
  renderZoneLayer(canvas, polygons, srcW, srcH, opts, fit);
}
