// ─── mediathek/bbox-overlay/legend.js ──────────────────────────────────────
// Status-encoding legend mounted to the right of the overlay-toggles
// pill row. Reads dash patterns from renderer.js · _STATUS_STYLE so
// the table stays a single source of truth across video bbox + bar +
// legend. Color encodes IDENTITY (the per-track tracks.json color);
// dash style + opacity encode STATUS — that's what the legend
// explains.
//
// Desktop: four inline swatches in a slim row.
// Mobile (<=768px): collapsed to a single "?" chip that opens a
// popover with the same four rows. The popover reuses the
// `.mv-live-toggle-tip` class from overlay-toggles.js so the styling
// matches the per-pill description popovers operators already know.

import { byId } from '../../core/dom.js';
import { _STATUS_STYLE } from './renderer.js';

const _LEGEND_ID = 'lbStatusLegend';
const _MASKED_COLOR = '#94a3b8';

// One row per category. The label is what the user reads; the marker
// is the same prefix the bbox score-pill prints (so a "↓ 24%" pill
// on the video links visually to the "↓ Schwach" legend entry).
const _ROWS = [
  { key: 'confirmed', label: 'Bestätigt', marker: ''   },
  { key: 'weak',      label: 'Schwach',  marker: '↓ ' },
  { key: 'ghost',     label: 'Ghost',    marker: '≈ ' },
  { key: 'masked',    label: 'Maskiert', marker: '⊘ ' },
];

// 24×8 SVG swatch — short horizontal stroke painted with the same
// dash + opacity as the bbox renderer would use. ``masked`` flips the
// color to neutral gray; the other three use a representative
// per-track color (#22c55e, the palette's first slot) so the legend
// has visual weight without claiming ownership of a specific hue
// (the muted tail "Farbe = Person-Nr." makes the identity-color story
// explicit).
function _swatchSvg(key){
  if (key === 'masked'){
    return `<svg width="28" height="8" viewBox="0 0 28 8" aria-hidden="true">
      <line x1="2" y1="4" x2="26" y2="4" stroke="${_MASKED_COLOR}" stroke-width="2" stroke-linecap="round"/>
    </svg>`;
  }
  const style = _STATUS_STYLE[key] || _STATUS_STYLE.confirmed;
  const dash = style.dash.length ? style.dash.join(' ') : '';
  return `<svg width="28" height="8" viewBox="0 0 28 8" opacity="${style.alpha}" aria-hidden="true">
    <line x1="2" y1="4" x2="26" y2="4" stroke="#22c55e" stroke-width="2"
          stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>
  </svg>`;
}

function _rowHtml(row){
  const swatch = _swatchSvg(row.key);
  const text = `${row.marker}${row.label}`.trim();
  return `<span class="lb-legend-row" data-cat="${row.key}">
    <span class="lb-legend-swatch">${swatch}</span>
    <span class="lb-legend-label">${text}</span>
  </span>`;
}

// Lazily-created mobile popover. Same `.mv-live-toggle-tip` class as
// the per-pill description popovers in overlay-toggles.js so the
// dark surface + blur + positioning rules apply uniformly.
let _tipEl = null;
function _ensureTip(){
  if (_tipEl) return _tipEl;
  _tipEl = document.createElement('div');
  _tipEl.className = 'mv-live-toggle-tip lb-legend-tip';
  _tipEl.setAttribute('role', 'tooltip');
  _tipEl.hidden = true;
  document.body.appendChild(_tipEl);
  return _tipEl;
}

function _showTip(target){
  const tip = _ensureTip();
  tip.innerHTML = `<div class="lb-legend-tip-body">
    ${_ROWS.map(_rowHtml).join('')}
    <div class="lb-legend-tip-tail">Farbe = Person-Nr.</div>
  </div>`;
  tip.hidden = false;
  const r = target.getBoundingClientRect();
  const tipR = tip.getBoundingClientRect();
  const above = r.top - tipR.height - 10;
  const top = above >= 8 ? above : r.bottom + 10;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  let left = r.left + r.width / 2 - tipR.width / 2;
  left = Math.max(8, Math.min(vw - tipR.width - 8, left));
  tip.style.top = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
}

function _hideTip(){
  if (_tipEl) _tipEl.hidden = true;
}

/**
 * Mount the legend into a host row (the overlay-toggles row, by
 * convention). Idempotent — calling again replaces the previous DOM
 * + listeners cleanly.
 *
 * @param {HTMLElement|string} host  Container element or its id.
 */
export function mountStatusLegend(host){
  const row = (typeof host === 'string') ? byId(host) : host;
  if (!row) return null;
  // Remove a previous mount if the lightbox is re-opening on a new
  // item (the row itself survives between renders inside a session).
  const prev = byId(_LEGEND_ID);
  if (prev) prev.remove();
  const wrap = document.createElement('div');
  wrap.id = _LEGEND_ID;
  wrap.className = 'lb-legend';
  // Desktop view + mobile collapse chip both live in the DOM at the
  // same time; CSS @media swaps which is visible. Keeps the layout
  // calculation simple and avoids re-mounting on orientation flips.
  wrap.innerHTML = `
    <div class="lb-legend-desktop" aria-label="Status-Legende">
      ${_ROWS.map(_rowHtml).join('')}
      <span class="lb-legend-tail">Farbe = Person-Nr.</span>
    </div>
    <button type="button" class="lb-legend-chip" aria-label="Status-Legende anzeigen" title="Status-Legende">?</button>`;
  row.appendChild(wrap);
  const chip = wrap.querySelector('.lb-legend-chip');
  let open = false;
  const close = () => { open = false; _hideTip(); };
  chip.addEventListener('click', (ev) => {
    ev.stopPropagation();
    open = !open;
    if (open) _showTip(chip);
    else _hideTip();
  });
  // Long-press for non-tap-tolerant input — same 500 ms threshold as
  // the per-pill popover for consistency.
  let lp = 0;
  chip.addEventListener('touchstart', () => {
    clearTimeout(lp);
    lp = setTimeout(() => {
      open = true;
      _showTip(chip);
    }, 500);
  }, { passive: true });
  chip.addEventListener('touchend', () => clearTimeout(lp));
  chip.addEventListener('touchcancel', () => clearTimeout(lp));
  // Outside-tap dismisses on mobile so the popover doesn't get
  // stranded over the video.
  const outside = (ev) => {
    if (!open) return;
    if (ev.target.closest && ev.target.closest('.lb-legend-chip')) return;
    if (ev.target.closest && ev.target.closest('.lb-legend-tip')) return;
    close();
  };
  document.addEventListener('touchstart', outside, { passive: true });
  document.addEventListener('click', outside);
  return {
    teardown: () => {
      document.removeEventListener('touchstart', outside);
      document.removeEventListener('click', outside);
      _hideTip();
      wrap.remove();
    },
  };
}
