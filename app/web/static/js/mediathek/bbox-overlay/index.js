// ─── mediathek/bbox-overlay/index.js ───────────────────────────────────────
// Public facade for the bbox-overlay package. Carved out of the
// original 1626-line bbox-overlay.js during the modular refactor —
// every public name remains importable from the same path so callers
// (lightbox.js, orchestration.js) don't need to update their imports
// when the bundler resolves the folder index.
//
// Stage 21 / Phase 2 of the tracking pipeline — draws bounding boxes
// over the active lightbox media AND owns the track-timeline panel
// that ships beneath the video in full-screen mode.
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
// The MP4 is NEVER modified; this is a Canvas overlay, like subtitles.
import { byId } from '../../core/dom.js';
import { lbState } from '../state.js';
import { _state } from './_state.js';
import { lbInvalidateTracks, lbLoadTracksForItem } from './fetcher.js';
import { _lbDrawDetections } from './renderer.js';
import { _renderConfidenceMeter } from './confidence-meter.js';
import {
  _refreshPlayButtonGlyph,
  _updatePlayPct,
} from './time-axis.js';
import { _startRafLoop, _stopRafLoop } from './raf.js';
import { lbClearTrackTimeline, lbRenderTrackTimeline } from './timeline-panel.js';
import { lbRenderSettingsPanel } from './settings-panel.js';
import { lbStopTrackingPlayback } from './cleanup.js';

// Public surface — verbatim list of every name the old single-file
// module exported. Caller imports keep resolving without a path change.
export {
  lbClearTrackTimeline,
  lbInvalidateTracks,
  lbLoadTracksForItem,
  lbRenderSettingsPanel,
  lbRenderTrackTimeline,
  lbStopTrackingPlayback,
  _lbDrawDetections,
};

// ── Self-bound listeners ─────────────────────────────────────────────────
// Wire the video / image / resize hooks once at module load. The IIFE
// pattern mirrors the original file's bottom block so the boot-order
// behaviour is bit-identical (the listeners attach as soon as the
// module is imported by main.js's `import` graph, before any user
// interaction).
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
      _updatePlayPct();
      _renderConfidenceMeter();
    });
    videoEl.addEventListener('play',     () => { _startRafLoop(); _lbDrawDetections(); _refreshPlayButtonGlyph(); });
    videoEl.addEventListener('playing',  () => { _startRafLoop(); _lbDrawDetections(); _refreshPlayButtonGlyph(); });
    videoEl.addEventListener('pause',    () => { _stopRafLoop(); _lbDrawDetections(); _updatePlayPct(); _renderConfidenceMeter(); _refreshPlayButtonGlyph(); });
    videoEl.addEventListener('ended',    () => { _stopRafLoop(); _lbDrawDetections(); _updatePlayPct(); _renderConfidenceMeter(); _refreshPlayButtonGlyph(); });
    videoEl.addEventListener('seeked',   () => { _lbDrawDetections(); _updatePlayPct(); _renderConfidenceMeter(); });
    videoEl.addEventListener('timeupdate', () => {
      // Belt + braces — if the rAF loop is throttled (background tab,
      // power-save), `timeupdate` (~4 Hz native) still keeps the bar
      // moving. Inside an active rAF loop this is a redundant write.
      _updatePlayPct();
      _renderConfidenceMeter();
      if (!_state.rafHandle) _lbDrawDetections();
    });
  }
  let _raf = 0;
  const _scheduleRedraw = () => {
    if (!byId('lightboxModal') || byId('lightboxModal').classList.contains('hidden')) return;
    cancelAnimationFrame(_raf);
    _raf = requestAnimationFrame(() => { _lbDrawDetections(); _updatePlayPct(); });
  };
  window.addEventListener('resize', _scheduleRedraw);
  const _wrap = byId('lightboxMediaWrap');
  if (_wrap && 'ResizeObserver' in window){
    const obs = new ResizeObserver(_scheduleRedraw);
    obs.observe(_wrap);
  }
})();
