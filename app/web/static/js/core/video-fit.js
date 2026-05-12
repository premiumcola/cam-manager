// ─── core/video-fit.js ─────────────────────────────────────────────────────
// One helper for the "where do the pixels actually land inside the
// <video> / <img> element" question. Every read-only overlay
// (zones, bboxes, trails, masks) needs this — without it, polygons
// drawn in source-resolution coords land in the wrong place once
// the media element is letterboxed by `object-fit: contain`.
//
// Returns the inner rect, in CSS pixels relative to the element's
// content box, that actually displays media. The four sides of that
// rect plus the rect's width/height are everything an overlay needs
// to map source coords (srcW × srcH) → on-screen coords.

/**
 * Compute the visible pixel rect inside a <video> or <img> that
 * uses object-fit:contain. Falls back to the element's full content
 * box when source dimensions are unknown (e.g. before first frame
 * decode) so callers never get a zero-size rect.
 *
 * @param {HTMLVideoElement|HTMLImageElement} el
 * @returns {{x:number, y:number, w:number, h:number}}
 */
export function fittedRect(el){
  if (!el) return { x: 0, y: 0, w: 0, h: 0 };
  const box = el.getBoundingClientRect();
  const srcW = el.videoWidth || el.naturalWidth || 0;
  const srcH = el.videoHeight || el.naturalHeight || 0;
  if (srcW <= 0 || srcH <= 0 || box.width <= 0 || box.height <= 0){
    // No source dimensions yet — return the full content box so the
    // overlay still mounts. Will redraw on the first ResizeObserver
    // tick once metadata loads.
    return { x: 0, y: 0, w: box.width, h: box.height };
  }
  const scale = Math.min(box.width / srcW, box.height / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  const x = (box.width - w) / 2;
  const y = (box.height - h) / 2;
  return { x, y, w, h };
}

/**
 * Compute the scale factor object-fit:contain applies, decoupled from
 * the centring offset. Handy for stroke widths that need to track
 * the displayed size without being pulled inside the letterbox rect.
 */
export function fitScale(el){
  if (!el) return 1;
  const box = el.getBoundingClientRect();
  const srcW = el.videoWidth || el.naturalWidth || 0;
  const srcH = el.videoHeight || el.naturalHeight || 0;
  if (srcW <= 0 || srcH <= 0 || box.width <= 0 || box.height <= 0) return 1;
  return Math.min(box.width / srcW, box.height / srcH);
}
