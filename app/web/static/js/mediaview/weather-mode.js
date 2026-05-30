// ─── mediaview/weather-mode.js ─────────────────────────────────────────────
// G · Weather is the first real consumer of the shared shell. A weather
// sighting / recap opens in a MediaView modal (modal.js) hosting the
// shell (shell.js) with F's blue panel-tab accent: video in the stage,
// a "Wetter" tab (panels/weather.js) for sightings, the Fein-Analyse
// fold, prev/next over the weather list, and download / delete actions.
//
// One persistent modal is reused across prev/next so the overlay
// doesn't flash — only the shell body + video re-mount per item. The
// legacy ws-lb player (weather/sightings.js) is deleted; this is the
// single weather player path.

import { mountMediaView } from './shell.js';
import { mountMediaModal } from './modal.js';
import { mountCanvasSource } from './canvas/index.js';
import { renderWeatherPanel } from './panels/weather.js';

// Module-singleton player state. { modal, shell, video } — modal
// persists across re-renders; shell + video are torn down and rebuilt
// on each open so prev/next swap content in place.
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
 * Open (or re-render) the weather player.
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
  const reuse = _state && _state.modal && !_state.modal.closed;
  let modal;
  if (reuse) {
    _teardownInner();
    modal = _state.modal;
  } else {
    closeWeatherMode();
    modal = mountMediaModal({
      mode: 'weather',
      onClose: () => closeWeatherMode(actions.onClose),
    });
    _state = { modal, shell: null, video: null };
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
      // The title-bar close routes through the modal so Esc / backdrop /
      // button all converge on the same idempotent teardown.
      onClose: () => modal.close(),
    },
  });
  modal.body.appendChild(shell.root);

  const frame = shell.root.querySelector('[data-slot="frame"]');
  const video = config.source ? mountCanvasSource(frame, config.source) : null;

  _state.shell = shell;
  _state.video = video;
  return _state;
}

/**
 * Close the weather player. Idempotent. Optional extra callback fires
 * once after teardown (used by the modal's own onClose chain).
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
  const modal = _state.modal;
  _state = null;
  try {
    modal?.close();
  } catch {
    /* ignore */
  }
  if (typeof extraOnClose === 'function') {
    try {
      extraOnClose();
    } catch {
      /* ignore */
    }
  }
}

// Bridge for cross-module callers (weather/sightings.js delete handler,
// lightbox.closeLightbox-style global teardown).
if (typeof window !== 'undefined') {
  window.closeWeatherMode = closeWeatherMode;
}
