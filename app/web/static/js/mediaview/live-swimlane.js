// ─── mediaview/live-swimlane.js ───────────────────────────────────────────
// SIMU-03 · Live-Detect timeline renderer.
//
// The recorded-clip swimlane renderer in mediathek/bbox-overlay/
// timeline-panel.js is built around a scrubber bar + ticks + per-
// class strips + play cursor. Live-Detect doesn't have a scrubber
// (the window is always "live 60 s ago → now"), the visual language
// is icon-only lanes, the LIVE marker sits stacked above a single
// vertical green line spanning all lanes, bars flow right → left
// and drop off the left edge after 60 s. Trying to bend the recorded
// renderer to all of that would compromise both code paths; this
// dedicated renderer keeps the recorded one untouched.
//
// Caller contract:
//   renderLiveSwimlane(host, {
//     camId, detBuffer, windowMs, objectFilter,
//   })
//
// SIMU-03e · the renderer does TARGETED bar updates between ticks
// (existing bar's `left` is updated, CSS transitions over 500 ms)
// so the strip flows leftward smoothly instead of jumping in
// discrete tick-sized steps. Lane structure rebuilds only when the
// set of lanes changes (a new class appears, andere lane toggles).

import { esc } from '../core/dom.js';
import { OBJ_LABEL, OBJ_SVG, colors } from '../core/icons.js';

const _LANE_LABEL_ORDER = Object.keys(OBJ_LABEL);
const _ANDERE_ID = '__andere__';

export function renderLiveSwimlane(host, opts = {}) {
  if (!host) return;
  const detBuffer = Array.isArray(opts.detBuffer) ? opts.detBuffer : [];
  const windowMs = Number(opts.windowMs) || 60_000;
  const objectFilter = opts.objectFilter instanceof Set ? opts.objectFilter : null;
  const lanes = _computeLanes(detBuffer, windowMs, objectFilter);
  // Lane-structure fingerprint — rebuild only when lane membership
  // changes so bar elements survive across ticks (CSS `left`
  // transition then animates the leftward flow).
  const fp = lanes.map((l) => l.id).join('|');
  if (host.dataset.mvLdFp !== fp) {
    host.innerHTML = _buildStructure(lanes);
    host.dataset.mvLdFp = fp;
  }
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i];
    // SIMU-FIX-04b · SIMU-03g refactored the swimlane into a single
    // CSS grid, removing the `.mv-ld-swim-row` wrapper. The bar-sync
    // query was never updated to match the new structure → no cell
    // was ever found → no bars were ever appended. Query the event
    // cell directly by its lane-idx data attribute.
    const cell = host.querySelector(
      `.mv-ld-swim-cell-events[data-lane-idx="${i}"]`,
    );
    if (!cell) continue;
    // POLISH-01b · the Andere lane is a STATUS COUNTER, not a
    // visualisation. Render a single "Andere · N" pill instead of a
    // bar per off-filter detection (which flooded the lane with grey
    // dashed hash-noise + meaningless track-num badges on a TV-heavy
    // room). Per-class lanes keep their flowing bars.
    if (lane.id === _ANDERE_ID) {
      _renderAndereCounter(cell, lane);
    } else {
      _syncBars(cell, lane, windowMs);
    }
  }
}

// POLISH-01b · render the Andere lane's counter pill. N = total
// off-filter detections in the 60 s window. The pill carries a
// title attr with the top-3 class breakdown (browser-native
// long-press tooltip on iOS, hover on desktop) so the user can see
// WHAT was filtered without the lane screaming.
function _renderAndereCounter(cell, lane) {
  const byClass = lane.andereByClass || new Map();
  let total = 0;
  for (const n of byClass.values()) total += n;
  const top = Array.from(byClass.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cls, n]) => `${cls} ${n}×`)
    .join(' · ');
  const title = total > 0 ? top : 'keine off-filter Detektionen';
  cell.innerHTML =
    `<span class="mv-ld-andere-counter" title="${esc(title)}">andere · ${total}</span>`;
}

function _computeLanes(detBuffer, windowMs, objectFilter) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const byLabel = new Map();
  const andereByClass = new Map();
  for (const e of detBuffer) {
    if (!e || e.ms < cutoff) continue;
    if (objectFilter && !objectFilter.has(e.label)) {
      andereByClass.set(e.label, (andereByClass.get(e.label) || 0) + 1);
      _bucket(byLabel, _ANDERE_ID, e);
      continue;
    }
    _bucket(byLabel, e.label, e);
  }
  const labels = _sortedLabels(byLabel.keys());
  const lanes = [];
  for (const lbl of labels) {
    if (lbl === _ANDERE_ID) continue;
    lanes.push({ id: lbl, label: lbl, samples: byLabel.get(lbl) || [] });
  }
  if (objectFilter) {
    lanes.push({
      id: _ANDERE_ID,
      label: 'andere',
      samples: byLabel.get(_ANDERE_ID) || [],
      andereByClass,
    });
  }
  return lanes;
}

function _bucket(map, key, entry) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(entry);
}

function _sortedLabels(iter) {
  const arr = Array.from(iter);
  arr.sort((a, b) => {
    if (a === _ANDERE_ID) return 1;
    if (b === _ANDERE_ID) return -1;
    const ai = _LANE_LABEL_ORDER.indexOf(a);
    const bi = _LANE_LABEL_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return arr;
}

// SIMU-03g · single CSS-grid layout for the entire swimlane. The
// container is `display: grid; grid-template-columns: 36px 1fr;
// grid-auto-rows: 22px`. Per lane we emit BOTH the label cell and
// the event cell in a single pass with the SAME `grid-row`, which
// is the spec's guarantee against label ↔ event drift. The LIVE
// pill + vertical line span the full row range via grid-row: 1/-1
// and live in column 2 (right of the label band).
function _buildStructure(lanes) {
  const cells = [];
  for (let i = 0; i < lanes.length; i++) {
    cells.push(_renderLaneCells(lanes[i], i, i + 1));
  }
  const axisLabels = ['60 s', '45 s', '30 s', '15 s', 'jetzt'];
  const axisHtml = axisLabels
    .map(
      (txt, i) =>
        `<span class="mv-ld-axis-tick" style="left:calc(${(i * 100) / (axisLabels.length - 1)}% - ${i === 0 ? 0 : i === axisLabels.length - 1 ? 24 : 12}px)">${esc(txt)}</span>`,
    )
    .join('');
  const liveMarker =
    '<div class="mv-ld-swim-live" aria-hidden="true">' +
    '<span class="mv-ld-swim-pill"><span class="mv-ld-swim-pill-dot"></span><span class="mv-ld-swim-pill-lbl">LIVE</span></span>' +
    '<span class="mv-ld-swim-line"></span>' +
    '</div>';
  return `
    <div class="mv-ld-swim" data-lane-count="${lanes.length}">
      <div class="mv-ld-swim-grid" data-rows="${lanes.length}">${cells.join('')}${liveMarker}</div>
      <div class="mv-ld-swim-axis"><div class="mv-ld-swim-axis-track">${axisHtml}</div></div>
    </div>`;
}

function _renderLaneCells(lane, idx, gridRow) {
  const isAndere = lane.id === _ANDERE_ID;
  const labelCell = _renderLaneLabel(lane, isAndere);
  const andereAttr = isAndere ? ' data-andere="1"' : '';
  // Wrapped in a fragment-style pair so the renderer signals the
  // label and the event row together — same grid-row stamp on both.
  return (
    `<div class="mv-ld-swim-cell mv-ld-swim-cell-label" data-lane-idx="${idx}" data-label="${esc(lane.label)}"${andereAttr} style="grid-row:${gridRow};grid-column:1">${labelCell}</div>` +
    `<div class="mv-ld-swim-cell mv-ld-swim-cell-events" data-lane-idx="${idx}" data-label="${esc(lane.label)}"${andereAttr} style="grid-row:${gridRow};grid-column:2"></div>`
  );
}

function _renderLaneLabel(lane, isAndere) {
  if (isAndere) {
    const n = lane.andereByClass ? lane.andereByClass.size : 0;
    const title = n > 0 ? _andereTooltip(lane.andereByClass) : 'andere · keine Detektionen';
    return (
      '<span class="mv-ld-swim-icon mv-ld-swim-icon-andere" aria-hidden="true" ' +
      `title="${esc(title)}">` +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<circle cx="6" cy="12" r="1.8" fill="#3d4654"/>' +
      '<circle cx="12" cy="12" r="1.8" fill="#3d4654"/>' +
      '<circle cx="18" cy="12" r="1.8" fill="#3d4654"/></svg>' +
      '</span>'
    );
  }
  const raw = OBJ_SVG[lane.label] || '';
  if (!raw) {
    return '<span class="mv-ld-swim-icon" aria-hidden="true"><span class="mv-ld-swim-icon-fallback"></span></span>';
  }
  return `<span class="mv-ld-swim-icon" aria-hidden="true">${raw}</span>`;
}

function _andereTooltip(byClass) {
  if (!byClass || byClass.size === 0) return 'andere · keine Detektionen';
  const parts = [];
  const sorted = Array.from(byClass.entries()).sort((a, b) => b[1] - a[1]);
  for (const [cls, n] of sorted) {
    parts.push(`${cls} (${n})`);
  }
  return `andere · ${parts.join(' · ')}`;
}

// SIMU-03e · sync bars within an event cell. Existing bars (matched
// by `data-bar-key`) get their `left` updated — CSS `transition:
// left 500ms linear` on the bar class animates the leftward flow.
// New bars (no match) are appended at their initial `left` (no
// transition). Orphan bars (existed but no longer in the sample
// list) are removed.
function _syncBars(cell, lane, windowMs) {
  const now = Date.now();
  const isAndere = lane.id === _ANDERE_ID;
  const c = isAndere ? '#3d4654' : colors[lane.label] || colors.unknown;
  const existing = new Map();
  cell.querySelectorAll('.mv-ld-swim-bar').forEach((el) => {
    const key = el.dataset.barKey;
    if (key) existing.set(key, el);
  });
  const used = new Set();
  // SIMU-03f track-num badge geometry — 14 × 6 px, dark text on the
  // bar's class colour. Only rendered at the bar's LEFT end (spawn
  // point); CSS keeps the badge fixed at the bar's left edge even
  // as the bar slides leftward.
  const barWidth = isAndere ? 6 : 10;
  for (const s of lane.samples) {
    const ageMs = now - s.ms;
    if (ageMs < 0 || ageMs > windowMs) continue;
    const key = `${s.ms}:${s.label}`;
    used.add(key);
    const pct = 100 - (ageMs / windowMs) * 100;
    const leftCss = `calc(${pct.toFixed(2)}% - ${barWidth}px)`;
    let el = existing.get(key);
    if (el) {
      el.style.left = leftCss;
    } else {
      el = document.createElement('span');
      el.className = isAndere ? 'mv-ld-swim-bar mv-ld-swim-bar-andere' : 'mv-ld-swim-bar';
      el.dataset.barKey = key;
      el.style.left = leftCss;
      el.style.width = `${barWidth}px`;
      // SIMU-03f · the bar carries its class colour via a CSS custom
      // property so the ::before #N badge can paint the same fill
      // without inheriting (background isn't inheritable). Andere
      // bars use their striped pattern and skip the var.
      if (!isAndere) {
        el.style.background = c;
        el.style.setProperty('--bar-color', c);
      }
      if (Number.isFinite(s.track_num) && s.track_num > 0) {
        el.dataset.trackNum = String(s.track_num);
      }
      cell.appendChild(el);
    }
  }
  for (const [key, el] of existing) {
    if (!used.has(key)) el.remove();
  }
}
