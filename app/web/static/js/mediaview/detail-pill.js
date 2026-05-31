// ─── mediaview/detail-pill.js ──────────────────────────────────────────────
// L5 · the ONE gauge-pill renderer. Score / Höhe / Fläche mini-bars with
// a Settings-Limit tick on the Score row (fill flips amber when the score
// sits below its configured threshold). Folds the two former copies into
// one owner:
//   * recorded — mediathek/bbox-overlay/confidence-meter.js builds the
//     active-track list (all visible/non-masked tracks at currentTime)
//     and calls this renderer.
//   * live     — live-detect.js builds a single-element list for the
//     pinned/selected label and calls this renderer.
//
// The renderer is pure presentation: each mode owns its host element +
// its absolute positioning (recorded #lightboxConfidenceMeter / live
// #mvLiveDetailPill); this file owns the inner `.mvdp-*` markup + the
// shared CSS (30g). One track → one card; the legend strip renders once.

import { esc } from '../core/dom.js';

// Amber when a Score gauge sits below its threshold — the operator's eye
// lands on under-threshold tracks immediately. Same warning hue used
// across the chrome (heartbeat / inference / telegram badges).
const _AMBER = '#f59e0b';

// One gauge row. valFrac / threshFrac are 0..1. The bar maps value→width%,
// the tick→(threshold*100)%. opts.showTick=false drops the tick (the
// Höhe/Fläche rows have no configurable threshold to mark); opts.amberBelow
// flips the fill to amber when value < threshold (Score row only).
function _row(label, valFrac, threshFrac, color, opts = {}) {
  const valPct = Math.min(100, Math.max(0, (valFrac || 0) * 100));
  const tickPct = Math.min(100, Math.max(0, (threshFrac ?? 0) * 100));
  const showTick = opts.showTick !== false && threshFrac != null;
  const fill =
    opts.amberBelow && threshFrac != null && valFrac < threshFrac ? _AMBER : color;
  return (
    `<div class="mvdp-row">` +
    `<div class="mvdp-row-head"><span class="mvdp-row-label">${esc(label)}</span>` +
    `<span class="mvdp-row-pct">${Math.round(valPct)} %</span></div>` +
    `<div class="mvdp-row-bar">` +
    `<span class="mvdp-row-fill" style="width:${valPct.toFixed(1)}%;background:${fill}"></span>` +
    (showTick
      ? `<span class="mvdp-row-tick" style="left:${tickPct.toFixed(1)}%"></span>` +
        `<span class="mvdp-row-tick-num" style="left:${tickPct.toFixed(1)}%">${Math.round(tickPct)}</span>`
      : '') +
    `</div></div>`
  );
}

const _LEGEND =
  `<div class="mvdp-legend" aria-hidden="true">` +
  `<span class="mvdp-legend-item"><span class="mvdp-legend-tick">▍</span> Settings-Limit</span>` +
  `<span class="mvdp-legend-item"><span class="mvdp-legend-fill">▪</span> Messwert</span></div>`;

/**
 * Render the gauge pill into a host element.
 *
 * @param {HTMLElement} host  The mode-owned, absolutely-positioned pill.
 * @param {Object} opts
 * @param {Array<Object>} opts.tracks  Normalised cards. Each:
 *   { label, color, score (0..1), scoreThresh (0..1|null), fracH (0..1|null),
 *     fracArea (0..1|null), num (int|null), missingThresh (bool) }.
 * @param {string} [opts.emptyText]  Shown when tracks is empty (live pins a
 *   label that isn't currently in frame). Omit → host hides entirely.
 */
export function renderDetailPill(host, opts = {}) {
  if (!host) return;
  const tracks = opts.tracks || [];
  if (!tracks.length) {
    if (opts.emptyText) {
      host.innerHTML = `<div class="mvdp-empty">${esc(opts.emptyText)}</div>`;
      host.hidden = false;
    } else {
      host.hidden = true;
    }
    return;
  }
  const blocks = tracks
    .map((t) => {
      const c = t.color || '#94a3b8';
      const rows = [
        _row('Score', t.score || 0, t.scoreThresh != null ? t.scoreThresh : null, c, {
          showTick: t.scoreThresh != null,
          amberBelow: true,
        }),
      ];
      if (t.fracH != null) rows.push(_row('Höhe', t.fracH, null, c, { showTick: false }));
      if (t.fracArea != null) rows.push(_row('Fläche', t.fracArea, null, c, { showTick: false }));
      const num = Number.isFinite(t.num) && t.num > 0 ? ` #${t.num}` : '';
      const missing = t.missingThresh
        ? `<div class="mvdp-missing">Schwelle nicht aufgezeichnet</div>`
        : '';
      return (
        `<div class="mvdp-track"><div class="mvdp-head" style="color:${c}">` +
        `${esc(t.label)}${num}</div>${missing}${rows.join('')}</div>`
      );
    })
    .join('');
  host.innerHTML = `${blocks}${_LEGEND}`;
  host.hidden = false;
}
