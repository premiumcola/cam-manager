// ─── mediaview/mode-indicator.js ───────────────────────────────────────────
// F3 · Detection-mode indicator, shared across MediaView modes.
//
//   * Interactive variant (live / live-detect) — a segmented control
//     Aus / Motion-ROI / 2×2 / 3×3 the operator clicks to switch the
//     test-detection tiling on the fly. Reuses the .mv-sim-* chrome the
//     live modal already styles (30f) so I's migration is a drop-in.
//   * Read-only variant (recorded / weather) — a single "angewandt: 2×2"
//     badge showing the tiling that produced the stored clip. Clicking
//     it overlays the tiling GRID on the frame so the operator can see
//     the fixed split into regions.
//
// The grid overlay itself (renderTilingGrid) is pure: given a mode id
// and an <svg> layer it strokes the region split — no detection data
// needed, so it works in every mode and in the data-free skeleton.

import { byId, esc } from '../core/dom.js';
import { attachHoverAndLongPress } from '../core/tooltip.js';

// Mode id → [label, title]. SAHI tiling: 2×2 / 3×3 split the frame into
// equal regions; ``roi`` runs inference on the motion crop only; ``off`` is
// whole-frame single-shot. The title is the German hover / long-press
// explanation surfaced on the interactive segments (F3-G4) — kept here so
// label + explanation share one source.
export const MV_DETECTION_MODES = [
  ['off', 'Aus', 'Ganzer Frame, ein einziger Durchlauf'],
  ['roi', 'Motion-ROI', 'Inferenz nur auf dem Bewegungs-Ausschnitt (Motion-Crop)'],
  ['2x2', '2×2', 'Frame in 2×2 Kacheln, jede einzeln geprüft — findet kleine/ferne Tiere besser'],
  ['3x3', '3×3', 'Frame in 3×3 Kacheln, jede einzeln — am genauesten, langsamer'],
];

// id → { label, title }, derived from the single MV_DETECTION_MODES source.
const _MODE_LABEL = Object.fromEntries(
  MV_DETECTION_MODES.map(([id, label, title]) => [id, { label, title }]),
);

export function mvModeLabel(id) {
  return (_MODE_LABEL[id] && _MODE_LABEL[id].label) || id || 'Aus';
}

const _SVG_NS = 'http://www.w3.org/2000/svg';

function _line(x1, y1, x2, y2) {
  const ln = document.createElementNS(_SVG_NS, 'line');
  ln.setAttribute('x1', x1);
  ln.setAttribute('y1', y1);
  ln.setAttribute('x2', x2);
  ln.setAttribute('y2', y2);
  ln.setAttribute('class', 'mv-grid-line');
  return ln;
}

/**
 * Stroke the tiling region split for ``modeId`` into an <svg> layer.
 * The svg is expected to carry viewBox="0 0 100 100"
 * preserveAspectRatio="none" so the 0–100 coordinates map to the frame
 * regardless of aspect ratio. Clears any previous grid first.
 *
 * off  → no lines · roi → centred crop box · 2×2 → 1+1 · 3×3 → 2+2.
 */
export function renderTilingGrid(svg, modeId) {
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  if (modeId === 'roi') {
    const box = document.createElementNS(_SVG_NS, 'rect');
    box.setAttribute('x', '25');
    box.setAttribute('y', '25');
    box.setAttribute('width', '50');
    box.setAttribute('height', '50');
    box.setAttribute('class', 'mv-grid-roi');
    svg.appendChild(box);
    return;
  }
  const n = modeId === '3x3' ? 3 : modeId === '2x2' ? 2 : 0;
  for (let i = 1; i < n; i++) {
    const p = (100 / n) * i;
    svg.appendChild(_line(p, 0, p, 100));
    svg.appendChild(_line(0, p, 100, p));
  }
}

function _segHtml(value) {
  // The label sits inside .mv-sim-ctl-chip — that inner span is the visible
  // pill (.mv-shell-topright .mv-sim-seg is only the 44 px touch target; the
  // active highlight is .mv-sim-seg[data-on='1'] .chip). title + data-desc
  // carry the German explanation (native tooltip + the shared popover wired
  // in renderModeIndicator).
  return MV_DETECTION_MODES.map(
    ([id, label, title]) =>
      `<button type="button" class="mv-sim-seg" data-val="${id}" data-on="${id === value ? '1' : '0'}" aria-pressed="${id === value}" title="${esc(title)}" data-desc="${esc(title)}"><span class="mv-sim-ctl-chip">${esc(label)}</span></button>`,
  ).join('');
}

/**
 * Mount the mode indicator.
 *
 * @param {HTMLElement|string} host
 * @param {Object} [opts]
 * @param {boolean} [opts.interactive]  Segmented control (true, live)
 *   vs read-only badge (false, recorded/weather).
 * @param {string} [opts.value]  Current/applied mode id (default 'off').
 * @param {Function} [opts.onChange]  (id) => void — interactive only.
 * @param {Function} [opts.onToggleGrid]  (show, id) => void — fired when
 *   the read-only badge is tapped to overlay/hide the tiling grid.
 * @returns {{ el, getValue(), setValue(id), teardown() }}
 */
export function renderModeIndicator(host, opts = {}) {
  const el = typeof host === 'string' ? byId(host) : host;
  if (!el) return null;
  let value = opts.value || 'off';
  const wrap = document.createElement('div');
  wrap.className = 'mv-mode-ind';
  wrap.dataset.interactive = opts.interactive ? '1' : '0';
  // Hover / long-press popover teardowns for the interactive segments
  // (released in teardown()); stays empty for the read-only badge.
  const tipTeardowns = [];

  if (opts.interactive) {
    wrap.innerHTML = `<div class="mv-sim-seg-group" role="group" aria-label="Erkennungs-Modus">${_segHtml(value)}</div>`;
    wrap.querySelectorAll('.mv-sim-seg').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.val;
        if (!id || id === value) return;
        value = id;
        wrap.querySelectorAll('.mv-sim-seg').forEach((b) => {
          const on = b.dataset.val === value;
          b.dataset.on = on ? '1' : '0';
          b.setAttribute('aria-pressed', String(on));
        });
        if (typeof opts.onChange === 'function') opts.onChange(value);
      });
      // G4 · German explanation on desktop hover + touch long-press, reusing
      // the shared overlay-toggle popover. A long-press swallows the click
      // (no mode switch); a normal tap still switches the mode.
      tipTeardowns.push(attachHoverAndLongPress(btn, btn.getAttribute('data-desc') || ''));
    });
  } else {
    let gridOn = false;
    wrap.innerHTML =
      `<button type="button" class="mv-mode-badge" aria-pressed="false" ` +
      `title="Angewandte Kachelung — antippen für Raster">` +
      `<span class="mv-mode-badge-k">angewandt</span>` +
      `<span class="mv-mode-badge-v">${esc(mvModeLabel(value))}</span></button>`;
    const badge = wrap.querySelector('.mv-mode-badge');
    badge.addEventListener('click', () => {
      gridOn = !gridOn;
      badge.dataset.on = gridOn ? '1' : '0';
      badge.setAttribute('aria-pressed', String(gridOn));
      if (typeof opts.onToggleGrid === 'function') opts.onToggleGrid(gridOn, value);
    });
  }
  el.appendChild(wrap);
  return {
    el: wrap,
    getValue: () => value,
    setValue: (id) => {
      value = id || 'off';
      if (opts.interactive) {
        wrap.querySelectorAll('.mv-sim-seg').forEach((b) => {
          const on = b.dataset.val === value;
          b.dataset.on = on ? '1' : '0';
          b.setAttribute('aria-pressed', String(on));
        });
      } else {
        const v = wrap.querySelector('.mv-mode-badge-v');
        if (v) v.textContent = mvModeLabel(value);
      }
    },
    teardown: () => {
      for (const fn of tipTeardowns) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
      wrap.remove();
    },
  };
}
