// ─── chrome/live-view.js ───────────────────────────────────────────────────
// Per-camera live-view modal. Default path uses a native <video>
// element fed HLS (hls.js on Chrome / Firefox / Edge, native on
// Safari + iOS). Native controls are deliberately suppressed in
// the template — the modal's own Liquid-Glass overlay chrome
// (close X, HD toggle, FS button) owns all interaction so iOS
// Safari can't escalate to its native fullscreen player. The
// legacy <img>+MJPEG path stays alongside as a fallback for the
// rare browser that can't do HLS at all (and for cameras where
// the per-cam streaming.hls_enabled is false).
//
// HD/SD toggle is irrelevant once HLS is engaged (one stream per
// camera) — the HD button hides itself in that mode and only
// surfaces when the MJPEG fallback drives the modal.
import { byId } from '../core/dom.js';
import { _hdCards } from '../dashboard.js';
import { colors } from '../core/icons.js';
import { fittedRect } from '../core/video-fit.js';
import { tryAttachHls } from '../core/hls-attach.js';

let _liveViewCamId = null;
let _hlsHandle = null;
let _liveViewUsingHls = false;
let _lvDetectAbort = null;
let _lvDetectTimer = null;

const _LV_DETECT_INTERVAL_MS = 1000;

// _liveViewHd is exposed on window because the template reads
// `!_liveViewHd` inline in the HD-toggle button's onclick. We keep
// the bridge in lockstep with the local primitive on every set.
window._liveViewHd = false;

export function openLiveView(camId, camName){
  const modal = byId('liveViewModal');
  if (!modal) return;
  _liveViewCamId = camId;
  window._liveViewHd = _hdCards.has(camId); // inherit shared HD state
  byId('liveViewTitle').textContent = camName || camId;
  _attachLiveStream();
  const imgEl = byId('liveViewImg');
  // Image click is intentionally NOT a fullscreen toggle — only the
  // FS button on the modal owns that. Same on the HLS <video> path:
  // native controls are suppressed in the template, so the wrap-
  // level .fake-fullscreen overlay is the single FS target on iOS.
  if (imgEl) imgEl.onclick = null;
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  // vm625 — bbox overlay on the regular Live modal. Polls the
  // detection endpoint at 1 Hz and paints PASS-verdict boxes onto
  // an SVG overlay inside #liveViewWrap. Decoupled from the video
  // stream so the user sees what the detector currently sees on
  // every camera regardless of which path is driving the visual
  // (HLS, MJPEG, etc.).
  _startLvDetectPolling();
}


// ── Live-modal bbox overlay (vm625) ────────────────────────────────────────
function _ensureLvBboxOverlay(){
  let svg = byId('liveViewBboxOverlay');
  if (svg) return svg;
  const wrap = byId('liveViewWrap');
  if (!wrap) return null;
  svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'liveViewBboxOverlay';
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:3';
  wrap.appendChild(svg);
  return svg;
}

function _activeLvMediaEl(){
  // Whichever of <video> / <img> is currently visible drives the
  // fittedRect math — the SVG must sit over the on-screen pixels,
  // not the wrap's outer box.
  const video = byId('liveViewVideo');
  const img = byId('liveViewImg');
  if (video && video.style.display !== 'none' && video.videoWidth > 0) return video;
  if (img && img.style.display !== 'none') return img;
  return null;
}

function _positionLvOverlay(svg){
  const wrap = byId('liveViewWrap');
  const mediaEl = _activeLvMediaEl();
  if (!wrap || !mediaEl || !svg) return;
  const wrapBox = wrap.getBoundingClientRect();
  const mBox = mediaEl.getBoundingClientRect();
  if (wrapBox.width <= 0 || mBox.width <= 0) return;
  const fit = fittedRect(mediaEl);
  const dx = (mBox.left - wrapBox.left) + fit.x;
  const dy = (mBox.top  - wrapBox.top)  + fit.y;
  svg.style.left = `${dx}px`;
  svg.style.top  = `${dy}px`;
  svg.style.width  = `${fit.w}px`;
  svg.style.height = `${fit.h}px`;
  svg.style.right  = 'auto';
  svg.style.bottom = 'auto';
  svg.style.inset  = 'auto';
}

function _renderLvBboxOverlay(data){
  const svg = _ensureLvBboxOverlay();
  if (!svg) return;
  _positionLvOverlay(svg);
  const fs = (data && data.frame_size) || { w: 1920, h: 1080 };
  svg.setAttribute('viewBox', `0 0 ${fs.w} ${fs.h}`);
  const dets = (data && data.detections) || [];
  // Only paint PASS verdicts in the regular Live modal — the user
  // wants the same picture they get in normal operation, not the
  // raw coral firehose (that's what the Simulieren mode is for).
  const passes = dets.filter(d => d.verdict === 'pass');
  svg.innerHTML = passes.map(d => {
    const c = colors[d.label] || '#cbd5e1';
    const [x, y, w, h] = d.bbox;
    const pct = Math.round((d.score || 0) * 100);
    const label = `${d.label} · ${pct}%`;
    return `<g>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${c}" stroke-width="3" vector-effect="non-scaling-stroke"/>
      <text x="${x + 4}" y="${y + 18}" fill="${c}" font-size="14" font-family="system-ui, sans-serif" font-weight="700" paint-order="stroke" stroke="rgba(0,0,0,0.7)" stroke-width="3">${label}</text>
    </g>`;
  }).join('');
}

async function _lvDetectTick(){
  if (!_liveViewCamId) return;
  try { _lvDetectAbort?.abort(); } catch { /* ignore */ }
  _lvDetectAbort = new AbortController();
  const start = performance.now();
  try {
    const r = await fetch(
      `/api/cameras/${encodeURIComponent(_liveViewCamId)}/test-detection?no_snapshot=1`,
      { method: 'POST', signal: _lvDetectAbort.signal },
    );
    if (!_liveViewCamId) return;
    let data = null;
    try { data = await r.json(); } catch { /* keep null */ }
    if (data && data.ok){
      _renderLvBboxOverlay(data);
    }
  } catch (e) {
    if (e?.name === 'AbortError') return;
    /* network blip — keep polling, no toast */
  }
  if (!_liveViewCamId) return;
  // Adaptive cadence — when the detector is fast, run again right
  // away (capped at 1 Hz); when it's slow, back off naturally.
  const cycle = performance.now() - start;
  const delay = Math.max(_LV_DETECT_INTERVAL_MS, Math.round(cycle * 1.1));
  _lvDetectTimer = setTimeout(_lvDetectTick, delay);
}

function _startLvDetectPolling(){
  _stopLvDetectPolling();
  // Kick the first tick immediately so the bbox layer paints within
  // the first detection cycle rather than waiting a full second.
  _lvDetectTimer = setTimeout(_lvDetectTick, 250);
}

function _stopLvDetectPolling(){
  try { _lvDetectAbort?.abort(); } catch { /* ignore */ }
  _lvDetectAbort = null;
  if (_lvDetectTimer){ clearTimeout(_lvDetectTimer); _lvDetectTimer = null; }
  const svg = byId('liveViewBboxOverlay');
  if (svg) svg.remove();
}

// Internal — wire either HLS (preferred) or MJPEG into the modal's
// two media elements. Tears down any previous HLS instance first
// so re-opening the modal on a different camera doesn't leak the
// old session.
function _attachLiveStream(){
  if (!_liveViewCamId) return;
  const video = byId('liveViewVideo');
  const img = byId('liveViewImg');
  const hdBtn = byId('liveViewHdBtn');
  _teardownHls();
  if (video){ video.pause(); video.removeAttribute('src'); video.load?.(); }
  if (img) img.src = '';
  // Try HLS first (hls.js → native iOS). Fatal hls.js errors flip
  // the modal to the MJPEG path; non-fatal errors recover internally.
  if (video){
    _hlsHandle = tryAttachHls(_liveViewCamId, video, {
      onFatalError: () => { _teardownHls(); _attachMjpegFallback(); },
    });
    if (_hlsHandle){
      video.style.display = 'block';
      if (img) img.style.display = 'none';
      _liveViewUsingHls = true;
      if (hdBtn) hdBtn.style.display = 'none';
      return;
    }
  }
  // Last-resort MJPEG fallback — only reached when neither hls.js
  // nor native HLS is available (rare desktop browsers). Shows the
  // HD toggle so the user retains the legacy SD ↔ HD switch.
  _attachMjpegFallback();
}

function _attachMjpegFallback(){
  _liveViewUsingHls = false;
  const video = byId('liveViewVideo');
  const img = byId('liveViewImg');
  const hdBtn = byId('liveViewHdBtn');
  if (video){ video.style.display = 'none'; }
  if (img){ img.style.display = 'block'; }
  if (hdBtn) hdBtn.style.display = '';
  _setLiveViewStream(window._liveViewHd);
}

function _teardownHls(){
  if (_hlsHandle){
    _hlsHandle.detach();
    _hlsHandle = null;
  }
  _liveViewUsingHls = false;
}

export function _setLiveViewStream(hd){
  // MJPEG-fallback HD/SD switch. No-op when HLS owns the modal —
  // the HD button is hidden in that case, but a stray external
  // window._setLiveViewStream call still shouldn't bleed past the
  // fallback path.
  window._liveViewHd = hd;
  if (_liveViewUsingHls) return;
  const img = byId('liveViewImg');
  if (!img || !_liveViewCamId) return;
  img.src = ''; // disconnect current stream first
  const url = hd ? `/api/camera/${encodeURIComponent(_liveViewCamId)}/stream_hd.mjpg`
                 : `/api/camera/${encodeURIComponent(_liveViewCamId)}/stream.mjpg`;
  img.src = url;
  if (hd) _hdCards.add(_liveViewCamId);
  else _hdCards.delete(_liveViewCamId);
  const cardBadge = document.querySelector(`.cv-card[data-camid="${CSS.escape(_liveViewCamId)}"] .cv-hd-badge`);
  if (cardBadge) cardBadge.classList.toggle('active', hd);
  const cardImg = document.querySelector(`.cv-card[data-camid="${CSS.escape(_liveViewCamId)}"] .cv-img`);
  if (cardImg){
    if (hd && cardImg.dataset.hdMode !== '1'){
      cardImg.dataset.hdMode = '1';
      cardImg.src = `/api/camera/${encodeURIComponent(_liveViewCamId)}/stream_hd.mjpg`;
    } else if (!hd && cardImg.dataset.hdMode === '1'){
      cardImg.dataset.hdMode = '0';
      cardImg.src = `/api/camera/${encodeURIComponent(_liveViewCamId)}/snapshot.jpg?t=${Date.now()}`;
    }
  }
  const hdBtn = byId('liveViewHdBtn');
  if (hdBtn){
    hdBtn.textContent = 'HD';
    hdBtn.style.border = 'none';
    if (hd){
      hdBtn.style.background = 'rgba(255,255,255,0.85)';
      hdBtn.style.color = '#0a0e1a';
      hdBtn.style.fontWeight = '800';
    } else {
      hdBtn.style.background = 'rgba(255,255,255,0.08)';
      hdBtn.style.color = 'rgba(255,255,255,0.35)';
      hdBtn.style.fontWeight = '700';
    }
  }
}

export function closeLiveView(){
  const modal = byId('liveViewModal');
  if (!modal) return;
  // jt719 — revert any active HD session for this camera when the
  // user closes the live-view modal. Walks the dashboard tile to
  // flip the HD button via the canonical toggleCardHd so the
  // _hdCards set, the tile's data attr, and the badge visual stay
  // in lockstep. Silent — the badge just de-activates.
  if (_liveViewCamId && _hdCards.has(_liveViewCamId)){
    const card = document.querySelector(`.cv-card[data-camid="${CSS.escape(_liveViewCamId)}"]`);
    const hdBtn = card?.querySelector('.cv-hd-badge');
    if (hdBtn && typeof window.toggleCardHd === 'function'){
      window.toggleCardHd(_liveViewCamId, hdBtn);
    }
  }
  _stopLvDetectPolling();
  _teardownHls();
  const video = byId('liveViewVideo');
  if (video){
    video.pause();
    video.removeAttribute('src');
    video.load?.();
  }
  const img = byId('liveViewImg');
  if (img) img.src = ''; // disconnect MJPEG stream → remove_viewer
  if (document.fullscreenElement || document.webkitFullscreenElement){
    (document.exitFullscreen || document.webkitExitFullscreen || function(){}).call(document).catch(() => {});
  }
  const wrap = byId('liveViewWrap');
  if (wrap) wrap.classList.remove('fake-fullscreen');
  modal.classList.add('hidden');
  document.body.style.overflow = '';
  _liveViewCamId = null;
}

// Inline onclick callsites in the static template + the dashboard.js
// tile click handler reach these via window.X.
window.openLiveView = openLiveView;
window.closeLiveView = closeLiveView;
window._setLiveViewStream = _setLiveViewStream;
