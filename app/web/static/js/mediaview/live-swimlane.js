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
//     camId,
//     detBuffer,            // [{ms, label, score, bbox, verdict, track_num}]
//     windowMs,             // sliding window length (typically 60_000)
//     objectFilter,         // Set<string> | null — null = no filter
//   })
// The renderer is idempotent — calling repeatedly with a fresh
// detBuffer paints the latest snapshot. CSS handles transitions.

import { byId, esc } from '../core/dom.js';
import { OBJ_LABEL, OBJ_SVG, colors } from '../core/icons.js';

const _LANE_LABEL_ORDER = Object.keys(OBJ_LABEL);
const _ANDERE_ID = '__andere__';

export function renderLiveSwimlane(host, opts = {}) {
  if (!host) return;
  const detBuffer = Array.isArray(opts.detBuffer) ? opts.detBuffer : [];
  const windowMs = Number(opts.windowMs) || 60_000;
  const objectFilter = opts.objectFilter instanceof Set ? opts.objectFilter : null;
  const now = Date.now();
  const cutoff = now - windowMs;
  // Bucket per label, plus a separate "andere" bucket for off-filter
  // detections. Same detection enters at most one bucket.
  const byLabel = new Map();
  const andereByClass = new Map();
  let andereTotal = 0;
  for (const e of detBuffer) {
    if (!e || e.ms < cutoff) continue;
    if (objectFilter && !objectFilter.has(e.label)) {
      andereByClass.set(e.label, (andereByClass.get(e.label) || 0) + 1);
      andereTotal += 1;
      _bucket(byLabel, _ANDERE_ID, e);
      continue;
    }
    _bucket(byLabel, e.label, e);
  }
  const labels = _sortedLabels(byLabel.keys());
  // The "andere" lane always renders LAST. If the filter is null,
  // andereByClass is empty and the lane is rendered but empty (the
  // spec asks for a predictable layout). If there is no filter at
  // all (objectFilter null), the "andere" lane is omitted.
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
      andereTotal,
    });
  }
  host.innerHTML = _buildHtml(lanes, { windowMs, now });
}

function _bucket(map, key, entry) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(entry);
}

// OBJ_LABEL insertion order is the project's canonical lane sort.
// Anything outside that list (rare unknown labels, the synthetic
// "__andere__" key) appends at the end.
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

function _buildHtml(lanes, { windowMs }) {
  const laneRows = lanes
    .map((lane, idx) => _renderLane(lane, idx, windowMs))
    .join('');
  const axisLabels = ['60 s', '45 s', '30 s', '15 s', 'jetzt'];
  const axisHtml = axisLabels
    .map(
      (txt, i) =>
        `<span class="mv-ld-axis-tick" style="left:calc(${(i * 100) / (axisLabels.length - 1)}% - ${i === 0 ? 0 : i === axisLabels.length - 1 ? 24 : 12}px)">${esc(txt)}</span>`,
    )
    .join('');
  return `
    <div class="mv-ld-swim" data-lane-count="${lanes.length}">
      <div class="mv-ld-swim-rows">${laneRows}</div>
      <div class="mv-ld-swim-axis"><div class="mv-ld-swim-axis-track">${axisHtml}</div></div>
    </div>`;
}

function _renderLane(lane, idx, windowMs) {
  const isAndere = lane.id === _ANDERE_ID;
  const c = isAndere ? '#3d4654' : colors[lane.label] || colors.unknown;
  const labelCell = _renderLaneLabel(lane, isAndere);
  const bars = lane.samples
    .map((s) => _renderBar(s, windowMs, c, isAndere))
    .join('');
  const dataAttr = isAndere ? ' data-andere="1"' : '';
  return `
    <div class="mv-ld-swim-row" data-label="${esc(lane.label)}" data-lane-idx="${idx}"${dataAttr}>
      <div class="mv-ld-swim-cell mv-ld-swim-cell-label">${labelCell}</div>
      <div class="mv-ld-swim-cell mv-ld-swim-cell-events">${bars}</div>
    </div>`;
}

function _renderLaneLabel(lane, isAndere) {
  if (isAndere) {
    const n = lane.andereByClass ? lane.andereByClass.size : 0;
    return (
      '<span class="mv-ld-swim-icon mv-ld-swim-icon-andere" aria-hidden="true">' +
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<circle cx="6" cy="12" r="1.8" fill="#3d4654"/>' +
      '<circle cx="12" cy="12" r="1.8" fill="#3d4654"/>' +
      '<circle cx="18" cy="12" r="1.8" fill="#3d4654"/></svg>' +
      `</span><span class="mv-ld-swim-andere-count">${n}</span>`
    );
  }
  const raw = OBJ_SVG[lane.label] || '';
  const icon = raw
    ? raw.replace('width="16" height="16"', 'width="16" height="16"')
    : '<span class="mv-ld-swim-icon-fallback"></span>';
  return `<span class="mv-ld-swim-icon" aria-hidden="true">${icon}</span>`;
}

function _renderBar(sample, windowMs, color, isAndere) {
  const ageMs = Date.now() - sample.ms;
  if (ageMs < 0 || ageMs > windowMs) return '';
  // X-coordinate from the RIGHT edge — ageMs=0 sits at the right
  // edge, ageMs=windowMs at the left. Width is a fixed visual bar
  // (the actual time-span of a single detection sample is the tick
  // cadence, ~500 ms; reading that as a uniform bar matches the
  // user's mental model better than a 5 px sliver).
  const pct = 100 - (ageMs / windowMs) * 100;
  const barWidth = isAndere ? 6 : 10;
  const tn = Number.isFinite(sample.track_num) ? sample.track_num : null;
  const dataAttrs = tn != null ? ` data-track-num="${tn}"` : '';
  return (
    `<span class="mv-ld-swim-bar${isAndere ? ' mv-ld-swim-bar-andere' : ''}" ` +
    `style="left:calc(${pct.toFixed(2)}% - ${barWidth}px);width:${barWidth}px;background:${color}"` +
    dataAttrs +
    '></span>'
  );
}
