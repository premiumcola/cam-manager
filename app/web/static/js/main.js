// ─── Squirreling · Sightings frontend module entry ─────────────────────────────────────────
// Boot shell. After Stage 25 D the legacy.js monolith is gone; main.js
// is the single explicit module entry that:
//   1. Imports every domain module so its DOM wiring runs at boot.
//   2. Wires the cross-module init helpers (confirm modal, merge modal,
//      hero-squirrel guard).
//   3. Kicks off loadAll() and the live-update poll once the shell is
//      ready. Achievement bootstrap rides the same kickoff so the
//      Sichtungen panel hydrates without a separate hook.
//
// Each module owns its own window.* bridges where inline onclicks
// rendered into innerHTML strings still need to find a global symbol;
// those bridges evaporate as each consumer migrates to delegated event
// listeners.
import { byId } from './core/dom.js';
import { bindConfirmModal } from './core/toast.js';
// O11 · global data-action delegator — mounted on import so any
// later registerAction() call is live as soon as the template loads.
import './core/action-registry.js';
// PWA / iOS-Standalone detection — adds `is-standalone` to <body> when
// the app is launched from the home-screen so CSS can pull stronger
// safe-area paddings without affecting the in-browser experience.
import './core/standalone.js';
// Service-worker registration — caches the app shell so a brief WLAN
// drop doesn't blank the screen. Live data (/api, /media, MJPEG) is
// excluded by sw.js's fetch handler.
import './pwa.js';
// iOS playback hardening — fires `tamspy:viewport-resumed` after the
// app comes back from a backgrounded tab so video/MJPEG consumers can
// re-init their streams. Also exports isIOS / MAX_CONCURRENT_STREAMS
// for any module that needs to gate behaviour.
import './core/ios-video.js';
// Cross-domain orchestration loops + bootstrappers.
import { startLiveUpdate, loadAll } from './live-update.js';
// Zusammenführen modal — bindMergeModal() wires its DOM listeners once.
import { bindMergeModal } from './camera-merge.js';
// Side-effect imports — these modules either auto-init on import or
// expose their public surface via window assignments inside them.
// Order matches the dependency graph: chrome shell → mediathek/lightbox
// → weather → cam-edit subdomain → router. Each comment tags the stage
// the module ships in so future archaeology stays cheap.
import './chrome/launch-splash.js'; // first-paint zoom-out
import './chrome/brand-logo.js'; // random spy/acorn header pick
import './chrome/settings-collapse.js'; // stage 10
import './chrome/sidebar.js'; // stage 10
import './chrome/mobile-dock.js'; // stage 10
import './chrome/tab-strip.js'; // .is-end toggle
import './chrome/live-view.js'; // stage 11
import './chrome/fullscreen.js'; // stage 11
import './chrome/logs.js'; // stage 10
import './statistics.js'; // stage 15
import './mediathek/rescan.js'; // stage 13
import './mediathek/bulk-delete.js'; // stage 13
import './mediathek/grid.js'; // stage 13
import './lightbox.js'; // stage 23 B
import './mediathek/orchestration.js'; // stage 23 A
import './mediathek/qa-pill.js'; // timelapse QA pill + modal
import './mediathek/trash-modal.js'; // S05 — Papierkorb UI
import './weather/stats.js'; // stage 24 A
import './weather/sightings.js'; // stage 24 B
import './weather/settings.js'; // stage 24 C
import './weather/maintenance.js'; // rescan + thumb regen
import './camedit/coral-test.js'; // stage 25 A
import './camedit/timelapse-settings.js'; // stage 25 B
import './camedit/wizard.js'; // stage 25 C
import './camedit/discovery.js'; // stage 25 C
import './camedit/erk-sim/index.js'; // erk-sim Snapshot + Video tabs
import './camedit/index.js'; // stage 25 D
import './router.js'; // stage 18
// Achievement panel — loadAchievements rides the loadAll() kickoff
// below; the named import makes it visible to the .then() callback.
import { loadAchievements } from './sichtungen.js';
// Bird dossiers (F08) — same boot-pattern as loadAchievements; sits
// underneath the species grid in the Sichtungen panel.
import { loadBirdDossiers } from './birds.js';
// Telegram + push hydration is wired by their own modules at import
// time; bringing the side-effect imports in keeps the load order
// predictable.
import './telegram.js';
import './push.js';

// Confirm-modal click wiring lives in core/toast.js's bindConfirmModal —
// idempotent, so calling it from the boot shell is safe.
bindConfirmModal();

// Zusammenführen modal — same idempotent pattern; needs to run after
// the static template renders, which is always true under
// type="module" semantics (deferred parse).
bindMergeModal();

// Legacy hero squirrel ASCII-injector — the hero now uses a static
// inline SVG ornament in the "Squirreling · Sightings" wordmark, so the random
// SQUIRREL_CHARS pick is no longer wired. Kept null-safe in case a
// stale template still has the #heroSquirrel element.
(() => {
  const el = byId('heroSquirrel');
  if (el) el.innerHTML = '';
})();

// ── Boot kickoff ────────────────────────────────────────────────────────────
// loadAll() fetches bootstrap + cameras + timeline + media stats, then
// runs every domain renderer (most via window.X lookups in
// live-update.js — those evaporate as each domain migrates). Once it
// resolves, the 3 s status poll starts and Sichtungen hydrates.
loadAll().then(() => {
  startLiveUpdate();
  loadAchievements();
  loadBirdDossiers();
});
// loadLogs() self-fires from chrome/logs.js's import-time boot.

// debug helper used by a couple of inline-onclick attributes when the
// page is reduced for diagnostics — leave alone.
window.byId = byId;
