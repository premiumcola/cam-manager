// ─── core/class-colors.js ──────────────────────────────────────────────────
// Single source of truth for per-class colours. Before this module the
// palette was duplicated across statistics.js, timeline.js,
// camedit/detection-objectfilter.js, camedit/coral-test/bbox.js, and
// core/icons.js with diverging hex values — person showed up as
// #facc15 in one place and #ff6b6b in another. The CSS mirror lives in
// 00-class-tokens.css (loaded first by css_builder so every later
// partial can reference --class-person etc.).
//
// Keep this in lockstep with 00-class-tokens.css — both files MUST
// carry the same hex per key.

export const CLASS_COLORS = {
  person: '#facc15',
  cat: '#fb923c',
  dog: '#3b82f6',
  bird: '#62d26f',
  squirrel: '#c8651a',
  fox: '#ff7a1a',
  hedgehog: '#a67c52',
  car: '#00c2ff',
  motion: '#cbd5e1',
  alle: '#8888aa',
};

/**
 * Return the colour for ``key`` (case-insensitive). Falls back to
 * the neutral chrome grey when the class isn't in the canonical set
 * — caller can override with an explicit ``fallback`` arg.
 */
export function classColor(key, fallback = '#8888aa') {
  if (!key) return fallback;
  return CLASS_COLORS[String(key).toLowerCase()] || fallback;
}
