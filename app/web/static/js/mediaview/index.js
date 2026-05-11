// ─── mediaview/index.js ────────────────────────────────────────────────────
// Public facade for the unified MediaView shell. The shell will
// eventually host four legacy viewers — Mediathek-Lightbox, Cam-Edit
// "Erkennung jetzt simulieren", Dashboard "Live öffnen", and the
// Timelapse-Lightbox — behind one composable config object.
//
// This file is the SKELETON landing of the migration plan: the tree
// is in place, the public surface is defined, but `openMediaView`
// still routes recorded events through the existing Mediathek
// lightbox flow until the migration tasks (#3-#6 in the queue) move
// the implementation in piece by piece. That way the legacy lightbox
// keeps working for daily use during the migration and the new code
// paths come online incrementally.
//
// Layout under mediaview/:
//   shell.js                 — composes the six structural pieces
//   title-bar.js             — header, prev/next/close
//   canvas/
//     index.js               — image | video | mjpeg source switch
//     bbox-layer.js          — derived from bbox-overlay/renderer.js + raf.js
//     trail-layer.js         — placeholder for path trails (future)
//     zone-layer.js          — read-only camera-zone polygon overlay
//   playbar/
//     index.js               — composes scrubber + axis + lanes + cursor
//     scrubber.js
//     time-axis.js
//     swimlane.js            — per-class row builder
//     confirmer-row.js
//     playhead-line.js       — the ONE vertical line cutting every row
//   panel-tabs.js
//   panels/
//     detections.js
//     tracks-list.js
//     recording-settings.js  — moved from bbox-overlay/settings-panel.js
//     weather.js
//   fine-analysis-fold.js
//   detail-pill.js
//   keyboard.js
//
// Re-exports from bbox-overlay/ keep `lightbox.js` working without an
// import-path change during the migration. As tasks #3-#6 move the
// implementation here, this file replaces those re-exports with the
// real owners.

import {
  _lbDrawDetections,
  lbClearTrackTimeline,
  lbInvalidateTracks,
  lbLoadTracksForItem,
  lbRenderSettingsPanel,
  lbRenderTrackTimeline,
  lbStopTrackingPlayback,
} from '../mediathek/bbox-overlay/index.js';

// ── Public surface ─────────────────────────────────────────────────────────
// Verbatim back-compat exports — every name the old bbox-overlay
// index exposed is forwarded here, so a caller can flip its import
// path from mediathek/bbox-overlay/index.js to mediaview/index.js at
// any point without touching the rest of the code.
export {
  _lbDrawDetections,
  lbClearTrackTimeline,
  lbInvalidateTracks,
  lbLoadTracksForItem,
  lbRenderSettingsPanel,
  lbRenderTrackTimeline,
  lbStopTrackingPlayback,
};

// ── openMediaView ──────────────────────────────────────────────────────────
// Public entry for the new shell. Config shape:
//   { mode:    'recorded' | 'live' | 'live-detect' | 'timelapse',
//     source:  { type: 'mp4'|'image'|'mjpeg', url, frameSize? },
//     item:    <existing mediathek item passthrough — unchanged shape>,
//     overlays:{ bboxes, trails, zones, masks, confirmer },
//     panels:  { detections, tracksList, settings, weather },
//     actions: { onConfirm, onDelete, onDownload, onPrev, onNext, onClose } }
//
// Recorded mode delegates to the legacy lightbox renderer pinned at
// `window._lbLegacyRender` — that's lightbox.js's existing composition
// body, unchanged for this commit. Tasks #4-#6 progressively lift
// pieces of that body into the mediaview/ tree (playhead line, gauge
// pill, panel tabs, fine-analysis fold, keyboard handler). Until then
// the visible behaviour matches what users see today; the indirection
// is what lets the later tasks land piece-by-piece without a single
// breaking flip.
//
// Other modes (live, live-detect, timelapse) currently throw — the
// cam-edit, dashboard, and timelapse player callsites still go through
// their own legacy paths. Migrating them lands in a follow-up prompt.
export function openMediaView(config){
  if (!config || typeof config !== 'object'){
    throw new Error('openMediaView: config object required');
  }
  const mode = config.mode;
  if (mode === 'recorded'){
    const render = typeof window !== 'undefined' && window._lbLegacyRender;
    if (typeof render !== 'function'){
      throw new Error('openMediaView(recorded): legacy renderer not loaded');
    }
    return render(config.item);
  }
  throw new Error(`openMediaView: mode '${mode}' not yet migrated`);
}
