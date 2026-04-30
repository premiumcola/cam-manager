// ─── core/dom.js ───────────────────────────────────────────────────────────
// Minimal DOM helpers used everywhere. Kept tiny: byId is the most-
// hit function in the codebase (>2000 references) and esc is the
// HTML-escape used in every innerHTML template string.
export const byId = (id) => document.getElementById(id);

// Escape a string for safe insertion into an innerHTML template.
// Handles the OWASP-recommended five characters; the `??` falls back
// to '' on null/undefined so we never write the literal "null" into
// markup.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[m]));

// Convenience query helpers — used sparingly today but normalised
// here so any future migration off byId-everywhere can land without
// every callsite chasing document.querySelector boilerplate.
export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
