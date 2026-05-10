// ─── mediathek/bbox-overlay.js ─────────────────────────────────────────────
// Stage 21 / Phase 2 of the tracking pipeline — draws bounding boxes
// over the active lightbox media AND owns the new track-timeline
// panel that ships beneath the video in full-screen mode.
//
//   1. tracks.json sidecar drives per-frame interpolated bboxes during
//      playback and a per-class timeline panel (lbRenderTrackTimeline)
//      below the video. Tap a class badge to toggle its bboxes; tap
//      a bar to seek to that track's start.
//   2. When the sidecar is missing or empty AND the event has trigger
//      detections, we kick a /api/tracking/reindex/<id> POST and show
//      a banner + retry loop. The legacy single-bbox fallback is
//      drawn ONLY between "tracks ready" and the user navigating away.
//
// Stage-30 polish removed the long-running tracking chip and the
// standalone per-class toggle row; both surfaces are folded into the
// timeline panel where the same controls have a natural home.
//
// The MP4 is NEVER modified; this is a Canvas overlay, like subtitles.
// Track colours come from the deterministic tracks.json palette so
// multiple subjects in one clip get distinguishable strokes.
import { byId } from '../core/dom.js';
import { colors, OBJ_LABEL, OBJ_SVG } from '../core/icons.js';
import { _lbClearDetections } from '../lightbox.js';
import { lbState } from './state.js';
import { showToast } from '../core/toast.js';
import { state } from '../core/state.js';

// In-flight & cache state for tracks.json fetches. Keyed by event_id
// so re-opens don't re-fetch unless the user explicitly re-indexes.
const _tracksCache = new Map();    // event_id → payload | null (404)
const _tracksInflight = new Map(); // event_id → Promise
let _rafHandle = 0;

// Auto-reindex bookkeeping. All keyed by event_id.
//   _reindexedThisSession → events we've already POSTed at least once.
//     Prevents reopen-spam re-queueing the worker.
//   _reindexInflight      → reindex retry-loop is currently running.
//     Legacy fallback bbox is suppressed for these so the user doesn't
//     stare at a stationary mis-positioned box for ~17 s.
//   _reindexFinalFailed   → 3 retries elapsed without a usable sidecar.
const _reindexedThisSession = new Set();
const _reindexInflight = new Set();
const _reindexFinalFailed = new Set();

const _REINDEX_INITIAL_WAIT_MS = 5000;
const _REINDEX_RETRY_INTERVAL_MS = 4000;
const _REINDEX_MAX_RETRIES = 3;

// ?lbdebug=1 surfaces the same diagnostics that go to console.warn in
// a small bottom-right corner overlay. Off by default; resolved once
// at module load so navigation inside the SPA can't flip it mid-session.
const _DEBUG_LB = (() => {
  try { return new URLSearchParams(location.search).has('lbdebug'); }
  catch { return false; }
})();
const _DEBUG_BUFFER = []; // last 4 lines for the corner overlay

// ── Debug logging ────────────────────────────────────────────────────────
function _logDiag(line, level = 'info'){
  if (level === 'error') console.error('[mediathek:tracking]', line);
  else if (level === 'warn') console.warn('[mediathek:tracking]', line);
  if (_DEBUG_LB){
    _DEBUG_BUFFER.push(line);
    while (_DEBUG_BUFFER.length > 4) _DEBUG_BUFFER.shift();
    _renderDebugOverlay();
  }
}

function _ensureDebugOverlay(){
  if (!_DEBUG_LB) return null;
  let el = byId('lbDebugOverlay');
  if (el) return el;
  const wrap = byId('lightboxMediaWrap');
  if (!wrap) return null;
  el = document.createElement('div');
  el.id = 'lbDebugOverlay';
  el.style.cssText = 'position:absolute;right:10px;bottom:10px;max-width:46%;'
    + 'padding:6px 8px;border-radius:8px;background:rgba(0,0,0,.62);'
    + 'color:#a5f3fc;font:500 10px/1.35 ui-monospace,Menlo,Consolas,monospace;'
    + 'letter-spacing:.01em;backdrop-filter:blur(4px);pointer-events:none;'
    + 'z-index:6;white-space:pre-wrap;word-break:break-all';
  wrap.appendChild(el);
  return el;
}

function _renderDebugOverlay(){
  const el = _ensureDebugOverlay();
  if (!el) return;
  el.textContent = _DEBUG_BUFFER.join('\n');
}

// ── Per-class hidden-set persistence ─────────────────────────────────────
// localStorage keyed per camera. JSON-encoded array of label strings.
// Reads parse into a Set for O(1) membership lookup; writes serialise
// back to an array (additive — only the per-cam key is touched, the
// rest of localStorage is untouched).

function _hiddenStorageKey(camId){
  return `tamspy.lb.bboxClasses.hidden.${camId || ''}`;
}

function _getHiddenClassesForCam(camId){
  if (!camId) return new Set();
  try {
    const raw = localStorage.getItem(_hiddenStorageKey(camId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

function _setHiddenClassesForCam(camId, hiddenSet){
  if (!camId) return;
  try {
    const arr = [...hiddenSet];
    if (arr.length === 0) localStorage.removeItem(_hiddenStorageKey(camId));
    else localStorage.setItem(_hiddenStorageKey(camId), JSON.stringify(arr));
  } catch { /* quota / private mode — fall through silently */ }
}

// ── Fetching ──────────────────────────────────────────────────────────────

function _tracksUrlFor(item){
  const rel = item?.video_relpath;
  if (!rel) return null;
  // The mp4 lives at <storage>/motion_detection/<cam>/<date>/<id>.mp4
  // and the sidecar sits next to it as <id>.tracks.json. Same /media/
  // route serves both.
  if (rel.endsWith('.mp4')) return `/media/${rel.slice(0, -4)}.tracks.json`;
  return null;
}

async function _fetchTracks(item){
  const eid = item?.event_id;
  const url = _tracksUrlFor(item);
  if (!eid || !url) return null;
  if (_tracksCache.has(eid)) return _tracksCache.get(eid);
  if (_tracksInflight.has(eid)) return _tracksInflight.get(eid);
  const p = (async () => {
    try {
      const bustUrl = `${url}?_t=${Date.now()}`;
      const r = await fetch(bustUrl, { cache: 'no-store' });
      if (!r.ok){
        _tracksCache.set(eid, null);
        _logDiag(
          `event=${eid} fetch status=${r.status} url=${url} → no tracks`,
          r.status === 404 ? 'info' : 'warn');
        return null;
      }
      const data = await r.json();
      for (const tr of (data.tracks || [])){
        (tr.samples || []).sort((a, b) => a.f - b.f);
      }
      _tracksCache.set(eid, data);
      const fa = Array.isArray(data.filter_applied)
        ? data.filter_applied.join(',') : 'none';
      _logDiag(
        `event=${eid} fetch status=200 schema=${data.schema ?? '?'} `
        + `tracks=${(data.tracks || []).length} filter=${fa}`,
        'info');
      return data;
    } catch (e) {
      _tracksCache.set(eid, null);
      _logDiag(`event=${eid} fetch error: ${e?.message || e}`, 'warn');
      return null;
    } finally {
      _tracksInflight.delete(eid);
    }
  })();
  _tracksInflight.set(eid, p);
  return p;
}

// Reset the cached payload for an event so the next render fetches a
// fresh tracks.json (fired after a successful re-index POST).
export function lbInvalidateTracks(eventId){
  if (eventId) _tracksCache.delete(eventId);
}

// Public entry: load tracks for the just-opened item and prime the
// timeline. Called from openLightbox after the video src is set; the
// RAF loop kicks off via the play/loadedmetadata listeners.
export async function lbLoadTracksForItem(item){
  if (!item) return;
  const tracks = await _fetchTracks(item);
  item._tracks = tracks;
  if (lbState.item !== item) return;

  // Decide whether to kick the auto-reindex flow:
  //   * no sidecar (null) AND event has ≥1 trigger detection
  //   * sidecar with empty tracks AND event has ≥1 trigger detection
  const haveAnyTracks = !!(tracks
    && Array.isArray(tracks.tracks) && tracks.tracks.length > 0);
  const triggerDetCount = (item.detections || [])
    .filter(d => d && d.bbox && typeof d.bbox.x1 === 'number').length;
  const sidecarMissing = tracks === null;
  const sidecarEmpty = !!(tracks
    && Array.isArray(tracks.tracks) && tracks.tracks.length === 0);
  const shouldKick = (sidecarMissing || sidecarEmpty) && triggerDetCount >= 1;

  if (shouldKick){
    if (_reindexFinalFailed.has(item.event_id)){
      _showReindexBannerError(item);
      lbRenderTrackTimeline(item);
      _lbDrawDetections();
      return;
    }
    if (!_reindexedThisSession.has(item.event_id)){
      _kickReindexFor(item);
    } else if (_reindexInflight.has(item.event_id)){
      _showReindexBannerPending(item);
    }
    lbRenderTrackTimeline(item);
    _lbDrawDetections();
    return;
  }

  if (!_reindexInflight.has(item.event_id)) _hideReindexBanner();

  lbRenderTrackTimeline(item);
  _lbDrawDetections();

  if (!haveAnyTracks){
    _logDiag(
      `event=${item.event_id} render path=legacy `
      + `(no tracks, ${triggerDetCount} trigger dets)`,
      'warn');
  } else {
    _logDiag(
      `event=${item.event_id} render path=tracks `
      + `(${tracks.tracks.length} tracks)`,
      'info');
  }
}

// ── Auto-reindex flow ────────────────────────────────────────────────────

async function _kickReindexFor(item){
  const eid = item.event_id;
  const cam = item.camera_id || '';
  if (!eid) return;
  _reindexedThisSession.add(eid);
  _reindexInflight.add(eid);
  _showReindexBannerPending(item);
  _logDiag(`event=${eid} kicking reindex (camera_id=${cam})`, 'warn');
  try {
    const r = await fetch(
      `/api/tracking/reindex/${encodeURIComponent(eid)}`
      + `?camera_id=${encodeURIComponent(cam)}`,
      { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok){
      _logDiag(
        `event=${eid} reindex POST failed: ${d.error || r.statusText}`,
        'error');
      _failReindex(item);
      return;
    }
  } catch (e) {
    _logDiag(`event=${eid} reindex POST error: ${e?.message || e}`, 'error');
    _failReindex(item);
    return;
  }
  setTimeout(
    () => _retrySidecarFetch(item, 1), _REINDEX_INITIAL_WAIT_MS);
}

async function _retrySidecarFetch(item, attempt){
  const eid = item.event_id;
  if (lbState.item !== item){
    _reindexInflight.delete(eid);
    return;
  }
  lbInvalidateTracks(eid);
  delete item._tracks;
  const tracks = await _fetchTracks(item);
  if (lbState.item !== item){
    _reindexInflight.delete(eid);
    return;
  }
  const haveTracks = !!(tracks
    && Array.isArray(tracks.tracks) && tracks.tracks.length > 0);
  if (haveTracks){
    _logDiag(
      `event=${eid} reindex completed → ${tracks.tracks.length} tracks `
      + `(attempt ${attempt}/${_REINDEX_MAX_RETRIES})`,
      'warn');
    _reindexInflight.delete(eid);
    item._tracks = tracks;
    _hideReindexBanner();
    lbRenderTrackTimeline(item);
    _lbDrawDetections();
    return;
  }
  if (attempt >= _REINDEX_MAX_RETRIES){
    _logDiag(
      `event=${eid} reindex final fail `
      + `(${_REINDEX_MAX_RETRIES} retries exhausted)`,
      'error');
    _failReindex(item);
    return;
  }
  _logDiag(
    `event=${eid} reindex retry ${attempt}/${_REINDEX_MAX_RETRIES} `
    + `(no tracks yet)`,
    'info');
  setTimeout(
    () => _retrySidecarFetch(item, attempt + 1),
    _REINDEX_RETRY_INTERVAL_MS);
}

function _failReindex(item){
  const eid = item.event_id;
  _reindexInflight.delete(eid);
  _reindexFinalFailed.add(eid);
  if (lbState.item === item){
    _showReindexBannerError(item);
    _lbDrawDetections();
  }
}

// ── Reindex banner ───────────────────────────────────────────────────────

function _ensureBanner(){
  let banner = byId('lbTrackingBanner');
  if (banner) return banner;
  const wrap = byId('lightboxMediaWrap');
  if (!wrap) return null;
  _ensureOverlayStyles();
  banner = document.createElement('div');
  banner.id = 'lbTrackingBanner';
  banner.innerHTML = `
    <span class="lbtb-spinner" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none">
        <circle cx="12" cy="12" r="9" stroke="rgba(226,232,240,.25)" stroke-width="2.4"/>
        <path d="M12 3 A9 9 0 0 1 21 12" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>
      </svg>
    </span>
    <span class="lbtb-text">Tracking wird generiert…</span>
    <button type="button" class="lbtb-retry" title="Erneut versuchen" aria-label="Erneut versuchen" hidden>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2.5 8A5.5 5.5 0 0 1 13 5M13.5 8A5.5 5.5 0 0 1 3 11"/>
        <polyline points="12,2 12,5.5 8.5,5.5"/>
        <polyline points="4,14 4,10.5 7.5,10.5"/>
      </svg>
    </button>`;
  wrap.appendChild(banner);
  banner.querySelector('.lbtb-retry').addEventListener('click', _onReindexClick);
  return banner;
}

function _showReindexBannerPending(item){
  const banner = _ensureBanner();
  if (!banner || lbState.item !== item) return;
  banner.classList.remove('lbtb-error');
  banner.querySelector('.lbtb-text').textContent = 'Tracking wird generiert…';
  banner.querySelector('.lbtb-spinner').style.display = '';
  banner.querySelector('.lbtb-retry').hidden = true;
  banner.style.display = 'flex';
  void banner.offsetWidth;
  banner.style.opacity = '1';
}

function _showReindexBannerError(item){
  const banner = _ensureBanner();
  if (!banner || lbState.item !== item) return;
  banner.classList.add('lbtb-error');
  banner.querySelector('.lbtb-text').textContent = 'Tracking nicht verfügbar';
  banner.querySelector('.lbtb-spinner').style.display = 'none';
  banner.querySelector('.lbtb-retry').hidden = false;
  banner.style.display = 'flex';
  void banner.offsetWidth;
  banner.style.opacity = '1';
}

function _hideReindexBanner(){
  const banner = byId('lbTrackingBanner');
  if (!banner) return;
  banner.style.opacity = '0';
  setTimeout(() => {
    if (banner.style.opacity === '0') banner.style.display = 'none';
  }, 250);
}

function _isReindexBannerActive(){
  const eid = lbState.item?.event_id;
  return !!eid && _reindexInflight.has(eid);
}

async function _onReindexClick(ev){
  ev.stopPropagation();
  const item = lbState.item;
  if (!item || !item.event_id) return;
  const btn = ev.currentTarget;
  btn.disabled = true;
  btn.style.opacity = '.5';
  _reindexFinalFailed.delete(item.event_id);
  try {
    const r = await fetch(
      `/api/tracking/reindex/${encodeURIComponent(item.event_id)}`
      + `?camera_id=${encodeURIComponent(item.camera_id || '')}`,
      { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok){
      showToast(
        'Tracking-Re-Index fehlgeschlagen: ' + (d.error || r.statusText),
        'error');
      _logDiag(
        `event=${item.event_id} manual reindex failed: `
        + `${d.error || r.statusText}`,
        'error');
      return;
    }
    showToast('Tracking neu generiert', 'success');
    lbInvalidateTracks(item.event_id);
    delete item._tracks;
    _reindexInflight.add(item.event_id);
    _showReindexBannerPending(item);
    setTimeout(
      () => _retrySidecarFetch(item, 1),
      _REINDEX_INITIAL_WAIT_MS);
  } catch (e){
    showToast(
      'Tracking-Re-Index fehlgeschlagen: ' + (e.message || e),
      'error');
    _logDiag(
      `event=${item.event_id} manual reindex error: ${e?.message || e}`,
      'error');
  } finally {
    btn.disabled = false;
    btn.style.opacity = '';
  }
}

// ── Drawing ───────────────────────────────────────────────────────────────

function _interpolateTrackAt(track, t){
  const samples = track.samples || [];
  if (!samples.length) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (t < first.t - 0.05) return null;
  if (t > last.t + 0.05) return null;
  let prev = first, next = last;
  for (let i = 0; i < samples.length; i++){
    if (samples[i].t <= t) prev = samples[i];
    if (samples[i].t >= t){ next = samples[i]; break; }
  }
  if (prev === next || next.t === prev.t){
    return { bbox: prev.bbox, score: prev.score, label: track.label };
  }
  const a = (t - prev.t) / (next.t - prev.t);
  const lerp = (k) => prev.bbox[k] + (next.bbox[k] - prev.bbox[k]) * a;
  return {
    bbox: { x1: lerp('x1'), y1: lerp('y1'), x2: lerp('x2'), y2: lerp('y2') },
    score: (prev.source === 'detect' ? prev.score
           : next.source === 'detect' ? next.score
           : track.best_score) ?? 0,
    label: track.label,
  };
}

function _firstSampleOfTrack(track){
  const s = (track.samples || [])[0];
  if (!s) return null;
  return {
    bbox: s.bbox,
    score: s.source === 'detect' ? s.score : (track.best_score ?? 0),
    label: track.label,
  };
}

// Resolve the camera-config object_filter set, or null when unfiltered.
// tracks.json schema≥2 stores filter_applied at write time so this
// matches what the worker actually used; older sidecars + the legacy
// path fall back to the camera's live config.
function _resolveAllowedLabels(){
  const tracks = lbState.item?._tracks;
  if (tracks && Array.isArray(tracks.filter_applied)){
    return new Set(tracks.filter_applied);
  }
  const camId = lbState.item?.camera_id;
  if (camId){
    const cam = (state.cameras || []).find(c => (c.id || '') === camId);
    const of = cam?.object_filter;
    if (Array.isArray(of) && of.length > 0){
      return new Set(of);
    }
  }
  return null;
}

// Combined visibility check — closure read once per render, called
// per track / per detection.
function _makeLabelVisibleFn(){
  const allowed = _resolveAllowedLabels();
  const camId = lbState.item?.camera_id;
  const hidden = _getHiddenClassesForCam(camId);
  return (label) => {
    if (hidden.has(label)) return false;
    return allowed === null || allowed.has(label);
  };
}

export function _lbDrawDetections(){
  const cv = byId('lightboxDetections');
  if (!cv || !lbState.item) return;
  const ctx = cv.getContext('2d');
  const videoEl = byId('lightboxVideo');
  const imgEl = byId('lightboxImg');
  const usingVideo = videoEl && videoEl.style.display !== 'none' && videoEl.videoWidth > 0;
  const usingImage = imgEl && imgEl.style.display !== 'none' && imgEl.naturalWidth > 0;
  const media = usingVideo ? videoEl : (usingImage ? imgEl : null);
  if (!media){ _lbClearDetections(); return; }
  const natW = usingVideo ? videoEl.videoWidth : imgEl.naturalWidth;
  const natH = usingVideo ? videoEl.videoHeight : imgEl.naturalHeight;
  const wrap = byId('lightboxMediaWrap');
  if (!wrap) return;
  const wrapRect = wrap.getBoundingClientRect();
  const mediaRect = media.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cv.style.width = wrapRect.width + 'px';
  cv.style.height = wrapRect.height + 'px';
  cv.width  = Math.round(wrapRect.width * dpr);
  cv.height = Math.round(wrapRect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, wrapRect.width, wrapRect.height);

  const scale = Math.min(mediaRect.width / natW, mediaRect.height / natH);
  const renderedW = natW * scale, renderedH = natH * scale;
  const offX = (mediaRect.width - renderedW) / 2 + (mediaRect.left - wrapRect.left);
  const offY = (mediaRect.height - renderedH) / 2 + (mediaRect.top - wrapRect.top);

  const tracks = lbState.item._tracks;
  const haveTracks = tracks && Array.isArray(tracks.tracks) && tracks.tracks.length > 0;
  const isVisible = _makeLabelVisibleFn();

  ctx.font = '600 12px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  ctx.textBaseline = 'top';

  if (haveTracks){
    const t = usingVideo ? (videoEl.currentTime || 0) : null;
    for (const tr of tracks.tracks){
      if (!isVisible(tr.label)) continue;
      const sample = (t == null)
        ? _firstSampleOfTrack(tr)
        : _interpolateTrackAt(tr, t);
      if (!sample) continue;
      _drawTrackBox(ctx, sample, tr.color, offX, offY, scale);
    }
    return;
  }

  // Legacy single-bbox fallback. The bbox is the trigger-frame
  // detection — without per-frame tracks it would visually lie about
  // where the subject is during playback. We suppress entirely while
  // the reindex banner is showing (so the user doesn't stare at a
  // stationary mis-positioned box for 17 s) and during active
  // playback. Pause / ended / still-image modes paint the box back at
  // the trigger position; the previous "Detection bei Auslösung" pill
  // was retired with the timeline panel landing — the box is now its
  // own statement.
  if (_isReindexBannerActive()) return;

  const isPlaying = usingVideo && !videoEl.paused && !videoEl.ended
                    && (videoEl.currentTime || 0) > 0.05;
  if (isPlaying) return;

  const dets = (lbState.item.detections || [])
    .filter(d => d && d.bbox && typeof d.bbox.x1 === 'number')
    .filter(d => isVisible(d.label));
  if (!dets.length) return;
  for (const d of dets){
    const c = colors[d.label] || colors.unknown;
    _drawTrackBox(ctx, { bbox: d.bbox, score: d.score, label: d.label },
                  c, offX, offY, scale);
  }
}

function _drawTrackBox(ctx, sample, color, offX, offY, scale){
  const b = sample.bbox;
  const x1 = offX + b.x1 * scale, y1 = offY + b.y1 * scale;
  const x2 = offX + b.x2 * scale, y2 = offY + b.y2 * scale;
  const w = x2 - x1, h = y2 - y1;
  if (w <= 0 || h <= 0) return;
  const c = color || '#22c55e';
  ctx.strokeStyle = c;
  ctx.lineWidth = 2;
  ctx.strokeRect(x1, y1, w, h);
  const lblName = OBJ_LABEL[sample.label] || sample.label || '';
  if (!lblName) return;
  const pct = sample.score != null ? Math.round(sample.score * 100) : null;
  const text = pct != null ? `${lblName} · ${pct}%` : lblName;
  const padX = 6, pillH = 18;
  const tw = ctx.measureText(text).width;
  const pillY = Math.max(0, y1 - pillH - 2);
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(x1, pillY, tw + padX * 2, pillH);
  ctx.fillStyle = c;
  ctx.fillText(text, x1 + padX, pillY + 3);
}

// ── Playback RAF loop ────────────────────────────────────────────────────

function _stopRafLoop(){
  if (_rafHandle){
    cancelAnimationFrame(_rafHandle);
    _rafHandle = 0;
  }
}

function _startRafLoop(){
  _stopRafLoop();
  const tick = () => {
    _rafHandle = 0;
    if (!lbState.item || !lbState.item._tracks) return;
    const v = byId('lightboxVideo');
    if (!v || v.paused || v.ended) return;
    if (byId('lightboxModal')?.classList.contains('hidden')) return;
    _lbDrawDetections();
    _renderPlayCursor();
    _rafHandle = requestAnimationFrame(tick);
  };
  _rafHandle = requestAnimationFrame(tick);
}

// ── Banner + timeline styles ─────────────────────────────────────────────
// Single style block for the auto-reindex banner. The track timeline
// panel itself lives in 30-lightbox-video.css — this only owns the
// banner because it sits inside #lightboxMediaWrap and needs its own
// z-stack rules independent of the bottom-panel layout.
function _ensureOverlayStyles(){
  if (document.querySelector('#lbTrackingChipStyles')) return;
  const s = document.createElement('style');
  s.id = 'lbTrackingChipStyles';
  s.textContent = `
    #lbTrackingBanner{position:absolute;left:14px;bottom:18px;z-index:5;
      display:none;align-items:center;gap:8px;padding:6px 10px 6px 8px;
      border-radius:14px;background:rgba(8,18,28,.78);color:#e2e8f0;
      font-size:12px;font-weight:600;letter-spacing:.01em;
      backdrop-filter:blur(8px);opacity:0;transition:opacity .25s ease;
      pointer-events:auto;max-width:min(320px,72vw)}
    #lbTrackingBanner.lbtb-error{background:rgba(75,28,28,.78);color:#fecaca}
    #lbTrackingBanner .lbtb-spinner{
      display:inline-flex;align-items:center;justify-content:center;
      width:16px;height:16px;flex-shrink:0;
      animation:lbtb-spin 1.1s linear infinite}
    #lbTrackingBanner .lbtb-text{
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #lbTrackingBanner .lbtb-retry{
      background:none;border:none;color:rgba(254,202,202,.95);cursor:pointer;
      padding:0;margin:-6px -4px -6px 4px;border-radius:10px;
      display:inline-flex;align-items:center;justify-content:center;
      min-width:36px;min-height:36px;-webkit-tap-highlight-color:transparent}
    #lbTrackingBanner .lbtb-retry:hover{background:rgba(255,255,255,.10)}
    @keyframes lbtb-spin{to{transform:rotate(360deg)}}
    @media (max-width:480px){
      #lbTrackingBanner .lbtb-retry{min-width:44px;min-height:44px;margin:-9px -6px -9px 4px}
    }
  `;
  document.head.appendChild(s);
}

// ── Track timeline panel ─────────────────────────────────────────────────
// Bottom-of-lightbox component: one row per class with ≥1 track. Each
// row renders a class badge (toggle button) + a strip with per-track
// bars. Bars carry the track's per-clip number (#1, #2, …) and a red
// × marker when the track ended before video duration. Tap a bar to
// seek the video; tap the badge to hide that class's bboxes.

let _timelineDuration = 0; // seconds — captured at render so play
                           // cursor positioning doesn't have to read
                           // videoEl.duration on every tick.

export function lbClearTrackTimeline(){
  const host = byId('lightboxTrackTimeline');
  if (!host) return;
  host.innerHTML = '';
}

export function lbRenderTrackTimeline(item){
  const host = byId('lightboxTrackTimeline');
  if (!host) return;
  // Hidden by default in the photo branch (CSS); only shown when the
  // full-screen video chrome is on. We still render content so a mid-
  // session reopen has the markup ready.
  if (!item){ host.innerHTML = ''; return; }
  if (item.type === 'timelapse'){ host.innerHTML = ''; return; }
  const tracks = item._tracks;
  const haveTracks = !!(tracks
    && Array.isArray(tracks.tracks) && tracks.tracks.length > 0);
  if (!haveTracks){
    host.innerHTML = `<div class="lbtt-empty">Keine Track-Daten — erscheinen sobald die Indexierung fertig ist.</div>`;
    return;
  }

  // Camera-side allowed-labels filter (same as the canvas render
  // path). Only classes that pass the filter get a row; hidden-classes
  // are still rendered as a row (with the badge dimmed) so the user
  // can re-enable them.
  const allowed = _resolveAllowedLabels();
  const camId = item.camera_id || '';
  const hidden = _getHiddenClassesForCam(camId);

  // Estimate duration from the tracks' max sample timestamp when the
  // video isn't loaded yet. The actual duration takes over once
  // loadedmetadata fires; bars rescale automatically because we
  // re-render on every loadedmetadata in the lightbox open path.
  const videoEl = byId('lightboxVideo');
  const vidDur = Number.isFinite(videoEl?.duration) && videoEl.duration > 0
    ? videoEl.duration : 0;
  let maxT = 0;
  for (const tr of tracks.tracks){
    for (const sm of (tr.samples || [])){
      if (sm.t > maxT) maxT = sm.t;
    }
  }
  const duration = vidDur || maxT || 1;
  _timelineDuration = duration;

  // Group tracks by label, deterministic OBJ_LABEL order so layout is
  // stable across re-opens. Per-clip counter (#1, #2…) reflects the
  // order tracks appear in the sidecar.
  const byLabel = new Map();
  let perClipNum = 0;
  for (const tr of tracks.tracks){
    perClipNum++;
    const lbl = tr.label || 'unknown';
    if (allowed !== null && !allowed.has(lbl)) continue;
    if (!byLabel.has(lbl)) byLabel.set(lbl, []);
    byLabel.get(lbl).push({ ...tr, _num: perClipNum });
  }
  const orderedLabels = Object.keys(OBJ_LABEL)
    .filter(l => byLabel.has(l));
  // Catch-all for unknown classes the OBJ_LABEL map doesn't know.
  for (const l of byLabel.keys()){
    if (!orderedLabels.includes(l)) orderedLabels.push(l);
  }

  if (orderedLabels.length === 0){
    host.innerHTML = `<div class="lbtt-empty">Alle Klassen vom Filter ausgeschlossen.</div>`;
    return;
  }

  const rowsHtml = orderedLabels.map(lbl => {
    const c = colors[lbl] || colors.unknown;
    const labelText = OBJ_LABEL[lbl] || lbl;
    const rawSvg = OBJ_SVG[lbl] || OBJ_SVG.alarm || '';
    const avatarSvg = rawSvg.replace('width="16" height="16"', 'width="14" height="14"');
    const isOn = !hidden.has(lbl);
    const trs = byLabel.get(lbl) || [];
    const barsHtml = trs.map(tr => {
      const samples = tr.samples || [];
      if (!samples.length) return '';
      const t0 = samples[0].t;
      const t1 = samples[samples.length - 1].t;
      const left = Math.max(0, (t0 / duration) * 100);
      const width = Math.max(0.5, ((t1 - t0) / duration) * 100);
      const endedEarly = (duration - t1) > 0.4;
      const endRight = Math.max(0, ((duration - t1) / duration) * 100);
      const tt = `Track #${tr._num} · ${t0.toFixed(1)}s → ${t1.toFixed(1)}s`;
      return `<button type="button" class="lbtt-bar" data-seek="${t0.toFixed(3)}" title="${tt}" aria-label="${tt}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;background:${c}">
        <span class="lbtt-bar-num" style="color:${c}">#${tr._num}</span>
        ${endedEarly ? `<span class="lbtt-bar-end" style="right:-${endRight.toFixed(2)}%">×</span>` : ''}
      </button>`;
    }).join('');
    return `
      <div class="lbtt-row" data-on="${isOn ? '1' : '0'}">
        <button type="button" class="lbtt-badge" data-label="${lbl}" data-on="${isOn ? '1' : '0'}" aria-label="Klasse ein/aus" title="Klasse ein/aus">
          <span class="lbtt-avatar" style="--c:${c}">${avatarSvg}</span>
          <span class="lbtt-name">${labelText}</span>
        </button>
        <div class="lbtt-strip" data-label="${lbl}">${barsHtml}</div>
      </div>`;
  }).join('');

  // Tick row — 4 evenly-spaced labels in mono "0s / 10s / 20s / 30s",
  // scaled to the actual clip duration. We position them absolutely
  // inside the strip area so they line up with the rows above.
  const ticksHtml = (() => {
    const N = 4;
    let parts = '';
    for (let i = 0; i < N; i++){
      const tSec = (duration * i) / (N - 1);
      const pct = (i / (N - 1)) * 100;
      parts += `<span class="lbtt-tick" style="left:calc(${pct.toFixed(2)}% - ${i === 0 ? 0 : i === N - 1 ? 24 : 12}px)">${tSec.toFixed(0)}s</span>`;
    }
    return parts;
  })();

  // Note: the play cursor is no longer rendered inside the timeline
  // panel — the unified #lightboxPlayCursor in #lightboxBottomStack
  // sweeps top-to-bottom across the whole video stack and is owned
  // by _renderPlayCursor() / _wireCursorDrag() below.
  host.innerHTML = `
    <div class="lbtt-rows">${rowsHtml}</div>
    <div class="lbtt-ticks">${ticksHtml}</div>`;

  // Wire the badge clicks (toggle hidden) + bar clicks (seek video).
  host.querySelectorAll('.lbtt-badge').forEach(btn => {
    btn.addEventListener('click', _onTimelineBadgeClick);
  });
  host.querySelectorAll('.lbtt-bar').forEach(btn => {
    btn.addEventListener('click', _onTimelineBarClick);
  });
  // Reset the cursor to currentTime in case the video has loaded
  // metadata before this render.
  _renderPlayCursor();
}

function _onTimelineBadgeClick(ev){
  ev.stopPropagation();
  const btn = ev.currentTarget;
  const lbl = btn.dataset.label;
  const camId = lbState.item?.camera_id;
  if (!lbl || !camId) return;
  const hidden = _getHiddenClassesForCam(camId);
  if (hidden.has(lbl)) hidden.delete(lbl);
  else hidden.add(lbl);
  _setHiddenClassesForCam(camId, hidden);
  // Update visual on the row + redraw canvas.
  const isOn = !hidden.has(lbl);
  btn.dataset.on = isOn ? '1' : '0';
  const row = btn.closest('.lbtt-row');
  if (row) row.dataset.on = isOn ? '1' : '0';
  _lbDrawDetections();
}

function _onTimelineBarClick(ev){
  ev.stopPropagation();
  const btn = ev.currentTarget;
  const t = parseFloat(btn.dataset.seek || '0');
  if (!Number.isFinite(t)) return;
  const v = byId('lightboxVideo');
  if (!v) return;
  const dur = Number.isFinite(v.duration) ? v.duration : 0;
  if (dur <= 0) return;
  v.currentTime = Math.min(dur, Math.max(0, t));
  if (v.paused) v.play().catch(() => {});
}

// ── Unified play cursor + drag-to-scrub ──────────────────────────────────
// Single 1 px white line in #lightboxPlayCursor (sibling of scrubber +
// media wrap + timeline inside #lightboxBottomStack). Position is
// anchored to the timeline strip's coordinate system so bars and
// cursor agree on x for the same time-point. The 16 px wide invisible
// hit-area sibling drives drag-to-scrub via Pointer Events; tap-to-
// seek on a timeline bar still works because bars sit outside the
// 16 px column at a higher z than the cursor's pointer-events:none
// line.

let _cursorDragWired = false;
let _cursorDragWasPlaying = false;

function _renderPlayCursor(){
  const cursor = byId('lightboxPlayCursor');
  if (!cursor || cursor.hidden) return;
  const stack = byId('lightboxBottomStack');
  const v = byId('lightboxVideo');
  if (!stack || !v) return;
  const dur = _timelineDuration > 0 ? _timelineDuration
    : (Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0);
  if (dur <= 0){
    // Without duration we can't position the cursor meaningfully —
    // hide it entirely so the user doesn't see a stray vertical line
    // while the video is still loading metadata.
    cursor.style.opacity = '0';
    return;
  }
  const cur = Number.isFinite(v.currentTime) ? v.currentTime : 0;
  const pct = Math.min(1, Math.max(0, cur / dur));
  // Anchor to the timeline strip's coordinate system: read the first
  // strip's left edge + width relative to the stack so the cursor
  // aligns with the bars (which use the same percentage axis). Falls
  // back to a stack-relative span when the timeline isn't rendered
  // yet (e.g. tracks-loading state, timelapse with no panel).
  const tlHost = byId('lightboxTrackTimeline');
  const stackRect = stack.getBoundingClientRect();
  let stripLeftPx = 0;
  let stripWidthPx = stackRect.width;
  if (tlHost && !tlHost.hidden){
    const firstStrip = tlHost.querySelector('.lbtt-strip');
    if (firstStrip){
      const stripRect = firstStrip.getBoundingClientRect();
      stripLeftPx = stripRect.left - stackRect.left;
      stripWidthPx = stripRect.width;
    }
  }
  if (stripWidthPx <= 0){
    cursor.style.opacity = '0';
    return;
  }
  const xPx = stripLeftPx + pct * stripWidthPx;
  cursor.style.left = `${xPx.toFixed(1)}px`;
  cursor.style.opacity = '1';
  _wireCursorDrag();
}

// Drag-to-scrub handlers on the cursor's hit area. Wired once per
// session — the listeners stay attached even when the cursor is
// hidden (idempotent, no-op when there's no active video).
function _wireCursorDrag(){
  if (_cursorDragWired) return;
  const cursor = byId('lightboxPlayCursor');
  if (!cursor) return;
  const hit = cursor.querySelector('.lbpc-hit');
  if (!hit) return;
  _cursorDragWired = true;

  const _xToTime = (clientX) => {
    const stack = byId('lightboxBottomStack');
    const tlHost = byId('lightboxTrackTimeline');
    const v = byId('lightboxVideo');
    if (!stack || !v) return null;
    const dur = Number.isFinite(v.duration) && v.duration > 0
      ? v.duration : 0;
    if (dur <= 0) return null;
    const stackRect = stack.getBoundingClientRect();
    let stripLeftPx = 0;
    let stripWidthPx = stackRect.width;
    if (tlHost && !tlHost.hidden){
      const firstStrip = tlHost.querySelector('.lbtt-strip');
      if (firstStrip){
        const stripRect = firstStrip.getBoundingClientRect();
        stripLeftPx = stripRect.left - stackRect.left;
        stripWidthPx = stripRect.width;
      }
    }
    if (stripWidthPx <= 0) return null;
    const xLocal = clientX - stackRect.left - stripLeftPx;
    const pct = Math.min(1, Math.max(0, xLocal / stripWidthPx));
    return pct * dur;
  };

  hit.addEventListener('pointerdown', (ev) => {
    const v = byId('lightboxVideo');
    if (!v || !v.src) return;
    ev.preventDefault();
    try { hit.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    _cursorDragWasPlaying = !v.paused && !v.ended;
    if (_cursorDragWasPlaying) v.pause();
    const t = _xToTime(ev.clientX);
    if (t != null){ v.currentTime = t; }
  });
  hit.addEventListener('pointermove', (ev) => {
    if (!hit.hasPointerCapture(ev.pointerId)) return;
    const v = byId('lightboxVideo');
    if (!v) return;
    const t = _xToTime(ev.clientX);
    if (t != null){ v.currentTime = t; }
  });
  const _release = (ev) => {
    if (hit.hasPointerCapture(ev.pointerId)){
      try { hit.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
    }
    if (_cursorDragWasPlaying){
      const v = byId('lightboxVideo');
      v?.play().catch(() => {});
    }
    _cursorDragWasPlaying = false;
  };
  hit.addEventListener('pointerup', _release);
  hit.addEventListener('pointercancel', _release);
}

// ── Settings chip + panel (Stage 31) ─────────────────────────────────────
// item.recording_settings is captured by _finalize_motion_clip at the
// time of the recording so each event carries the exact thresholds /
// filters / cadence it was shot under. Lightbox renders a compact
// chip with the gist + a tappable panel for the full breakdown.
// Pre-existing events (no key) get a muted "ältere Aufnahme" line.

const _SETTINGS_KEY_LABELS = {
  conf_thresh_general:           'Schwelle (allgemein)',
  conf_thresh_per_class:         'Schwelle pro Klasse',
  object_filter:                 'Objekt-Filter',
  confirm_n:                     'Bestätigung Treffer',
  confirm_seconds:               'Bestätigung Sekunden',
  sample_interval_ms:            'Abtast-Intervall',
  motion_pretrigger_sensitivity: 'Pretrigger-Empfindlichkeit',
  post_motion_seconds:           'Nachlauf',
  mode:                          'Modus',
};

function _fmtSettingsValue(key, val){
  if (val == null) return '—';
  if (key === 'conf_thresh_general'){
    return `${Math.round(parseFloat(val) * 100)} %`;
  }
  if (key === 'conf_thresh_per_class'){
    if (typeof val !== 'object' || Object.keys(val).length === 0) return '—';
    return Object.entries(val)
      .map(([k, v]) => `${OBJ_LABEL[k] || k} ${Math.round(parseFloat(v) * 100)} %`)
      .join(', ');
  }
  if (key === 'object_filter'){
    if (!Array.isArray(val) || val.length === 0) return 'keiner (alle Klassen)';
    return val.map(l => OBJ_LABEL[l] || l).join(', ');
  }
  if (key === 'confirm_n')           return `${val} ×`;
  if (key === 'confirm_seconds')     return `${val} s`;
  if (key === 'sample_interval_ms')  return `${val} ms`;
  if (key === 'motion_pretrigger_sensitivity') return `${val} %`;
  if (key === 'post_motion_seconds'){
    return val > 0 ? `${val} s` : 'Standard';
  }
  return String(val);
}

function _buildSettingsChipText(rs){
  // "Settings · Schwelle 65 % · 3 ⁄ 5 s · Person, Katze"
  const parts = ['Settings'];
  if (rs.conf_thresh_general != null){
    parts.push(`Schwelle ${Math.round(parseFloat(rs.conf_thresh_general) * 100)} %`);
  }
  if (rs.confirm_n != null && rs.confirm_seconds != null){
    parts.push(`${rs.confirm_n} ⁄ ${rs.confirm_seconds} s`);
  }
  if (Array.isArray(rs.object_filter) && rs.object_filter.length > 0){
    parts.push(rs.object_filter.map(l => OBJ_LABEL[l] || l).join(', '));
  } else if (rs.object_filter == null){
    parts.push('alle Klassen');
  }
  return parts.join(' · ');
}

export function lbRenderSettingsPanel(item){
  const host = byId('lightboxSettings');
  if (!host) return;
  if (!item || item.type === 'timelapse'){
    host.innerHTML = '';
    return;
  }
  const rs = item.recording_settings;
  if (!rs || typeof rs !== 'object'){
    host.innerHTML = `<div class="lbset-missing">Settings nicht aufgezeichnet · ältere Aufnahme</div>`;
    return;
  }
  const chipText = _buildSettingsChipText(rs);
  // Order matters — use _SETTINGS_KEY_LABELS keys to preserve a
  // consistent layout regardless of which fields the recording
  // happened to capture.
  const panelRows = [];
  for (const key of Object.keys(_SETTINGS_KEY_LABELS)){
    if (!Object.prototype.hasOwnProperty.call(rs, key)) continue;
    const label = _SETTINGS_KEY_LABELS[key];
    const value = _fmtSettingsValue(key, rs[key]);
    panelRows.push(
      `<div class="lbset-key">${label}</div><div class="lbset-val">${value}</div>`
    );
  }
  host.innerHTML = `
    <button type="button" class="lbset-chip" aria-expanded="false" aria-controls="lightboxSettingsPanel" title="Settings ein-/ausklappen">
      <span class="lbset-chip-text">${chipText}</span>
      <span class="lbset-chip-chevron" aria-hidden="true">
        <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5l3 3 3-3"/></svg>
      </span>
    </button>
    <div class="lbset-panel" id="lightboxSettingsPanel" hidden>${panelRows.join('')}</div>`;
  const chip = host.querySelector('.lbset-chip');
  const panel = host.querySelector('.lbset-panel');
  if (chip && panel){
    chip.addEventListener('click', () => {
      const open = !panel.hidden;
      panel.hidden = open;
      chip.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
  }
}

// ── Public cleanup ───────────────────────────────────────────────────────

// Stop the loop and hide the banner + timeline — called from
// closeLightbox via the window bridge so legacy.js doesn't have to
// know about RAF state.
export function lbStopTrackingPlayback(){
  _stopRafLoop();
  const banner = byId('lbTrackingBanner');
  if (banner){
    banner.style.opacity = '0';
    banner.style.display = 'none';
  }
  // Timeline panel is hidden by the lightbox.js teardown via the
  // [hidden] attribute on #lightboxTrackTimeline; its content stays
  // until the next render so re-opening the same item doesn't flash
  // an empty panel.
}
window.lbStopTrackingPlayback = lbStopTrackingPlayback;

// ── Self-bound listeners ─────────────────────────────────────────────────
(function _initLbDetectionsHooks(){
  const imgEl = byId('lightboxImg');
  const videoEl = byId('lightboxVideo');
  if (imgEl) imgEl.addEventListener('load', () => _lbDrawDetections());
  if (videoEl){
    videoEl.addEventListener('loadedmetadata', () => {
      // The duration just became known — re-render the timeline so
      // bars rescale from the (possibly approximate) maxT estimate to
      // the real clip duration.
      if (lbState.item) lbRenderTrackTimeline(lbState.item);
      _lbDrawDetections();
    });
    videoEl.addEventListener('play',     () => { _startRafLoop(); _lbDrawDetections(); });
    videoEl.addEventListener('playing',  () => { _startRafLoop(); _lbDrawDetections(); });
    videoEl.addEventListener('pause',    () => { _stopRafLoop(); _lbDrawDetections(); _renderPlayCursor(); });
    videoEl.addEventListener('ended',    () => { _stopRafLoop(); _lbDrawDetections(); _renderPlayCursor(); });
    videoEl.addEventListener('seeked',   () => { _lbDrawDetections(); _renderPlayCursor(); });
    videoEl.addEventListener('timeupdate', () => {
      _renderPlayCursor();
      if (!_rafHandle) _lbDrawDetections();
    });
  }
  let _raf = 0;
  const _scheduleRedraw = () => {
    if (!byId('lightboxModal') || byId('lightboxModal').classList.contains('hidden')) return;
    cancelAnimationFrame(_raf);
    _raf = requestAnimationFrame(() => { _lbDrawDetections(); _renderPlayCursor(); });
  };
  window.addEventListener('resize', _scheduleRedraw);
  const _wrap = byId('lightboxMediaWrap');
  if (_wrap && 'ResizeObserver' in window){
    const obs = new ResizeObserver(_scheduleRedraw);
    obs.observe(_wrap);
  }
  // Same observer on the timeline host so the cursor stays anchored
  // when the bottom panel reflows (orientation change, soft keyboard).
  const _tlHost = byId('lightboxTrackTimeline');
  if (_tlHost && 'ResizeObserver' in window){
    const obs = new ResizeObserver(() => _renderPlayCursor());
    obs.observe(_tlHost);
  }
})();
