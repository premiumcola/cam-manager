// ─── mediathek/bbox-overlay/fetcher.js ─────────────────────────────────────
// Sidecar fetch + cache management. Tracks.json lives next to each
// motion-clip mp4 (same /media/ route serves both). lbLoadTracksForItem
// is the public entry called from openLightbox after the video src is
// set; the RAF loop kicks off via the play/loadedmetadata listeners.
import { lbState } from '../state.js';
import {
  _reindexFinalFailed,
  _reindexInflight,
  _reindexedThisSession,
  _tracksCache,
  _tracksInflight,
} from './_state.js';
import { _logDiag } from './debug.js';
import {
  _hideReindexBanner,
  _kickReindexFor,
  _showReindexBannerError,
  _showReindexBannerPending,
} from './reindex.js';
import { _lbDrawDetections } from './renderer.js';
import { _renderConfidenceMeter } from './confidence-meter.js';
import { lbRenderTrackTimeline } from './timeline-panel.js';

export function _tracksUrlFor(item){
  const rel = item?.video_relpath;
  if (!rel) return null;
  // The mp4 lives at <storage>/motion_detection/<cam>/<date>/<id>.mp4
  // and the sidecar sits next to it as <id>.tracks.json. Same /media/
  // route serves both.
  if (rel.endsWith('.mp4')) return `/media/${rel.slice(0, -4)}.tracks.json`;
  return null;
}

export async function _fetchTracks(item){
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
