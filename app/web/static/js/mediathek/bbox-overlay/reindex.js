// ─── mediathek/bbox-overlay/reindex.js ─────────────────────────────────────
// Auto-reindex flow + the banner that lives inside the lightbox media
// wrap. When tracks.json is missing/empty AND the event has ≥1
// trigger detection, kick a POST /api/tracking/reindex and retry-loop
// the sidecar fetch up to _REINDEX_MAX_RETRIES times.
import { byId } from '../../core/dom.js';
import { showToast } from '../../core/toast.js';
import { lbState } from '../state.js';
import {
  _REINDEX_INITIAL_WAIT_MS,
  _REINDEX_MAX_RETRIES,
  _REINDEX_RETRY_INTERVAL_MS,
  _reindexFinalFailed,
  _reindexInflight,
} from './_state.js';
import { _logDiag } from './debug.js';
import { _lbDrawDetections } from './renderer.js';
import { _ensureOverlayStyles } from './styles.js';
import { lbRenderTrackTimeline } from './timeline-panel.js';
// fetcher.js is imported lazily to break the circular reference —
// fetcher.js imports the banner helpers from this file, and these
// reindex functions call back into fetcher.lbInvalidateTracks /
// _fetchTracks. ES modules tolerate this when the call sites resolve
// at call-time rather than at module-evaluation time.
import { _fetchTracks, lbInvalidateTracks } from './fetcher.js';

export async function _kickReindexFor(item){
  const eid = item.event_id;
  const cam = item.camera_id || '';
  if (!eid) return;
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

export function _showReindexBannerPending(item){
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

export function _showReindexBannerError(item){
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

export function _hideReindexBanner(){
  const banner = byId('lbTrackingBanner');
  if (!banner) return;
  banner.style.opacity = '0';
  setTimeout(() => {
    if (banner.style.opacity === '0') banner.style.display = 'none';
  }, 250);
}

export function _isReindexBannerActive(){
  const eid = lbState.item?.event_id;
  return !!eid && _reindexInflight.has(eid);
}

/**
 * Trigger a manual re-index for the currently-open lightbox item.
 * Same flow as the banner's retry button + the new always-visible
 * button in the overlay-toggles row: POST → pulse the pending
 * banner → poll for the fresh sidecar.
 *
 * ``btn`` is the originating button so we can disable it while the
 * POST is in flight. Pass null when there's no UI handle (callers
 * that want to fire and forget).
 */
export async function triggerManualReindex(btn){
  const item = lbState.item;
  if (!item || !item.event_id) return;
  if (btn){
    btn.disabled = true;
    btn.style.opacity = '.5';
  }
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
    if (btn){
      btn.disabled = false;
      btn.style.opacity = '';
    }
  }
}

async function _onReindexClick(ev){
  ev.stopPropagation();
  await triggerManualReindex(ev.currentTarget);
}
