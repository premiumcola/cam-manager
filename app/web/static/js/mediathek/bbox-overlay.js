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
  // Kick the meter the moment tracks land. The RAF loop normally
  // updates it, but on a paused / pre-play video the loop hasn't
  // started yet — without this, the user sees no meter until they
  // hit play even though a track might already be active at t=0.
  _renderConfidenceMeter();

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
    _renderConfidenceMeter();
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

// Snapshot of the current item's tracks array so the × tooltip can
// reach the full track payload by data-track-idx without re-fetching
// tracks.json. Updated on every lbRenderTrackTimeline() call.
let _timelineTrackIndex = [];

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
  // Keep a stable per-clip index map so the × tooltip can find the
  // full track object by element data-attribute. Track sample arrays
  // can be large (samples × bbox dicts); stuffing them onto the DOM
  // via data-* JSON would bloat innerHTML for every render.
  _timelineTrackIndex = tracks.tracks;

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
      const idx = tr._num - 1;
      return `<button type="button" class="lbtt-bar" data-seek="${t0.toFixed(3)}" title="${tt}" aria-label="${tt}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;background:${c}">
        <span class="lbtt-bar-num" style="color:${c}">#${tr._num}</span>
        ${endedEarly ? `<span class="lbtt-bar-end" data-track-idx="${idx}" data-track-num="${tr._num}" tabindex="0" role="button" aria-label="Track #${tr._num} verloren" style="right:-${endRight.toFixed(2)}%">×</span>` : ''}
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
  _wireBarEndTooltips(host);
  // Reset the cursor to currentTime in case the video has loaded
  // metadata before this render.
  _renderPlayCursor();
}

// ── Track-loss × tooltip ─────────────────────────────────────────────────
// Singleton popover element, lifted from the erk-sim/timeline.js pattern.
// Each × marker on the timeline carries data-track-idx so the handler
// can fetch the full track entry from _timelineTrackIndex without
// re-parsing tracks.json. Tooltip content explains WHY the track
// stopped (Konfidenz drop / Klassenfilter / Bbox / Timeout), pulling
// the comparison values from item.recording_settings.

const _END_REASON_LABEL = {
  conf_drop:       'Konfidenz unter Schwelle gefallen',
  class_filter:    'Klasse aus Filter entfernt',
  bbox_too_small:  'Bbox unter Mindestgröße',
  timeout:         'Tracker verloren · keine Detektion',
  ended_at_clip:   'Spielzeit-Ende erreicht',
};

// Per-class minimum bbox floors — mirrors detectors/coral_object.py's
// _LABEL_MIN_BBOX so the tooltip can flag "below floor" without an
// extra API call. Add classes here when the backend grows new
// per-label floors.
const _BBOX_FLOORS = {
  person: { min_h_frac: 0.15, min_area_frac: 0.02 },
};

let _barEndTipEl = null;

function _ensureBarEndTip(){
  if (_barEndTipEl) return _barEndTipEl;
  _barEndTipEl = document.createElement('div');
  _barEndTipEl.className = 'lbtt-end-tip';
  _barEndTipEl.setAttribute('role', 'tooltip');
  _barEndTipEl.hidden = true;
  document.body.append(_barEndTipEl);
  // Scroll / outside-click dismiss — same lifecycle as the erk-sim
  // tooltip util so the user's muscle memory carries over.
  window.addEventListener('scroll', _hideBarEndTip, { passive: true });
  document.addEventListener('click', (ev) => {
    if (_barEndTipEl?.hidden) return;
    if (ev.target.closest('.lbtt-bar-end')) return;
    if (ev.target.closest('.lbtt-end-tip')) return;
    _hideBarEndTip();
  });
  return _barEndTipEl;
}

function _hideBarEndTip(){
  if (_barEndTipEl) _barEndTipEl.hidden = true;
}

function _buildBarEndTipHtml(track, trackNum, rs){
  const lbl = OBJ_LABEL[track?.label] || track?.label || '?';
  // span = last - first sample time, in seconds, 1-decimal.
  const samples = track?.samples || [];
  const span = (samples.length >= 2)
    ? (parseFloat(samples[samples.length - 1].t) - parseFloat(samples[0].t)).toFixed(1)
    : '0.0';
  const reason = track?.end_reason;
  const summary = reason
    ? (_END_REASON_LABEL[reason] || `Grund: ${reason}`)
    : 'Grund unbekannt — Re-Index empfohlen';
  // Score row — compare last_score against per-class or general thresh.
  let scoreRow = '<span class="lbtt-end-tip-key">Score:</span> <span class="lbtt-end-tip-val">—</span>';
  const lastScore = track?.last_score;
  if (lastScore != null){
    let thresh = rs?.conf_thresh_general ?? null;
    const perCls = rs?.conf_thresh_per_class || {};
    if (Object.prototype.hasOwnProperty.call(perCls, track.label)){
      thresh = perCls[track.label];
    }
    const pct = Math.round(parseFloat(lastScore) * 100);
    const tpct = thresh != null ? Math.round(parseFloat(thresh) * 100) : null;
    const op = tpct != null ? (pct < tpct ? '<' : '≥') : '·';
    const tone = tpct != null && pct < tpct ? 'is-bad' : 'is-ok';
    scoreRow = `<span class="lbtt-end-tip-key">Score:</span> <span class="lbtt-end-tip-val ${tone}">${pct} %${tpct != null ? ` ${op} ${tpct} %` : ''}</span>`;
  }
  // Bbox row — compare last_bbox_size + frac against the per-class floor.
  let bboxRow = '<span class="lbtt-end-tip-key">Bbox:</span> <span class="lbtt-end-tip-val">—</span>';
  const lbs = track?.last_bbox_size_px;
  if (Array.isArray(lbs) && lbs.length === 2){
    const floors = _BBOX_FLOORS[track.label];
    let bad = false;
    if (floors){
      const fh = track?.last_bbox_frac_h ?? 0;
      const fa = track?.last_bbox_frac_area ?? 0;
      if (fh < floors.min_h_frac || fa < floors.min_area_frac) bad = true;
    }
    const tone = bad ? 'is-bad' : 'is-ok';
    const tick = bad ? '✗' : '✓';
    bboxRow = `<span class="lbtt-end-tip-key">Bbox:</span> <span class="lbtt-end-tip-val ${tone}">${lbs[0]} × ${lbs[1]} px ${tick}</span>`;
  }
  // Class row — green ✓ if class is in the active filter (or filter
  // is null), red ✗ if filter is non-null and excludes the class.
  let classRow = `<span class="lbtt-end-tip-key">Klasse:</span> <span class="lbtt-end-tip-val">${lbl}</span>`;
  const objFilter = rs?.object_filter;
  if (objFilter != null && Array.isArray(objFilter)){
    const ok = objFilter.includes(track.label);
    const tone = ok ? 'is-ok' : 'is-bad';
    const tick = ok ? '✓' : '✗';
    classRow = `<span class="lbtt-end-tip-key">Klasse:</span> <span class="lbtt-end-tip-val ${tone}">${lbl} ${tick}</span>`;
  }
  return `
    <div class="lbtt-end-tip-title">× Track #${trackNum} verloren · ${span} s</div>
    <div class="lbtt-end-tip-row">${scoreRow}</div>
    <div class="lbtt-end-tip-row">${bboxRow}</div>
    <div class="lbtt-end-tip-row">${classRow}</div>
    <div class="lbtt-end-tip-summary">${summary}</div>`;
}

function _showBarEndTip(target){
  const idx = parseInt(target?.dataset?.trackIdx ?? '', 10);
  const trackNum = parseInt(target?.dataset?.trackNum ?? '', 10);
  if (!Number.isFinite(idx) || !Number.isFinite(trackNum)) return;
  const track = _timelineTrackIndex[idx];
  if (!track) return;
  const rs = lbState.item?.recording_settings || {};
  const tip = _ensureBarEndTip();
  tip.innerHTML = _buildBarEndTipHtml(track, trackNum, rs);
  tip.hidden = false;
  // Position above the × when there's vertical room, otherwise below.
  // Clamped horizontally to the viewport so the tip never gets cropped
  // at the iPhone-393 edge.
  const r = target.getBoundingClientRect();
  const tipR = tip.getBoundingClientRect();
  const above = r.top - tipR.height - 8;
  const top = above >= 8 ? above : r.bottom + 8;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  let left = r.left + r.width / 2 - tipR.width / 2;
  left = Math.max(8, Math.min(vw - tipR.width - 8, left));
  tip.style.top = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
}

function _wireBarEndTooltips(host){
  // Idempotent: per-render flag avoids re-binding for every re-render.
  if (host.dataset.barEndTipWired === '1') return;
  host.dataset.barEndTipWired = '1';
  host.addEventListener('pointerover', (ev) => {
    const x = ev.target.closest('.lbtt-bar-end');
    if (x) _showBarEndTip(x);
  });
  host.addEventListener('pointerout', (ev) => {
    if (!host.contains(ev.relatedTarget)) _hideBarEndTip();
  });
  host.addEventListener('click', (ev) => {
    const x = ev.target.closest('.lbtt-bar-end');
    if (!x){ _hideBarEndTip(); return; }
    // Don't bubble to the .lbtt-bar seek handler — × is its own UX.
    ev.preventDefault(); ev.stopPropagation();
    if (_barEndTipEl && !_barEndTipEl.hidden
        && _barEndTipEl.dataset.activeFor === x.dataset.trackIdx){
      _hideBarEndTip();
      return;
    }
    _showBarEndTip(x);
    if (_barEndTipEl) _barEndTipEl.dataset.activeFor = x.dataset.trackIdx;
  });
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

// ── Live confidence meter (overlaid on the video) ────────────────────────
// Bottom-left pill that ticks per-gate confidence for every track
// active at videoEl.currentTime. Each row renders one of three gates
// (Score / Bbox-Höhe / Bbox-Fläche) with a 3 px bar + a 1 px white
// tick at the threshold and the threshold percent above the tick.
// Driven by _interpolateTrackAt so the bars move continuously across
// the clip; hidden entirely when no track is active.

function _ensureConfidenceMeter(){
  let host = byId('lightboxConfidenceMeter');
  if (host) return host;
  const wrap = byId('lightboxMediaWrap');
  if (!wrap) return null;
  host = document.createElement('div');
  host.id = 'lightboxConfidenceMeter';
  host.hidden = true;
  wrap.appendChild(host);
  return host;
}

function _findActiveTracksAt(currentTime){
  const tracks = lbState.item?._tracks?.tracks || [];
  const out = [];
  for (let i = 0; i < tracks.length; i++){
    const tr = tracks[i];
    const sample = _interpolateTrackAt(tr, currentTime);
    if (!sample) continue;
    out.push({ track: tr, sample, num: i + 1 });
  }
  return out;
}

function _buildMeterRow(label, valFrac, thresholdFrac, color){
  // Both values are 0..1. Bar maps the value to width%; tick to
  // (threshold * 100)%. The threshold-pct rendered above the tick is
  // the integer percent for a stable mono-width readout.
  const valPct = Math.min(100, Math.max(0, valFrac * 100));
  const tickPct = Math.min(100, Math.max(0, (thresholdFrac ?? 0) * 100));
  const tickNum = Math.round(tickPct);
  const showPct = Math.round(valPct);
  return `
    <div class="lbcm-row">
      <div class="lbcm-row-head">
        <span class="lbcm-row-label">${label}</span>
        <span class="lbcm-row-pct">${showPct} %</span>
      </div>
      <div class="lbcm-row-bar">
        <span class="lbcm-row-fill" style="width:${valPct.toFixed(1)}%;background:${color}"></span>
        ${thresholdFrac != null
          ? `<span class="lbcm-row-tick" style="left:${tickPct.toFixed(1)}%"></span>
             <span class="lbcm-row-tick-num" style="left:${tickPct.toFixed(1)}%">${tickNum}</span>`
          : ''}
      </div>
    </div>`;
}

function _renderConfidenceMeter(){
  const v = byId('lightboxVideo');
  const host = _ensureConfidenceMeter();
  if (!host || !v || !lbState.item){
    if (host) host.hidden = true;
    return;
  }
  // Only paint in full-screen video mode — photo events / timelapse
  // shouldn't see this pill at all.
  if (!byId('lightboxModal')?.classList.contains('lb-fs-video')){
    host.hidden = true;
    return;
  }
  const t = Number.isFinite(v.currentTime) ? v.currentTime : 0;
  const active = _findActiveTracksAt(t);
  if (active.length === 0){
    host.hidden = true;
    return;
  }
  const rs = lbState.item.recording_settings || {};
  const natW = v.videoWidth || 1;
  const natH = v.videoHeight || 1;
  const MAX_SHOW = 2;
  const shown = active.slice(0, MAX_SHOW);
  const overflow = active.length - shown.length;

  const blocks = shown.map(({ track, sample, num }) => {
    const lbl = OBJ_LABEL[track.label] || track.label || '?';
    const c = colors[track.label] || colors.unknown;
    // Score threshold: per-class override else general floor.
    let scoreThresh = rs.conf_thresh_general ?? null;
    const perCls = rs.conf_thresh_per_class || {};
    if (Object.prototype.hasOwnProperty.call(perCls, track.label)){
      scoreThresh = perCls[track.label];
    }
    const rows = [];
    rows.push(_buildMeterRow('Score', sample.score || 0,
                             scoreThresh != null ? parseFloat(scoreThresh) : null, c));
    const floors = _BBOX_FLOORS[track.label];
    if (floors){
      const bb = sample.bbox || {};
      const bbW = Math.max(0, (bb.x2 || 0) - (bb.x1 || 0));
      const bbH = Math.max(0, (bb.y2 || 0) - (bb.y1 || 0));
      if (floors.min_h_frac > 0){
        rows.push(_buildMeterRow(
          'Bbox-Höhe', bbH / natH, floors.min_h_frac, c));
      }
      if (floors.min_area_frac > 0){
        const fracArea = (bbW * bbH) / (natW * natH);
        rows.push(_buildMeterRow(
          'Bbox-Fläche', fracArea, floors.min_area_frac, c));
      }
    }
    return `
      <div class="lbcm-track">
        <div class="lbcm-track-head" style="color:${c}">${lbl} #${num}</div>
        ${rows.join('')}
      </div>`;
  }).join('');
  const more = overflow > 0
    ? `<div class="lbcm-more">+${overflow} weitere</div>` : '';
  host.innerHTML = `${blocks}${more}`;
  host.hidden = false;
}

// ── Settings panel mirroring cam-edit wizard (Stage 32) ──────────────────
// item.recording_settings is captured by _finalize_motion_clip at the
// time of the recording; item.achievement is filled in synchronously
// (inference_*, motion_pretrigger_fired) and asynchronously by the
// tracking_worker (tracks_by_class, peak_score_by_class,
// confirm_hits_by_track) once tracks.json is on disk.
//
// The lightbox panel mirrors the cam-edit Erkennung wizard exactly —
// same numeric circles, same Tabler-flavour icons, same titles and
// hints — and adds an "Erreicht" column showing what that setting
// actually produced for this clip. Pre-existing events (no
// recording_settings) get a single muted line instead.

// Tabler-flavour SVGs mirror the cam-edit step icons. Tightly inlined
// so the lightbox doesn't pull on the wizard's HTML at render time.
const _SET_STEP_ICONS = {
  // Step 1 · "Was suchen?" — eye + iris
  1: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
  // Step 2 · "Wie sicher?" — clock
  2: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
  // Step 3 · "Wie oft bestätigen?" — double check
  3: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/><polyline points="20 12 14 18" opacity=".5"/></svg>',
  // Step 4 · "Wie schnell scannen?" — lightning
  4: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  // Step 5 · "Bewegungs-Vortrigger" — heartbeat
  5: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h3l3-9 6 18 3-9h3"/></svg>',
};

// Header gear icon for the panel root.
const _SET_HEADER_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 0 1 7.04 4.29l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.31.61.85 1.04 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

function _fmtPct(v){
  if (v == null || !Number.isFinite(parseFloat(v))) return '—';
  return `${Math.round(parseFloat(v) * 100)} %`;
}

function _fmtPctRaw(v){
  // For values already in 0..100 (e.g. integer percent) — leave as-is.
  if (v == null || !Number.isFinite(parseFloat(v))) return '—';
  return `${Math.round(parseFloat(v))} %`;
}

function _fmtClassList(arr){
  if (!Array.isArray(arr) || arr.length === 0) return 'alle Klassen';
  return arr.map(l => OBJ_LABEL[l] || l).join(', ');
}

// Build the "Erreicht" cell for step 1 — what classes actually
// produced tracks in this clip. Reads achievement.tracks_by_class
// (filled in by the worker after tracks.json lands).
function _achStep1(ach){
  const tbc = ach?.tracks_by_class;
  if (!tbc || typeof tbc !== 'object' || Object.keys(tbc).length === 0) return '—';
  return Object.entries(tbc)
    .map(([k, v]) => `${OBJ_LABEL[k] || k} ${v}`)
    .join(', ');
}

// Step 2 "Erreicht" — peak score per class with class-colour pill.
function _achStep2(ach){
  const peaks = ach?.peak_score_by_class;
  if (!peaks || typeof peaks !== 'object' || Object.keys(peaks).length === 0) return '—';
  return Object.entries(peaks).map(([k, v]) => {
    const c = colors[k] || colors.unknown;
    return `<span class="lbset-peak" style="color:${c}">${OBJ_LABEL[k] || k} ${Math.round(parseFloat(v) * 100)} %</span>`;
  }).join(' · ');
}

// Step 3 "Erreicht" — per-track confirmation summary. Each track
// reads "Person #1: 4×/3.2s ✓" with a green ✓ if confirmed, grey
// circle otherwise.
function _achStep3(ach){
  const list = ach?.confirm_hits_by_track;
  if (!Array.isArray(list) || list.length === 0) return '—';
  return list.map((t, i) => {
    const lbl = OBJ_LABEL[t.label] || t.label || '?';
    const ok = t.confirmed ? '<span class="lbset-ok">✓</span>'
                           : '<span class="lbset-no">○</span>';
    return `${lbl} #${i + 1}: ${t.hit_count}× / ${(t.span_seconds || 0).toFixed(1)}s ${ok}`;
  }).join('<br>');
}

// Step 4 "Erreicht" — inference avg with status-coloured number.
// CPU emergency renders the value in orange (#f97316); ok / elevated
// stay in the default panel text colour.
function _achStep4(ach){
  const ms = ach?.inference_avg_ms;
  const status = ach?.inference_status;
  if (ms == null || !Number.isFinite(parseFloat(ms))) return '—';
  const tone = status === 'cpu_emergency' ? 'is-emergency'
             : status === 'elevated' ? 'is-elevated' : '';
  return `<span class="lbset-infer ${tone}">${Math.round(parseFloat(ms))} ms</span>`;
}

// Step 5 "Erreicht" — pretrigger fired flag.
function _achStep5(ach){
  if (ach?.motion_pretrigger_fired) return 'Pretrigger ausgelöst';
  return '—';
}

export function lbRenderSettingsPanel(item){
  const host = byId('lightboxSettings');
  if (!host) return;
  if (!item || item.type === 'timelapse'){
    host.innerHTML = '';
    return;
  }
  const rs = item.recording_settings;
  if (!rs || typeof rs !== 'object' || rs.mode === 'timelapse'){
    host.innerHTML = `<div class="lbset-missing">Settings nicht aufgezeichnet · ältere Aufnahme</div>`;
    return;
  }
  const ach = item.achievement || {};
  const camId = item.camera_id || '';

  // Pre-render per-step rows. Each step shows Gesetzt (the recording
  // config) and Erreicht (what the clip's data actually produced),
  // plus the wizard-mirroring numeric circle + icon + title + hint.
  const objFilterCell = (rs.object_filter == null)
    ? 'alle Klassen'
    : _fmtClassList(rs.object_filter);

  const conf2nd = (rs.conf_thresh_per_class && Object.keys(rs.conf_thresh_per_class).length > 0)
    ? Object.entries(rs.conf_thresh_per_class)
        .map(([k, v]) => `${OBJ_LABEL[k] || k} ${Math.round(parseFloat(v) * 100)} %`)
        .join(', ')
    : null;

  const steps = [
    {
      num: 1, title: 'Was suchen?', sub: 'Klassen-Filter',
      setVal: objFilterCell,
      achVal: _achStep1(ach),
    },
    {
      num: 2, title: 'Wie sicher?', sub: 'Konfidenz',
      setVal: _fmtPct(rs.conf_thresh_general)
        + (conf2nd ? ` <span class="lbset-row-aux">${conf2nd}</span>` : ''),
      achVal: _achStep2(ach),
    },
    {
      num: 3, title: 'Wie oft bestätigen?', sub: 'Anti-Fehlalarm',
      setVal: `${rs.confirm_n ?? '—'} Treffer in ${rs.confirm_seconds ?? '—'} s`,
      achVal: _achStep3(ach),
    },
    {
      num: 4, title: 'Wie schnell scannen?', sub: 'Analyse-Intervall',
      setVal: `${rs.sample_interval_ms ?? '—'} ms`,
      achVal: _achStep4(ach),
    },
    {
      num: 5, title: 'Bewegungs-Vortrigger', sub: 'vor der KI',
      setVal: _fmtPct(rs.motion_pretrigger_sensitivity),
      achVal: _achStep5(ach),
    },
  ];

  const stepsHtml = steps.map(st => `
    <div class="lbset-step">
      <div class="lbset-step-head">
        <span class="lbset-step-num">${st.num}</span>
        <span class="lbset-step-icon">${_SET_STEP_ICONS[st.num]}</span>
        <span class="lbset-step-title">${st.title}</span>
        <span class="lbset-step-sub">${st.sub}</span>
      </div>
      <div class="lbset-step-body">
        <span class="lbset-row-label">Gesetzt</span>
        <span class="lbset-row-value">${st.setVal}</span>
        <span class="lbset-row-label">Erreicht</span>
        <span class="lbset-row-value">${st.achVal}</span>
      </div>
    </div>`).join('');

  // Trailing "+" row — non-wizard items that still belong here so
  // the user has the full picture in one place.
  const nachlauf = (rs.post_motion_seconds != null && rs.post_motion_seconds > 0)
    ? `${rs.post_motion_seconds} s`
    : 'Standard';
  const extrasHtml = `
    <div class="lbset-extras">
      <div class="lbset-extras-row">
        <span class="lbset-extras-label">Nachlauf-Aufnahme</span>
        <span class="lbset-extras-value">${nachlauf}</span>
      </div>
      <div class="lbset-extras-row">
        <span class="lbset-extras-label">Min Bbox · Person</span>
        <span class="lbset-extras-value lbset-row-muted">15 % h · 2 % a · fix</span>
      </div>
    </div>`;

  // Default-collapsed — the chevron points right (CSS rotates -90°)
  // and the body sits hidden until the user taps the header. Keeps
  // the bottom of the lightbox quiet when the user just wants to
  // watch the clip; tapping the chip surfaces the full breakdown.
  host.innerHTML = `
    <button type="button" class="lbset-header" aria-expanded="false" aria-controls="lightboxSettingsBody">
      <span class="lbset-header-icon">${_SET_HEADER_ICON}</span>
      <span class="lbset-header-title">Erkennung · gesetzt vs. erreicht</span>
      <span class="lbset-header-chevron" aria-hidden="true">
        <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5l3 3 3-3"/></svg>
      </span>
    </button>
    <div class="lbset-body" id="lightboxSettingsBody" hidden>
      ${stepsHtml}
      ${extrasHtml}
      <button type="button" class="lbset-edit-btn" data-cam="${camId}">
        Aktuelle Settings dieser Kamera bearbeiten →
      </button>
    </div>`;

  const header = host.querySelector('.lbset-header');
  const body = host.querySelector('.lbset-body');
  if (header && body){
    header.addEventListener('click', () => {
      const open = body.hidden;
      body.hidden = !open;
      header.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  const editBtn = host.querySelector('.lbset-edit-btn');
  if (editBtn){
    editBtn.addEventListener('click', () => {
      const cid = editBtn.dataset.cam;
      if (!cid) return;
      // Close the lightbox first so the camera-edit panel isn't
      // hidden behind the modal, then route to the Geräte section
      // and open the Erkennung tab inside cam-edit. The double-
      // requestAnimationFrame is there because window.editCamera()
      // synchronously rebuilds the form DOM — the tab click needs
      // to land on the freshly-rendered .cam-tab-btn nodes.
      try { window.closeLightbox?.(); } catch { /* ignore */ }
      setTimeout(() => {
        location.hash = '#cameras';
        try { window.editCamera?.(cid); } catch { /* ignore */ }
        setTimeout(() => {
          const tabBtn = document.querySelector('.cam-tab-btn[data-tab="cam-tab-erkennung"]');
          tabBtn?.click();
          document.querySelector('#cam-tab-erkennung')?.scrollIntoView(
            { behavior: 'smooth', block: 'start' });
        }, 180);
      }, 60);
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
      // the real clip duration. Also kick the confidence meter so it
      // appears as soon as a track is active at t=0; without this,
      // the meter only surfaces once the user starts playback.
      if (lbState.item) lbRenderTrackTimeline(lbState.item);
      _lbDrawDetections();
      _renderConfidenceMeter();
    });
    videoEl.addEventListener('play',     () => { _startRafLoop(); _lbDrawDetections(); });
    videoEl.addEventListener('playing',  () => { _startRafLoop(); _lbDrawDetections(); });
    videoEl.addEventListener('pause',    () => { _stopRafLoop(); _lbDrawDetections(); _renderPlayCursor(); _renderConfidenceMeter(); });
    videoEl.addEventListener('ended',    () => { _stopRafLoop(); _lbDrawDetections(); _renderPlayCursor(); _renderConfidenceMeter(); });
    videoEl.addEventListener('seeked',   () => { _lbDrawDetections(); _renderPlayCursor(); _renderConfidenceMeter(); });
    videoEl.addEventListener('timeupdate', () => {
      _renderPlayCursor();
      _renderConfidenceMeter();
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
