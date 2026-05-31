// ─── mediaview/weather-mode.js ─────────────────────────────────────────────
// L1/L2 · Weather rides the ONE shared container. A sighting / recap
// opens the shared shell (shell.js) mounted into the single full-screen
// host #lightboxModal — the SAME container recorded + live use — with
// the F4 blue panel-tab accent (.lb-weather), a "Wetter" tab
// (panels/weather.js), the Fein-Analyse fold, prev/next over the weather
// list, and download / delete actions in the title bar.
//
// The separate mv-modal (modal.js) is gone: there is now exactly one
// MediaView container. #lightboxModal is shown with the `lb-weather`
// class, which hides the legacy recorded chrome (top bar, media wrap,
// buttons) so only the .mv-shell shows, full-screen (CSS in 30g).
//
// The host stays mounted across prev/next so the overlay doesn't flash —
// only the shell body + video re-mount per item. Close routes through
// closeWeatherMode (idempotent); lightbox.js's closeLightbox also fires
// it via the window bridge so Esc / backdrop converge on one teardown.

import { byId } from '../core/dom.js';
import { mountMediaView } from './shell.js';
import { mountCanvasSource } from './canvas/index.js';
import { renderWeatherPanel } from './panels/weather.js';

// Module-singleton player state. { shell, video } — the #lightboxModal
// host is shared + persists; shell + video are torn down and rebuilt on
// each open so prev/next swap content in place without re-showing the
// container.
let _state = null;

function _teardownInner() {
  if (!_state) return;
  try {
    _state.video?.teardown();
  } catch {
    /* ignore */
  }
  try {
    _state.shell?.teardown();
  } catch {
    /* ignore */
  }
  _state.video = null;
  _state.shell = null;
}

/**
 * Open (or re-render) the weather player in the shared #lightboxModal.
 *
 * @param {Object} config
 * @param {Object} config.item    Reshaped sighting/recap — camera_name,
 *   time_label, api_snapshot?, sun_snapshot? for the Wetter tab.
 * @param {Object} config.source  { type:'video', url } for the stage.
 * @param {boolean} [config.showWeatherTab]  Mount the Wetter tab
 *   (sightings true; recaps false — a compilation has no snapshot).
 * @param {boolean} [config.showFineFold]    Mount the Fein-Analyse fold.
 * @param {Object}  [config.actions]  onPrev/onNext/onDownload/onDelete/
 *   onClose — onPrev/onNext null disables the matching chevron.
 * @returns {Object} the player state handle.
 */
export function openWeatherMode(config = {}) {
  const actions = config.actions || {};
  const modal = byId('lightboxModal');
  const host = byId('lightboxInner');
  if (!modal || !host) return null;

  if (_state) {
    // Re-render in place (prev/next) — host already shown in weather mode.
    _teardownInner();
  } else {
    // First open — show the shared container in weather mode. The
    // lb-weather class hides the legacy recorded chrome (30g) so only
    // the shell shows. Body scroll locks for the lifetime of the modal.
    closeWeatherMode();
    // Defensive: if a recorded clip or live-detect session is still
    // open in this shared container, tear it down first (stop the live
    // polling loop + the recorded <video>, drop the foreign mode
    // classes) so two modes can never coexist on one #lightboxModal.
    try {
      window.closeLiveDetect?.();
    } catch {
      /* ignore */
    }
    const prevVid = byId('lightboxVideo');
    if (prevVid) {
      try {
        prevVid.pause();
      } catch {
        /* ignore */
      }
      prevVid.removeAttribute('src');
    }
    modal.classList.remove('lb-live-detect', 'lb-fs-video');
    modal.classList.add('lb-weather');
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    _state = { shell: null, video: null };
  }

  const showWeatherTab = config.showWeatherTab !== false;
  const shell = mountMediaView({
    mode: 'weather',
    item: config.item || {},
    overlays: {}, // no detection overlays for a sped-up weather clip
    panels: showWeatherTab ? { weather: true } : {},
    panelRenderers: showWeatherTab ? { weather: renderWeatherPanel } : {},
    showFineFold: config.showFineFold !== undefined ? config.showFineFold : showWeatherTab,
    actions: {
      onPrev: actions.onPrev || undefined,
      onNext: actions.onNext || undefined,
      onDownload: actions.onDownload || undefined,
      onDelete: actions.onDelete || undefined,
      // Title-bar close routes through closeWeatherMode so the button,
      // Esc (via closeLightbox bridge) and backdrop converge on the
      // same idempotent teardown.
      onClose: () => closeWeatherMode(actions.onClose),
    },
  });
  host.appendChild(shell.root);

  const frame = shell.root.querySelector('[data-slot="frame"]');
  const video = config.source ? mountCanvasSource(frame, config.source) : null;

  _state.shell = shell;
  _state.video = video;
  return _state;
}

/**
 * Close the weather player. Idempotent. Hides the shared container,
 * drops the weather class, tears down shell + video. Optional extra
 * callback fires once after teardown.
 */
export function closeWeatherMode(extraOnClose) {
  if (!_state) {
    if (typeof extraOnClose === 'function') {
      try {
        extraOnClose();
      } catch {
        /* ignore */
      }
    }
    return;
  }
  _teardownInner();
  _state = null;
  const modal = byId('lightboxModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('lb-weather');
  }
  document.body.style.overflow = '';
  if (typeof extraOnClose === 'function') {
    try {
      extraOnClose();
    } catch {
      /* ignore */
    }
  }
}

// Bridge for cross-module callers (weather/sightings.js delete handler,
// lightbox.closeLightbox global teardown so Esc / backdrop close weather).
if (typeof window !== 'undefined') {
  window.closeWeatherMode = closeWeatherMode;
}
