// ─── mediathek/bbox-overlay/_state.js ──────────────────────────────────────
// Cross-section mutable state + tuning constants. Lives in one file so
// every sibling module can import the same Map / Set instance (objects
// are shared by reference across ES module imports) and the few
// mutable scalars are wrapped in a `_state` object so writers in one
// module are visible to readers in another.
//
// Carved out of the original mediathek/bbox-overlay.js during the
// modular refactor — behaviour unchanged.

// ── Track payload cache + in-flight fetches ─────────────────────────────
// Keyed by event_id so re-opens don't re-fetch unless the user explicitly
// re-indexes.
export const _tracksCache = new Map();    // event_id → payload | null (404)
export const _tracksInflight = new Map(); // event_id → Promise

// ── Auto-reindex bookkeeping ────────────────────────────────────────────
// All keyed by event_id.
//   _reindexInflight      → reindex retry-loop is currently running.
//     Legacy fallback bbox is suppressed for these so the user doesn't
//     stare at a stationary mis-positioned box during indexing.
//   _reindexFinalFailed   → retry budget exhausted without a usable sidecar.
// G2 · the per-session "already kicked" set was retired — clip opens
// now always re-kick, so the only relevant signals are inflight + final-fail.
export const _reindexInflight = new Set();
export const _reindexFinalFailed = new Set();

// G2 · CPU-fallback reindex on a 30 s clip routinely takes 12-18 s
// (measured on the dev box: dur=15.4s for a 40 s clip). The retry
// budget covers that with one cycle to spare:
//   initial 5 s + 6 attempts × 5 s = 35 s total before declaring fail.
export const _REINDEX_INITIAL_WAIT_MS = 5000;
export const _REINDEX_RETRY_INTERVAL_MS = 5000;
export const _REINDEX_MAX_RETRIES = 6;

// Mirrors tracking_worker.TRACK_SPAWN_SCORE — a sample below this
// floor is tentative (extends an existing track but couldn't spawn
// one on its own). The overlay paints it dashed so the operator can
// see why the same track id is carrying mixed-confidence frames.
export const _TRACK_SPAWN_SCORE = 0.50;

// ?lbdebug=1 surfaces the same diagnostics that go to console.warn in
// a small bottom-right corner overlay. Off by default; resolved once
// at module load so navigation inside the SPA can't flip it mid-session.
export const _DEBUG_LB = (() => {
  try { return new URLSearchParams(location.search).has('lbdebug'); }
  catch { return false; }
})();
export const _DEBUG_BUFFER = []; // last 4 lines for the corner overlay

// ── Mutable scalars wrapped in an object so cross-module writes are
// visible to readers (ES module `let` exports are read-only from the
// importer's perspective; mutating an object property bypasses that
// restriction without a setter per scalar). ───────────────────────────
export const _state = {
  // Playback RAF handle — 0 = no loop running. Set by raf.js.
  rafHandle: 0,
  // Track-timeline state captured at render time so the play cursor +
  // × tooltip handlers don't have to re-read videoEl.duration / re-parse
  // tracks.json on every event.
  timelineDuration: 0,           // seconds
  timelineTrackIndex: [],        // array of track objects for × tooltip
  // Time-axis drag state — track whether the scrubber drag interrupted
  // active playback so we can resume on pointerup.
  dragWasPlaying: false,
  // Singleton tooltip DOM node for the timeline-bar × markers. Created
  // lazily on first use and reused for the rest of the page lifetime.
  barEndTipEl: null,
};
