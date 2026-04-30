// ─── core/state.js ─────────────────────────────────────────────────────────
// Single mutable runtime singleton shared across every domain module.
// Imported via `import { state } from './core/state.js'` so the same
// object reference is visible everywhere — domain modules can read and
// mutate fields on it without having to thread the object through call
// chains. Naming follows the legacy app.js convention so the migration
// stays string-comparable diff-wise.
export const state = {
  config: null,
  cameras: [],
  timeline: null,
  media: [],
  _allMedia: [],
  camera: '',
  label: '',
  period: 'week',
  bootstrap: null,
  mediaCamera: null,
  mediaStats: [],
  mediaLabels: new Set(),
  tlHours: 168,
  mediaPage: 0,
  mediaTotalPages: 1,
  _tlInitialized: false,
  mediaSelectMode: false,
  mediaSelected: new Set(),
  weather: { items: [], counts: {}, total: 0, filter: null, recaps: [] },
};

// Zone/Mask drawing state for the cam-edit shape editor. Lives at the
// top level so the timelapse / lightbox / dashboard modules don't carry
// shape concerns. Mutated by the shape-editor binding inside the
// camedit module.
export const shapeState = {
  mode: 'zone',
  points: [],
  camera: null,
  zones: [],
  masks: [],
};

// iPadOS 13+ reports "MacIntel" with maxTouchPoints > 1. The fallback
// disambiguates a real Mac from an iPad pretending to be one. Cached
// once at module load — no per-render UA sniffing.
export const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Whether the Mediathek "drilldown by stat" links open the gallery
// filtered to the picked label. Toggled here so a future A/B can flip
// it without touching every callsite.
export const STAT_MEDIA_DRILLDOWN = true;
