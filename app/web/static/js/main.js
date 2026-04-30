// ─── TAM-spy frontend module entry ─────────────────────────────────────────
// Stage 1 of the app.js → ES modules refactor: the index template now
// loads this file with type="module" instead of the old monolithic
// /static/app.js. main.js currently does nothing more than import the
// legacy script for its top-level side effects so the boot order is
// preserved byte-for-byte.
//
// Subsequent stages move features out of legacy.js into per-domain
// modules under js/* — each one imported here in the same order the
// legacy file's top-level code currently runs. Adding a new domain
// module is one new import line; the legacy bridge shrinks on the
// other side until legacy.js is empty and gets deleted.
import './legacy.js';
