// ─── mediathek/bbox-overlay/fetcher.js ─────────────────────────────────────
// Sidecar fetch + cache management. Tracks.json lives next to each
// motion-clip mp4 (same /media/ route serves both). lbLoadTracksForItem
// is the public entry called from openLightbox after the video src is
// set; the RAF loop kicks off via the play/loadedmetadata listeners.
import { lbState } from '../state.js';
import {
  _reindexFinalFailed,
  _reindexInflight,
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
      // Sort each track's samples by frame index AND stamp a stable
      // per-clip 1-based number (`_num`) onto every track. The
      // bbox renderer + the timeline panel both read this for the
      // visible "#N" badge — stamping once here keeps them in sync
      // without each consumer having to re-derive the index.
      let _num = 0;
      for (const tr of (data.tracks || [])){
        (tr.samples || []).sort((a, b) => a.f - b.f);
        _num += 1;
        tr._num = _num;
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
//
// G2 · every clip open now ALWAYS kicks a fresh tracking re-index
// (was: only when the sidecar was missing/empty). Cached tracks
// (if any) render immediately so the user gets a swimlane right
// away; the indexer runs in the background and the polling loop
// swaps in a fresher payload when it lands. Motion clips with no
// trigger detection (motion-only events) skip the auto-kick — there
// is nothing for the tracker to spawn against.
export async function lbLoadTracksForItem(item){
  if (!item) return;
  const tracks = await _fetchTracks(item);
  item._tracks = tracks;
  if (lbState.item !== item) return;

  const haveAnyTracks = !!(tracks
    && Array.isArray(tracks.tracks) && tracks.tracks.length > 0);
  const triggerDetCount = (item.detections || [])
    .filter(d => d && d.bbox && typeof d.bbox.x1 === 'number').length;
  // Render any cached tracks immediately so the user isn't staring
  // at an "Indexierung läuft" placeholder when usable data is
  // already on disk. The fresher payload, when the reindex
  // completes, replaces these via _retrySidecarFetch.
  lbRenderTrackTimeline(item);
  _lbDrawDetections();
  if (haveAnyTracks) _renderConfidenceMeter();

  // Always kick a fresh reindex on open — unless this event has
  // already exhausted the retry budget THIS session (final-failed),
  // in which case re-kicking would just churn for nothing.
  if (triggerDetCount === 0){
    // Motion-only event: tracker has no spawnable detection to work
    // with, so kicking the indexer is pointless. Hide any stale
    // banner left over from a previous open.
    if (!_reindexInflight.has(item.event_id)) _hideReindexBanner();
    return;
  }
  if (_reindexFinalFailed.has(item.event_id)){
    _showReindexBannerError(item);
    return;
  }
  if (_reindexInflight.has(item.event_id)){
    // A re-index started by a previous open is still polling — let
    // it finish; its retry loop will update the swimlane when the
    // new sidecar lands. Surface the pending banner so the user
    // sees the progress.
    _showReindexBannerPending(item);
    return;
  }
  // Fresh kick. The once-per-session gate was retired (see G2)
  // so reopens also trigger a re-run — matches the brief's
  // "every time a clip is opened" requirement.
  _kickReindexFor(item);

  if (!haveAnyTracks){
    _logDiag(
      `event=${item.event_id} render path=legacy `
      + `(no tracks yet, ${triggerDetCount} trigger dets) — reindexing`,
      'info');
  } else {
    _logDiag(
      `event=${item.event_id} render path=tracks `
      + `(${tracks.tracks.length} tracks) — reindex refresh kicked`,
      'info');
  }
}
