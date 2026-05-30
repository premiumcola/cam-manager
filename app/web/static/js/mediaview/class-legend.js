// ─── mediaview/class-legend.js ─────────────────────────────────────────────
// F2 · Object/class colour legend — the companion to the overlay-toggle
// pill row. While the status legend (status-legend.js) explains the
// dash STYLE, this one explains the COLOUR: a small swatch + German
// label per class so the operator can read which hue is Person vs Katze
// vs Eichhörnchen on the bbox overlay.
//
// Single source of truth for the hues is core/class-colors.js
// (CLASS_COLORS), German labels come from core/icons.js (OBJ_LABEL) —
// no palette or label is re-declared here.
//
// Shell-level: openMediaView mounts this whenever config.overlays.bboxes
// is set (detections are meaningful in the mode). Weather / timelapse,
// which have no detections, never mount it.

import { byId, esc } from '../core/dom.js';
import { CLASS_COLORS } from '../core/class-colors.js';
import { OBJ_LABEL } from '../core/icons.js';

// Display order — the recognised animal/vehicle classes the cascade
// can emit, most-common first. ``motion`` / ``alle`` are chrome tones,
// not detection classes, so they stay out of the legend.
const MV_CLASS_ORDER = ['person', 'cat', 'dog', 'bird', 'squirrel', 'fox', 'hedgehog', 'car'];

function _swatchHtml(key) {
  const color = CLASS_COLORS[key] || '#8888aa';
  const label = OBJ_LABEL[key] || key;
  return (
    `<span class="mv-class-legend-item" data-class="${key}">` +
    `<span class="mv-class-legend-dot" style="background:${color}"></span>` +
    `<span class="mv-class-legend-label">${esc(label)}</span></span>`
  );
}

/**
 * Mount the class-colour legend.
 *
 * @param {HTMLElement|string} host  Container element or its id.
 * @param {Object} [opts]
 * @param {Array<string>} [opts.classes]  Restrict to these class keys
 *   (e.g. only the classes present in the current event). Defaults to
 *   the full recognised set in MV_CLASS_ORDER.
 * @returns {{ el: HTMLElement, teardown(): void }}
 */
export function renderClassLegend(host, opts = {}) {
  const el = typeof host === 'string' ? byId(host) : host;
  if (!el) return null;
  const requested =
    Array.isArray(opts.classes) && opts.classes.length ? opts.classes : MV_CLASS_ORDER;
  // Keep canonical order regardless of the caller's order, and drop
  // anything without a known colour so the row never shows a bare key.
  const keys = MV_CLASS_ORDER.filter((k) => requested.includes(k) && CLASS_COLORS[k]);
  const wrap = document.createElement('div');
  wrap.className = 'mv-class-legend';
  wrap.setAttribute('aria-label', 'Klassen-Farben');
  wrap.innerHTML = keys.map(_swatchHtml).join('');
  el.appendChild(wrap);
  return {
    el: wrap,
    teardown: () => wrap.remove(),
  };
}
