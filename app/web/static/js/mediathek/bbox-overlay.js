// ─── mediathek/bbox-overlay.js ─────────────────────────────────────────────
// Stage 21 / Phase 2 of the tracking pipeline — draws bounding boxes
// over the active lightbox media. Two render paths share one canvas:
//
//   1. tracks.json (Phase 1 sidecar): per-frame interpolated boxes
//      driven by videoEl.currentTime, plus a snapshot fallback that
//      uses each track's FIRST sample (the trigger view).
//   2. Legacy single-bbox: lbState.item.detections[].bbox renders once.
//      Kept as the fallback for events without a tracks.json sidecar
//      (404 on fetch, schema mismatch, or tracker not installed).
//
// Phase-2 polish (Stage 30):
//   * Auto-reindex when a 404 / empty sidecar would otherwise drop the
//     lightbox into the misleading "static box at empty spot" legacy
//     path — banner + retry loop, manual fallback button on failure.
//   * Per-class visibility toggle row above the labels so the user can
//     hide e.g. "person" boxes while keeping "cat" ones.
//   * ?lbdebug=1 corner overlay for tracking-fetch diagnostics.
//
// The MP4 is NEVER modified; this is a Canvas overlay, like subtitles.
// Track colours come from the deterministic tracks.json palette so
// multiple persons in one clip get distinguishable strokes.
import { byId } from '../core/dom.js';
import { colors, OBJ_LABEL, OBJ_SVG, TL_LABELS } from '../core/icons.js';
import { _lbClearDetections } from '../lightbox.js';
import { lbState } from './state.js';
import { showToast } from '../core/toast.js';
import { state } from '../core/state.js';

// In-flight & cache state for tracks.json fetches. Keyed by event_id
// so re-opens don't re-fetch unless the user explicitly re-indexes.
const _tracksCache = new Map();    // event_id → payload | null (404)
const _tracksInflight = new Map(); // event_id → Promise
let _rafHandle = 0;
let _chipFadeTimer = 0;

// Auto-reindex bookkeeping (Task 2). All keyed by event_id.
//   _reindexedThisSession → events we've already POSTed at least once.
//     Prevents reopen-spam re-queueing the worker.
//   _reindexInflight      → reindex retry-loop is currently running.
//     The legacy fallback bbox is suppressed for these (Task 4a) so the
//     user doesn't stare at a stationary mis-positioned box for 17 s
//     while the worker re-runs.
//   _reindexFinalFailed   → 3 retries elapsed without a usable sidecar.
//     Legacy fallback is allowed back, but the pill switches to the
//     "Auslöse-Detection" top-left variant (Task 4c) so the user
//     understands the box is the trigger frame, not live tracking.
const _reindexedThisSession = new Set();
const _reindexInflight = new Set();
const _reindexFinalFailed = new Set();

const _REINDEX_INITIAL_WAIT_MS = 5000;
const _REINDEX_RETRY_INTERVAL_MS = 4000;
const _REINDEX_MAX_RETRIES = 3;

// ?lbdebug=1 surfaces the same diagnostics that go to console.warn in a
// small bottom-right corner overlay. Off by default; resolved once at
// module load so navigation inside the SPA can't flip it mid-session.
const _DEBUG_LB = (() => {
  try { return new URLSearchParams(location.search).has('lbdebug'); }
  catch { return false; }
})();
const _DEBUG_BUFFER = []; // last 4 lines for the corner overlay

// ── Debug logging (Task 1) ───────────────────────────────────────────────
// Failures + "fell back to legacy" go to console.warn so the user can
// grep them in DevTools; happy-path tracks renders stay silent on the
// console and only show up in the debug overlay when ?lbdebug=1.
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

// ── Per-class hidden-set persistence (Task 3) ────────────────────────────
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
      // Cache-buster query param in addition to `cache: 'no-store'`:
      // post-reindex flows depend on a fresh sidecar and Flask's
      // send_from_directory ships standard caching headers. Belt &
      // braces keeps the chip from showing the previous tracks set.
      const bustUrl = `${url}?_t=${Date.now()}`;
      const r = await fetch(bustUrl, { cache: 'no-store' });
      if (!r.ok){
        // 404 = "no tracking data" — cache the negative so we don't
        // hammer the server on every RAF / reseek tick.
        _tracksCache.set(eid, null);
        _logDiag(
          `event=${eid} fetch status=${r.status} url=${url} → no tracks`,
          r.status === 404 ? 'info' : 'warn');
        return null;
      }
      const data = await r.json();
      // Sort each track's samples by frame so the binary-style search
      // in _interpolateAt can step in O(log n) without per-tick work.
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
// chip. Called from openLightbox after the video src is set; the RAF
// loop kicks off via the play/loadedmetadata listeners.
export async function lbLoadTracksForItem(item){
  if (!item) return;
  const tracks = await _fetchTracks(item);
  // Stash on the item for downstream readers, but the source of truth
  // is the module-level cache (so a re-open hits the cache).
  item._tracks = tracks;
  // The user may have navigated to the next/prev item while the fetch
  // was in flight. Only mutate UI when the item we fetched for is
  // still the active lightbox item — otherwise we'd flash A's chip /
  // boxes over B.
  if (lbState.item !== item) return;

  // Decide whether to kick the auto-reindex flow:
  //   * no sidecar (null) AND event has ≥1 trigger detection
  //   * sidecar with empty tracks AND event has ≥1 trigger detection
  // Each kick is deduped via _reindexedThisSession so reopens of the
  // same event don't re-queue the worker.
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
      // Already exhausted retries earlier this session — show the
      // failure banner instead of re-kicking. User can hit ↺ to retry.
      _showReindexBannerError(item);
      _renderTrackingChip(tracks);
      _renderToggleRow(tracks);
      _lbDrawDetections();
      return;
    }
    if (!_reindexedThisSession.has(item.event_id)){
      _kickReindexFor(item);
    } else if (_reindexInflight.has(item.event_id)){
      // Already mid-retry from a previous open; just re-show the banner.
      _showReindexBannerPending(item);
    }
    // Either way: chip + toggles stay hidden until tracks land.
    _renderTrackingChip(null);
    _renderToggleRow(null);
    _lbDrawDetections();
    return;
  }

  // No reindex needed. If we previously showed a banner for this event
  // (e.g. user navigated back after a successful round-trip), hide it.
  if (!_reindexInflight.has(item.event_id)) _hideReindexBanner();

  _renderTrackingChip(tracks);
  _renderToggleRow(tracks);
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

// ── Auto-reindex flow (Task 2) ───────────────────────────────────────────

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
  // Worker accepted the job; poll for the sidecar to appear.
  setTimeout(
    () => _retrySidecarFetch(item, 1), _REINDEX_INITIAL_WAIT_MS);
}

async function _retrySidecarFetch(item, attempt){
  const eid = item.event_id;
  // Bail if user navigated away or closed the lightbox.
  if (lbState.item !== item){
    _reindexInflight.delete(eid);
    return;
  }
  // Drop cache + re-fetch.
  lbInvalidateTracks(eid);
  delete item._tracks;
  const tracks = await _fetchTracks(item);
  // Tab-switch race: re-check after the await.
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
    _renderTrackingChip(tracks);
    _renderToggleRow(tracks);
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
    // Legacy fallback now allowed back — repaint with the shortened
    // top-left "Auslöse-Detection" pill (Task 4c).
    _lbDrawDetections();
  }
}

// ── Reindex banner (Task 2 UI) ───────────────────────────────────────────

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
        <path d="M12 3 A9 9 0 0 1 21 12" stroke="#7dd3fc" stroke-width="2.4" stroke-linecap="round"/>
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
  // Force reflow so the next opacity transition runs.
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
  // Short fade-out before display:none so the change reads visually.
  setTimeout(() => {
    if (banner.style.opacity === '0') banner.style.display = 'none';
  }, 250);
}

// True when the legacy fallback bbox should be skipped because we're
// mid-reindex for this event (Task 4a).
function _isReindexBannerActive(){
  const eid = lbState.item?.event_id;
  return !!eid && _reindexInflight.has(eid);
}

// ── Drawing ───────────────────────────────────────────────────────────────

// Linear-interp the bbox of a single track at video time `t` (seconds).
// Returns { bbox: {x1,y1,x2,y2}, score, label } or null if t is
// outside the track's lifespan.
function _interpolateTrackAt(track, t){
  const samples = track.samples || [];
  if (!samples.length) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (t < first.t - 0.05) return null;        // before the track started
  if (t > last.t + 0.05) return null;         // after the track ended
  // Find the two samples that bracket t. Linear scan is fine — track
  // sample lists are typically <50 entries (sparse 1 Hz sampling +
  // skip-equal-bbox in the worker). For very long clips the binary
  // search would still be cheap, but isn't worth the complexity here.
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
    // Score is the score of the closest "detect" sample, not the
    // interpolated one. Pick whichever neighbour was a detect; fall
    // back to the track's overall best.
    score: (prev.source === 'detect' ? prev.score
           : next.source === 'detect' ? next.score
           : track.best_score) ?? 0,
    label: track.label,
  };
}

// Snapshot mode: each track's FIRST sample, regardless of source. That
// matches the trigger-frame view the user expects when looking at the
// still preview.
function _firstSampleOfTrack(track){
  const s = (track.samples || [])[0];
  if (!s) return null;
  return {
    bbox: s.bbox,
    score: s.source === 'detect' ? s.score : (track.best_score ?? 0),
    label: track.label,
  };
}

// Resolve the allowed-label set for the current item. Returns:
//   Set<string>  — only these labels render
//   null         — no filter info, draw everything (legacy behaviour)
function _resolveAllowedLabels(){
  const tracks = lbState.item?._tracks;
  // 1. Authoritative source: schema≥2 tracks.json sidecars carry the
  //    exact allowed list at write time. tracking_worker only emits
  //    `null` (no filter) or a non-empty array — empty `object_filter`
  //    on the camera maps to no-filter at the runtime layer too, so
  //    `[]` is unreachable here.
  if (tracks && Array.isArray(tracks.filter_applied)){
    return new Set(tracks.filter_applied);
  }
  // 2. Fallback for legacy schema=1 sidecars (and the no-tracks render
  //    path): look up the camera's live object_filter.
  const camId = lbState.item?.camera_id;
  if (camId){
    const cam = (state.cameras || []).find(c => (c.id || '') === camId);
    const of = cam?.object_filter;
    if (Array.isArray(of) && of.length > 0){
      return new Set(of);
    }
  }
  // 3. No info either way → no filter.
  return null;
}

// Combined visibility check: a label renders iff it passes the
// camera-filter (from tracks.filter_applied / camera config) AND is
// not in the per-camera user-toggled hidden set (Task 3). Returns a
// closure so a single render reads the hidden-set / camera-filter
// once and reuses across every per-track / per-detection check.
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
  // Size the canvas to cover the wrap; use DPR for crisp strokes.
  const dpr = window.devicePixelRatio || 1;
  cv.style.width = wrapRect.width + 'px';
  cv.style.height = wrapRect.height + 'px';
  cv.width  = Math.round(wrapRect.width * dpr);
  cv.height = Math.round(wrapRect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, wrapRect.width, wrapRect.height);

  // object-fit:contain inside the media element
  const scale = Math.min(mediaRect.width / natW, mediaRect.height / natH);
  const renderedW = natW * scale, renderedH = natH * scale;
  const offX = (mediaRect.width - renderedW) / 2 + (mediaRect.left - wrapRect.left);
  const offY = (mediaRect.height - renderedH) / 2 + (mediaRect.top - wrapRect.top);

  // Pick the render path. Track-driven overlay (Phase 2) when the
  // sidecar exists with at least one track; fall back to the
  // single-bbox legacy path otherwise.
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
  // detection; without per-frame tracks it would visually lie about
  // where the subject is during playback.
  // Suppress entirely while a reindex banner is showing (Task 4a) so
  // the user doesn't stare at a stationary mis-positioned box for
  // ~17 s while the worker re-runs.
  if (_isReindexBannerActive()) return;

  // Hide the legacy box during active playback — same as before, the
  // user's "bbox stays put while subject moves out" complaint. Pause /
  // ended / still-image modes paint the box back at trigger position.
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
  // Annotation pill. Two variants:
  //   * default: "Detection bei Auslösung" centred above the topmost
  //     bbox — the long-standing label.
  //   * post-failed-reindex (Task 4c): shorter "Auslöse-Detection"
  //     anchored at the top-left of the bbox so it competes less with
  //     the actual subject during playback.
  const top = dets.reduce((min, d) =>
    (d.bbox.y1 < min.bbox.y1 ? d : min), dets[0]);
  const bx1 = offX + top.bbox.x1 * scale;
  const by1 = offY + top.bbox.y1 * scale;
  const isFinalFail = _reindexFinalFailed.has(lbState.item.event_id);
  const tagText = isFinalFail ? 'Auslöse-Detection' : 'Detection bei Auslösung';
  ctx.font = '500 10px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  const tagW = ctx.measureText(tagText).width;
  const padX = 6, tagH = 16;
  const tagX = isFinalFail ? bx1 + 2 : bx1;
  const tagY = isFinalFail
    ? Math.max(0, by1 + 2)                   // inside, top-left of bbox
    : Math.max(0, by1 - 20 - tagH - 2);      // above the regular label pill
  ctx.fillStyle = 'rgba(0,0,0,0.78)';
  ctx.fillRect(tagX, tagY, tagW + padX * 2, tagH);
  ctx.fillStyle = colors[top.label] || colors.unknown;
  ctx.fillText(tagText, tagX + padX, tagY + 2);
}

function _drawTrackBox(ctx, sample, color, offX, offY, scale){
  const b = sample.bbox;
  const x1 = offX + b.x1 * scale, y1 = offY + b.y1 * scale;
  const x2 = offX + b.x2 * scale, y2 = offY + b.y2 * scale;
  const w = x2 - x1, h = y2 - y1;
  if (w <= 0 || h <= 0) return;
  const c = color || '#22c55e';
  // No shadowBlur on the per-frame path: 5+ shadows × 60 fps melts
  // budget on iPhones. The flat 2 px stroke + label pill still reads
  // clearly against any background.
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
// Only runs while a video is playing AND tracks.json is loaded. Pause /
// ended / lightbox close all stop the loop; on pause we leave the
// boxes painted at the current paused time. Seek triggers the next
// RAF tick to repaint at the new currentTime — no extra wiring needed.

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
    _rafHandle = requestAnimationFrame(tick);
  };
  _rafHandle = requestAnimationFrame(tick);
}

// ── Overlay styles (chip + banner + toggle row) ──────────────────────────
// Single style block injected once. Stack from the bottom upward inside
// the lightboxMediaWrap:
//   80 px  — lightboxLabels (set inline in modals.html)
//   140 px — #lbBboxToggleRow (per-class visibility pills + caption)
//   200 px — #lbTrackingChip / #lbTrackingBanner (mutually exclusive)
// Mobile bumps each layer by ~16 px so the iOS Safari controls bar
// doesn't eat the chip on a 375 px screen.
function _ensureOverlayStyles(){
  if (document.querySelector('#lbTrackingChipStyles')) return;
  const s = document.createElement('style');
  s.id = 'lbTrackingChipStyles';
  s.textContent = `
    #lbTrackingChip{position:absolute;left:14px;bottom:200px;z-index:5;
      display:none;align-items:center;gap:6px;padding:5px 8px 5px 10px;
      border-radius:999px;background:rgba(0,0,0,.55);color:#e2e8f0;
      font-size:11px;font-weight:600;letter-spacing:.02em;
      backdrop-filter:blur(6px);opacity:0;transition:opacity .25s ease;
      pointer-events:auto}
    #lbTrackingChip .lbtc-reindex{
      background:none;border:none;color:rgba(226,232,240,.85);cursor:pointer;
      padding:0;margin:-6px -4px -6px 2px;border-radius:10px;
      display:inline-flex;align-items:center;justify-content:center;
      min-width:36px;min-height:36px;-webkit-tap-highlight-color:transparent}
    #lbTrackingChip .lbtc-reindex:hover{background:rgba(255,255,255,.10)}

    #lbTrackingBanner{position:absolute;left:14px;bottom:200px;z-index:5;
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

    #lbBboxToggleRow{position:absolute;left:14px;bottom:140px;z-index:4;
      display:none;flex-direction:column;align-items:flex-start;gap:4px;
      pointer-events:none}
    #lbBboxToggleRow .lbbtr-cap{
      font-size:10px;font-weight:600;letter-spacing:.05em;
      text-transform:uppercase;color:rgba(226,232,240,.78);
      padding:2px 8px;border-radius:8px;background:rgba(0,0,0,.42);
      backdrop-filter:blur(4px);pointer-events:none}
    #lbBboxToggleRow .lbbtr-pills{
      display:flex;flex-direction:row;gap:6px;flex-wrap:wrap;
      pointer-events:auto}
    #lbBboxToggleRow .lbbtr-pill{
      width:36px;height:36px;border-radius:50%;
      display:inline-flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,.55);cursor:pointer;border:none;
      padding:0;color:inherit;
      transition:opacity .15s,background .15s;
      -webkit-tap-highlight-color:transparent;
      flex-shrink:0;position:relative}
    #lbBboxToggleRow .lbbtr-pill::before{
      content:'';position:absolute;inset:-2px;border-radius:50%;
      box-shadow:0 0 0 2px var(--ring,rgba(255,255,255,.15));
      pointer-events:none;transition:box-shadow .15s}
    #lbBboxToggleRow .lbbtr-pill[data-on="0"]{
      opacity:.5;filter:grayscale(.7)}
    #lbBboxToggleRow .lbbtr-pill[data-on="0"]::before{
      box-shadow:0 0 0 1px rgba(255,255,255,.10)}

    @media (max-width:768px){
      #lbTrackingChip{bottom:216px!important;left:10px!important}
      #lbTrackingChip .lbtc-reindex{
        min-width:44px;min-height:44px;margin:-9px -6px -9px 2px}
      #lbTrackingBanner{bottom:216px!important;left:10px!important}
      #lbTrackingBanner .lbtb-retry{
        min-width:44px;min-height:44px;margin:-9px -6px -9px 4px}
      #lbBboxToggleRow{bottom:156px!important;left:10px!important}
      #lbBboxToggleRow .lbbtr-pill{width:44px;height:44px}
    }
  `;
  document.head.appendChild(s);
}

// ── Tracking chip + reindex button ───────────────────────────────────────
// Bottom-left of the lightbox. Reads "Tracking · N Subjekte" plus a
// monochrome ↺ button. Fades out 3 s after the video starts playing
// so it doesn't sit on top of the content for the whole clip.

function _ensureChip(){
  let chip = byId('lbTrackingChip');
  if (chip) return chip;
  const wrap = byId('lightboxMediaWrap');
  if (!wrap) return null;
  _ensureOverlayStyles();
  chip = document.createElement('div');
  chip.id = 'lbTrackingChip';
  chip.innerHTML = `
    <span class="lbtc-text" title="Anzahl unterschiedlicher Track-IDs in diesem Clip. Ein Objekt, das den Bildausschnitt verlässt und wiederkommt, bekommt eine neue ID.">Tracking</span>
    <button type="button" class="lbtc-reindex" title="Tracking neu generieren" aria-label="Tracking neu generieren">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2.5 8A5.5 5.5 0 0 1 13 5M13.5 8A5.5 5.5 0 0 1 3 11"/>
        <polyline points="12,2 12,5.5 8.5,5.5"/>
        <polyline points="4,14 4,10.5 7.5,10.5"/>
      </svg>
    </button>`;
  wrap.appendChild(chip);
  chip.querySelector('.lbtc-reindex').addEventListener('click', _onReindexClick);
  // Re-show on hover (desktop) + tap (mobile/iOS) so 3s isn't too short
  // to actually click reindex. Both reset the fade timer.
  wrap.addEventListener('mouseenter', _wakeChip);
  wrap.addEventListener('click', _wakeChip);
  return chip;
}

// Reveal the chip and reset the fade timer. Safe to call when no chip
// is rendered (e.g. clip without tracks) — nothing happens.
function _wakeChip(){
  const chip = byId('lbTrackingChip');
  if (!chip || chip.style.display === 'none') return;
  chip.style.opacity = '1';
  clearTimeout(_chipFadeTimer);
  _chipFadeTimer = setTimeout(() => { chip.style.opacity = '0'; }, 3000);
}

function _renderTrackingChip(tracks){
  const chip = _ensureChip();
  if (!chip) return;
  // Count POST-filter so the chip doesn't claim "6 Subjekte" when 4 of
  // them are filtered classes the overlay just dropped.
  const isVisible = _makeLabelVisibleFn();
  const allTracks = (tracks && Array.isArray(tracks.tracks)) ? tracks.tracks : [];
  const visible = allTracks.filter(t => isVisible(t.label));
  const n = visible.length;
  if (!tracks || n === 0){
    chip.style.display = 'none';
    chip.style.opacity = '0';
    return;
  }
  const txt = chip.querySelector('.lbtc-text');
  if (txt) txt.textContent = `Tracking · ${n} Subjekt${n === 1 ? '' : 'e'}`;
  chip.style.display = 'flex';
  // Force reflow so the next opacity transition runs.
  void chip.offsetWidth;
  chip.style.opacity = '1';
  clearTimeout(_chipFadeTimer);
  _chipFadeTimer = setTimeout(() => {
    chip.style.opacity = '0';
  }, 3000);
}

// ── Per-class toggle row (Task 3) ────────────────────────────────────────

function _ensureToggleRow(){
  let row = byId('lbBboxToggleRow');
  if (row) return row;
  const wrap = byId('lightboxMediaWrap');
  if (!wrap) return null;
  _ensureOverlayStyles();
  row = document.createElement('div');
  row.id = 'lbBboxToggleRow';
  row.innerHTML = `
    <div class="lbbtr-cap">Boxen anzeigen</div>
    <div class="lbbtr-pills" role="group" aria-label="Sichtbare Klassen"></div>`;
  wrap.appendChild(row);
  return row;
}

function _renderToggleRow(tracks){
  const row = _ensureToggleRow();
  if (!row) return;
  const camId = lbState.item?.camera_id;
  const allTracks = (tracks && Array.isArray(tracks.tracks)) ? tracks.tracks : [];
  // Unique labels in tracks, ordered by TL_LABELS (deterministic) +
  // anything else appended at the end so unfamiliar future classes
  // still surface a toggle.
  const present = new Set(allTracks.map(t => t.label).filter(Boolean));
  if (present.size === 0){
    row.style.display = 'none';
    return;
  }
  const ordered = [
    ...TL_LABELS.filter(l => present.has(l)),
    ...[...present].filter(l => !TL_LABELS.includes(l)),
  ];
  const hidden = _getHiddenClassesForCam(camId);
  const pillsEl = row.querySelector('.lbbtr-pills');
  pillsEl.innerHTML = '';
  for (const lbl of ordered){
    const c = colors[lbl] || colors.unknown;
    const rawSvg = OBJ_SVG[lbl] || OBJ_SVG.alarm;
    const svg = rawSvg.replace('width="16" height="16"', 'width="22" height="22"');
    const on = !hidden.has(lbl);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lbbtr-pill';
    btn.dataset.label = lbl;
    btn.dataset.on = on ? '1' : '0';
    btn.title = (OBJ_LABEL[lbl] || lbl)
      + (on ? ' · Boxen sichtbar' : ' · Boxen ausgeblendet');
    btn.style.setProperty('--ring', on ? c : 'rgba(255,255,255,.10)');
    btn.style.background = on ? `${c}1f` : 'rgba(0,0,0,.55)';
    btn.innerHTML = svg;
    btn.addEventListener('click', _onToggleClassClick);
    pillsEl.appendChild(btn);
  }
  row.style.display = 'flex';
}

function _onToggleClassClick(ev){
  ev.stopPropagation();
  const btn = ev.currentTarget;
  const lbl = btn.dataset.label;
  const camId = lbState.item?.camera_id;
  if (!lbl || !camId) return;
  const hidden = _getHiddenClassesForCam(camId);
  if (hidden.has(lbl)) hidden.delete(lbl);
  else hidden.add(lbl);
  _setHiddenClassesForCam(camId, hidden);
  // Update only this pill's visual state — no full re-render, so the
  // user sees the toggle flip instantly without a layout flash.
  const on = !hidden.has(lbl);
  const c = colors[lbl] || colors.unknown;
  btn.dataset.on = on ? '1' : '0';
  btn.style.setProperty('--ring', on ? c : 'rgba(255,255,255,.10)');
  btn.style.background = on ? `${c}1f` : 'rgba(0,0,0,.55)';
  btn.title = (OBJ_LABEL[lbl] || lbl)
    + (on ? ' · Boxen sichtbar' : ' · Boxen ausgeblendet');
  // Re-paint canvas + chip count immediately.
  _renderTrackingChip(lbState.item?._tracks || null);
  _lbDrawDetections();
}

async function _onReindexClick(ev){
  ev.stopPropagation();
  const item = lbState.item;
  if (!item || !item.event_id) return;
  const btn = ev.currentTarget;
  btn.disabled = true;
  btn.style.opacity = '.5';
  // Reset the per-event final-failed flag so a manual retry can
  // restore the auto-reindex retry loop on the next tracks fetch.
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
    // Drop cache + start the same retry-poll loop the auto-kick uses.
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

// Stop the loop and hide the chip + banner + toggles — called from
// closeLightbox via the window bridge so legacy.js doesn't have to
// know about RAF state.
export function lbStopTrackingPlayback(){
  _stopRafLoop();
  clearTimeout(_chipFadeTimer);
  const chip = byId('lbTrackingChip');
  if (chip){
    chip.style.opacity = '0';
    chip.style.display = 'none';
  }
  const banner = byId('lbTrackingBanner');
  if (banner){
    banner.style.opacity = '0';
    banner.style.display = 'none';
  }
  const row = byId('lbBboxToggleRow');
  if (row) row.style.display = 'none';
}
window.lbStopTrackingPlayback = lbStopTrackingPlayback;

// ── Self-bound listeners ─────────────────────────────────────────────────
// IIFE wires three repaint triggers + the RAF loop. All null-guarded
// so the module is safe to import on pages without the lightbox shell.
(function _initLbDetectionsHooks(){
  const imgEl = byId('lightboxImg');
  const videoEl = byId('lightboxVideo');
  if (imgEl) imgEl.addEventListener('load', () => _lbDrawDetections());
  if (videoEl){
    videoEl.addEventListener('loadedmetadata', () => _lbDrawDetections());
    // play / playing both kick the RAF loop AND call _lbDrawDetections
    // once. The draw call clears the canvas (synchronously); on the
    // legacy single-bbox path it then bails (isPlaying guard) so the
    // stale trigger-frame box doesn't sit there while the subject
    // moves through the clip. On the tracks path the RAF loop draws
    // interpolated boxes anyway, so the extra call is a harmless dup.
    videoEl.addEventListener('play',     () => { _startRafLoop(); _lbDrawDetections(); });
    videoEl.addEventListener('playing',  () => { _startRafLoop(); _lbDrawDetections(); });
    videoEl.addEventListener('pause',    () => { _stopRafLoop(); _lbDrawDetections(); });
    videoEl.addEventListener('ended',    () => { _stopRafLoop(); _lbDrawDetections(); });
    // Seek → snap the overlay to the new time on the next RAF tick.
    videoEl.addEventListener('seeked',   () => _lbDrawDetections());
    videoEl.addEventListener('timeupdate', () => {
      // Pure safety net for RAF starvation (e.g. the tab is in the
      // background and the browser throttled the RAF loop). timeupdate
      // fires ~4 Hz natively, which is enough to keep the boxes
      // roughly in place when the loop isn't running.
      if (!_rafHandle) _lbDrawDetections();
    });
  }
  let _raf = 0;
  const _scheduleRedraw = () => {
    if (!byId('lightboxModal') || byId('lightboxModal').classList.contains('hidden')) return;
    cancelAnimationFrame(_raf);
    _raf = requestAnimationFrame(_lbDrawDetections);
  };
  window.addEventListener('resize', _scheduleRedraw);
  // ResizeObserver covers the cases the window-resize event misses:
  // sidenav slide, iOS Safari address-bar collapse, soft-keyboard
  // appearance, and the video element revealing its real aspect ratio
  // on loadedmetadata. Without this the bboxes sit stale at the
  // previous wrap size when the video is paused (no RAF tick fires).
  const _wrap = byId('lightboxMediaWrap');
  if (_wrap && 'ResizeObserver' in window){
    const obs = new ResizeObserver(_scheduleRedraw);
    obs.observe(_wrap);
  }
})();
