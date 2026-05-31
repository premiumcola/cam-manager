// ─── mediaview/canvas/index.js ─────────────────────────────────────────────
// Source-switch helper: mounts an <img>, <video>, or MJPEG element
// inside the canvas frame based on config.source.type, then stacks
// three EMPTY overlay-layer hosts over the media — one each for the
// zone/mask, trail and bbox painters. The painters themselves are NOT
// here: D ships the correctly stacked + correctly sized layer mount
// points; E (recorded bbox/trail/zone) and F (live overlays) draw into
// them by reaching the returned ``layers`` handles.
//
// Source branches:
//   * video / mp4 — weather + recorded clips: muted, native controls,
//     loop opt-in. iOS inline-plays a muted+looped clip without the
//     programmatic-seek fallback motion clips need.
//   * image       — recorded still frames / photos: a plain decoded
//     <img>, no loop, no autoplay.
//   * mjpeg       — live inference snapshots: an <img> whose ``src`` is
//     re-pointed each 1 Hz tick by the live poller. ``decoding:async``
//     keeps the main thread free while the next frame decodes.
//
// Overlay layers track the media element's RENDERED box — the
// object-fit:contain letterbox sub-rect from core/video-fit.js#fittedRect
// — and re-fit on every resize + first-frame load so a painter drawing
// in displayed-pixel space always lands on the visible content. Because
// the media element fills the frame (width/height:100%), fittedRect's
// in-element offset equals the layer's offset inside the frame.

import { fittedRect } from '../../core/video-fit.js';

// Bottom → top: zone/mask under trails under bbox, so a bounding box is
// never hidden behind a trail or a zone polygon. Mirrors the recorded +
// live paint order. z-index lives in 30g; the array order is the mount
// order (DOM order is the tiebreaker within one stacking context).
const _LAYER_KEYS = ['zones', 'trails', 'bbox'];

/**
 * Mount the media element for ``source`` into ``host`` plus the three
 * stacked overlay-layer hosts.
 *
 * @param {HTMLElement} host
 * @param {Object} source  { type: 'video'|'mp4'|'image'|'mjpeg', url,
 *   loop?, controls?, alt? }
 * @returns {{ el: HTMLElement, layers: {zones,trails,bbox},
 *   reposition(): void, teardown(): void } | null}
 */
export function mountCanvasSource(host, source = {}) {
  if (!host) return null;
  host.innerHTML = '';
  const type = source.type || 'video';
  let el;
  if (type === 'image' || type === 'mjpeg') {
    // Recorded still frame (image) or live inference snapshot (mjpeg).
    // Both are an <img>; the live poller re-points .src each tick.
    el = document.createElement('img');
    el.className = 'mv-canvas-media';
    el.dataset.mvSource = type;
    el.alt = source.alt || '';
    if (type === 'mjpeg') el.decoding = 'async';
    if (source.url) el.src = source.url;
  } else {
    // video / mp4 — weather + recorded clips: muted + loop so iOS inline-
    // plays them without the programmatic-seek issues that force the
    // native fallback for motion clips. Native controls give the scrubber.
    el = document.createElement('video');
    el.className = 'mv-canvas-media';
    el.dataset.mvSource = 'video';
    el.setAttribute('playsinline', '');
    el.muted = true;
    el.loop = source.loop !== false;
    el.controls = source.controls !== false;
    el.preload = 'metadata';
    if (source.url) {
      el.src = source.url;
      el.load();
      el.play().catch(() => {
        /* autoplay may be blocked — controls let the user start it */
      });
    }
  }
  host.appendChild(el);

  // Stacked, empty overlay-layer hosts. Each is sized + positioned to
  // the media's letterbox rect; painters append their <svg>/<canvas>
  // into layers[key]. pointer-events:none + z-index from 30g.
  const layers = {};
  for (const key of _LAYER_KEYS) {
    const layer = document.createElement('div');
    layer.className = 'mv-canvas-layer';
    layer.dataset.layer = key;
    host.appendChild(layer);
    layers[key] = layer;
  }

  // Re-fit the layer hosts to the media's rendered (letterboxed) box.
  // The media fills the frame, so fittedRect's in-element offset is the
  // layer's offset inside the frame's positioning context.
  const reposition = () => {
    const fit = fittedRect(el);
    for (const key of _LAYER_KEYS) {
      const layer = layers[key];
      layer.style.left = `${fit.x}px`;
      layer.style.top = `${fit.y}px`;
      layer.style.width = `${fit.w}px`;
      layer.style.height = `${fit.h}px`;
    }
  };

  let resizeObs = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObs = new ResizeObserver(reposition);
    resizeObs.observe(host);
  }
  // First-frame fit — natural/video dims are unknown until the media
  // decodes its first frame; fittedRect falls back to the full box
  // until then, this corrects it once the dims land.
  const onFirstFrame = () => reposition();
  if (el.tagName === 'VIDEO') el.addEventListener('loadedmetadata', onFirstFrame);
  else el.addEventListener('load', onFirstFrame);
  reposition();

  return {
    el,
    layers,
    reposition,
    teardown: () => {
      try {
        resizeObs?.disconnect();
      } catch {
        /* ignore */
      }
      if (el.tagName === 'VIDEO') el.removeEventListener('loadedmetadata', onFirstFrame);
      else el.removeEventListener('load', onFirstFrame);
      try {
        if (el.tagName === 'VIDEO') {
          el.pause();
          el.removeAttribute('src');
          el.load();
        }
      } catch {
        /* ignore */
      }
      for (const key of _LAYER_KEYS) layers[key].remove();
      el.remove();
    },
  };
}
