// ─── mediaview/title-bar.js ────────────────────────────────────────────────
// Top strip of the MediaView shell: prev/next chevrons, mode title
// (camera name + timestamp), close button. Config-driven and mode
// agnostic — H/I lift the recorded/live-specific action buttons
// (confirm-haken, download, delete) on top of this base.
//
// Nav buttons render disabled when the matching action handler is
// absent (e.g. live mode has no prev/next), so the same markup serves
// every mode without per-mode branching in the shell.

import { byId, esc } from '../core/dom.js';

const _CHEVRON_L = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>`;
const _CHEVRON_R = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>`;
const _CLOSE = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`;
const _DOWNLOAD = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><polyline points="7 11 12 16 17 11"/><path d="M5 20h14"/></svg>`;
const _TRASH = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;

function _titleFrom(config) {
  const item = (config && config.item) || {};
  const cam = item.camera_name || item.cam_name || item.camera_id || item.cam_id || '';
  const time = item.time_label || item.started_at || '';
  return { cam: String(cam), time: String(time) };
}

/**
 * Render the title bar into ``host``.
 *
 * @param {HTMLElement|string} host
 * @param {Object} config  openMediaView config (item + actions read).
 * @returns {{ el, setTitle(cam, time), teardown() }}
 */
export function renderTitleBar(host, config = {}) {
  const el = typeof host === 'string' ? byId(host) : host;
  if (!el) return null;
  const actions = config.actions || {};
  const hasPrev = typeof actions.onPrev === 'function';
  const hasNext = typeof actions.onNext === 'function';
  // Optional per-mode action buttons (weather: download + delete; H
  // adds confirm). Each renders only when its handler is supplied so
  // the same title bar serves every mode without per-mode branching.
  const dl =
    typeof actions.onDownload === 'function'
      ? `<button type="button" class="mv-tb-act" data-act="download" aria-label="Herunterladen" title="Herunterladen">${_DOWNLOAD}</button>`
      : '';
  const del =
    typeof actions.onDelete === 'function'
      ? `<button type="button" class="mv-tb-act mv-tb-act--danger" data-act="delete" aria-label="Löschen" title="Löschen">${_TRASH}</button>`
      : '';
  const { cam, time } = _titleFrom(config);
  el.className = 'mv-titlebar';
  el.innerHTML =
    `<button type="button" class="mv-tb-nav" data-nav="prev"${hasPrev ? '' : ' disabled'} aria-label="Vorheriges">${_CHEVRON_L}</button>` +
    `<div class="mv-tb-titles"><span class="mv-tb-cam">${esc(cam)}</span>` +
    `<span class="mv-tb-time">${esc(time)}</span></div>` +
    `<div class="mv-tb-actions">` +
    dl +
    del +
    `<button type="button" class="mv-tb-nav" data-nav="next"${hasNext ? '' : ' disabled'} aria-label="Nächstes">${_CHEVRON_R}</button>` +
    `<button type="button" class="mv-tb-close" data-act="close" aria-label="Schließen">${_CLOSE}</button>` +
    `</div>`;
  const wire = (sel, fn) => {
    const b = el.querySelector(sel);
    if (b && typeof fn === 'function') b.addEventListener('click', fn);
  };
  wire('[data-nav="prev"]', actions.onPrev);
  wire('[data-nav="next"]', actions.onNext);
  wire('[data-act="download"]', actions.onDownload);
  wire('[data-act="delete"]', actions.onDelete);
  wire('[data-act="close"]', actions.onClose);
  return {
    el,
    setTitle: (c, t) => {
      const camEl = el.querySelector('.mv-tb-cam');
      const timeEl = el.querySelector('.mv-tb-time');
      if (camEl) camEl.textContent = c || '';
      if (timeEl) timeEl.textContent = t || '';
    },
    teardown: () => {
      el.innerHTML = '';
    },
  };
}
