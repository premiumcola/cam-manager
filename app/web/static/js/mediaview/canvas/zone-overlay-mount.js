// ─── mediaview/canvas/zone-overlay-mount.js ────────────────────────────────
// Wire the shared renderZoneLayer into the lightbox / timelapse
// playback viewport. Mounts a canvas overlay on top of the video
// element, watches the video for size + metadata changes via
// ResizeObserver + loadedmetadata, and redraws.
//
// Live view + coral test mode use their own SVG overlays via
// live-detect.js — those don't need this helper because they
// already redraw on every test-detection tick. This module is for
// passive video playback contexts where there is no per-frame
// callback.

import { state } from '../../core/state.js';
import { renderZoneLayerForMediaEl } from './zone-layer.js';

const _ZONE_CANVAS_ID = 'lightboxZoneOverlay';
let _resizeObs = null;
let _videoEl = null;
let _onMeta = null;
let _onResize = null;
// Live visibility flags + memoised draw function — overlay-toggles
// flips these on user toggle then calls ``redrawZoneOverlay()`` so
// the canvas updates without remounting the ResizeObserver.
let _visibility = { showZones: true, showMasks: true };
let _redrawFn = null;

function _ensureCanvas(wrap){
  let c = document.getElementById(_ZONE_CANVAS_ID);
  if (c) return c;
  c = document.createElement('canvas');
  c.id = _ZONE_CANVAS_ID;
  c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:4';
  wrap.appendChild(c);
  return c;
}

/**
 * Mount the zone overlay on the lightbox video. ``item`` provides
 * the camera id (zones / masks come from state.cameras). When the
 * item is a timelapse the helper hides masks via ``opts.hideMasks``
 * because a sped-up playback already has enough visual noise.
 *
 * Idempotent — calling again replaces the previous wiring cleanly.
 */
export function mountZoneOverlayForLightbox(item, opts = {}){
  unmountZoneOverlayForLightbox();
  if (!item || !item.camera_id) return;
  const wrap = document.getElementById('lightboxMediaWrap');
  if (!wrap) return;
  const video = document.getElementById('lightboxVideo');
  const img = document.getElementById('lightboxImg');
  // Prefer whichever element is currently visible — the lightbox
  // shows the <img> for photos / pre-decode, the <video> for
  // motion clips and timelapses.
  const mediaEl = (video && video.style.display !== 'none' && video.src)
    ? video
    : (img && img.style.display !== 'none' && img.src ? img : null);
  if (!mediaEl) return;
  _videoEl = mediaEl;
  const canvas = _ensureCanvas(wrap);
  const cam = (state.cameras || []).find(c => c.id === item.camera_id) || {};
  // Sanitise polygons into the shape renderZoneLayer expects —
  // both editor-source ({points:[{x,y}]}) and legacy ({poly:[...]})
  // forms come through.
  const polygons = {
    zones: (cam.zones || []).map(z => z.points || z.poly || z),
    masks: (cam.masks || []).map(m => m.points || m.poly || m),
  };
  const isTL = item.type === 'timelapse';
  // Initial visibility — zones always on, masks hidden by default
  // for timelapses (sped-up overview gets cluttered) and on for
  // motion clips. The overlay-toggles bar can flip either at
  // runtime via setZoneOverlayVisibility().
  _visibility = {
    showZones: true,
    showMasks: !(opts.hideMasks ?? isTL),
  };
  const draw = () => {
    if (!_visibility.showZones && !_visibility.showMasks){
      // Both off — clear the canvas to a transparent state.
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    renderZoneLayerForMediaEl(canvas, _videoEl, {
      zones: _visibility.showZones ? polygons.zones : [],
      masks: _visibility.showMasks ? polygons.masks : [],
    }, {});
  };
  _redrawFn = draw;
  // ResizeObserver — fires on every layout change of the media
  // element (window resize, address-bar collapse on iOS, modal
  // open/close, fullscreen enter/exit).
  _resizeObs = new ResizeObserver(draw);
  _resizeObs.observe(_videoEl);
  // loadedmetadata — videoWidth/videoHeight only become non-zero
  // after this fires. fittedRect handles the pre-metadata case but
  // an explicit redraw keeps the overlay in sync the moment the
  // browser knows the source dimensions.
  _onMeta = () => draw();
  _videoEl.addEventListener('loadedmetadata', _onMeta);
  if (img){
    // Same trick on the <img> for photo / snapshot playback.
    _videoEl.addEventListener('load', _onMeta);
  }
  // window resize — belt and braces for browsers where the
  // ResizeObserver on the inner element doesn't fire on viewport
  // changes that don't change the element's CSS box.
  _onResize = () => draw();
  window.addEventListener('resize', _onResize);
  // First paint.
  draw();
}

/**
 * Live-toggle either the zone or mask layer's visibility without
 * unmounting the ResizeObserver. Called by the overlay-toggles bar
 * when the user flips a pill.
 *
 * bm491 — explicit clearRect before redrawing so the canvas never
 * carries a stale polygon when the user clicks the same toggle a
 * second time. renderZoneLayer's own clearRect should already cover
 * this; the belt-and-suspenders clear here makes the round-trip
 * bulletproof against any future refactor of the layer renderer.
 *
 * K2 · undefined arguments mean "no change". The receiver-side
 * `typeof X === 'boolean'` guards already implemented this contract,
 * but the doc was implicit. Documenting + adding a console.warn when
 * a visibility toggle fires while _redrawFn is null (would mean the
 * mount was torn down between the user's click and this handler)
 * so the user-reported "mask off → on doesn't repaint" symptom has
 * a one-shot diagnostic. The actual repaint regression was fixed in
 * zone-layer.js · renderZoneLayerForMediaEl (transient 0×0 bail).
 */
export function setZoneOverlayVisibility({ showZones, showMasks }){
  if (typeof showZones === 'boolean') _visibility.showZones = showZones;
  if (typeof showMasks === 'boolean') _visibility.showMasks = showMasks;
  const c = document.getElementById(_ZONE_CANVAS_ID);
  if (c){
    const ctx = c.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, c.width, c.height);
  }
  if (_redrawFn) {
    _redrawFn();
  } else {
    // One-shot diagnostic: the visibility setter ran but the mount
    // was already torn down. Earlier symptom of K2 — the canvas
    // gets cleared, no redraw fires, polygons stay invisible.
    console.warn('[zone-overlay] setZoneOverlayVisibility ran without _redrawFn — mount torn down?');
  }
}
window._setZoneOverlayVisibility = setZoneOverlayVisibility;

export function unmountZoneOverlayForLightbox(){
  if (_resizeObs){
    try { _resizeObs.disconnect(); } catch { /* ignore */ }
    _resizeObs = null;
  }
  if (_videoEl){
    if (_onMeta){
      _videoEl.removeEventListener('loadedmetadata', _onMeta);
      _videoEl.removeEventListener('load', _onMeta);
    }
    _videoEl = null;
    _onMeta = null;
  }
  if (_onResize){
    window.removeEventListener('resize', _onResize);
    _onResize = null;
  }
  _redrawFn = null;
  const c = document.getElementById(_ZONE_CANVAS_ID);
  if (c) c.remove();
}

// Expose on window so lightbox.js' close path can tear down without
// importing this module directly (avoids circular load order).
window._mountZoneOverlayForLightbox = mountZoneOverlayForLightbox;
window._unmountZoneOverlayForLightbox = unmountZoneOverlayForLightbox;
