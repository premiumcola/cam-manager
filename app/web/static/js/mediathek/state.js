// ─── mediathek/state.js ────────────────────────────────────────────────────
// Stage 20 of the legacy.js → ES modules refactor — shared mutable state
// for the lightbox / mediathek surfaces. ES module imports are live
// bindings to a single object, so the .item / .index / .deletePending
// fields propagate across consumers without any window bridge.
//
// Centralising the state here is a prerequisite for the lightbox
// surgery — _lbDrawDetections, openLightbox, closeLightbox,
// _lbHandleDeleteKey, the iOS native-video handoff, the swipe nav, the
// keydown router, and the action-sheet handlers ALL read or write
// these three fields. Without a shared module they'd each have to
// reach into legacy.js via window, which is the bug we're untangling.

export const lbState = {
  item: null,            // currently-shown media item (event payload)
  index: -1,             // index into state._allMedia for prev/next nav
  deletePending: false,  // two-step delete arming flag (↓ then ↓ again)
};
