// ─── mediaview/live-detect-panels.js ───────────────────────────────────────
// Live-detect tab/panel renderers: Detections tab (active tracks / verworfen /
// track-events), the live swimlane adapter, the selected-label detail pill, and
// the Trace tab. Reads shared state via S; the bbox-overlay + scrubber it pokes
// on selection live in the entry module (call-time circular import — both are
// only invoked at runtime, never at module-eval).
import { byId, esc } from '../core/dom.js';
import { state } from '../core/state.js';
import { OBJ_LABEL, OBJ_SVG, objIconSvg, colors } from '../core/icons.js';
import { renderLiveSwimlane } from './live-swimlane.js';
import { renderLiveTrace, tracePrefix } from './live-trace.js';
import { renderDetailPill } from './detail-pill.js';
import { zoneEl, getActiveTab, panelEl } from './live-detect-skeleton.js';
import { S } from './live-detect-state.js';
import {
  _LIVE_WINDOW_MS,
  _TRACE_CAP,
  _TRACE_TICK_CAP,
} from './live-detect.js';
import { _renderBboxOverlay } from './live-detect-bbox.js';
import { _pinScrubberRight } from './live-detect-chrome.js';

export function _renderDetectionsPanel(data) {
  // SIMU-04b · the Detections tab content is three sections:
  //   1. AKTIVE TRACKS — pass-verdict dets with their track-#N badge
  //   2. VERWORFEN     — filtered (off-filter class) dets, current tick only
  //   3. TRACK-EREIGNISSE — last 30 s of SPAWN/CONT/DEATH/RE-ID lines
  //                          derived from the decision_trace stream
  // Sections render in this order, each preceded by a tiny matrix-
  // muted mini-header. Empty states are per-section so a screenshot
  // tells the user which signal is silent vs which has data.
  const detHost = byId('mvLdDetections');
  if (!detHost) return;
  const dets = data.detections || [];
  const cam = (state.cameras || []).find((c) => c.id === S.session?.camId) || {};
  const filterArr = Array.isArray(cam.object_filter) ? cam.object_filter : null;
  const objFilter = filterArr && filterArr.length > 0 ? new Set(filterArr) : null;
  // SECTION 1 · Active tracks. "Active" here = the pass-verdict
  // detections from the current tick, sorted by OBJ_LABEL order then
  // score descending. age_seconds isn't surfaced by the backend yet —
  // for SIMU-04b we omit the lifetime cell on a no-data fallback.
  const passDets = dets.filter((d) => d.verdict === 'pass');
  passDets.sort((a, b) => {
    const ai = Object.keys(OBJ_LABEL).indexOf(a.label);
    const bi = Object.keys(OBJ_LABEL).indexOf(b.label);
    if (ai !== bi) return ai - bi;
    return (b.score || 0) - (a.score || 0);
  });
  const activeRowsHtml = passDets.length
    ? passDets.map((d) => _renderActiveTrackRow(d)).join('')
    : '<div class="mv-ld-empty-row">Noch keine Detektion</div>';
  // SECTION 2 · Verworfen — filtered (off-filter) detections from
  // current tick. Only rendered when at least one such row exists.
  const filteredDets = dets
    .filter((d) => {
      if (d.verdict !== 'filtered') return false;
      if (objFilter && objFilter.has(d.label)) return false;
      return true;
    })
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  const verworfenHtml = filteredDets.length
    ? `<div class="mv-ld-section-head">VERWORFEN (KLASSE NICHT IM FILTER)</div>` +
      filteredDets.map((d) => _renderVerworfenRow(d)).join('')
    : '';
  // SECTION 3 · Track-Ereignisse · last 30 s. Pulled from the trace
  // log we already maintain in S.traceLines. Filter to the "[det]" /
  // "[track]" lines and stamp them with a coloured tag.
  const events = S.traceLines.slice(-30);
  const trackEventsHtml = _buildTrackEventsHtml();
  // SIMU-04d · when ALL three sections are empty, collapse to a
  // single muted line instead of stacking three sub-empty rows.
  if (!passDets.length && !filteredDets.length && !events.length) {
    detHost.innerHTML = '<div class="mv-ld-empty-row">Noch keine Detektion</div>';
    return;
  }
  detHost.innerHTML =
    `<div class="mv-ld-section">
      <div class="mv-ld-section-head">AKTIVE TRACKS</div>
      ${activeRowsHtml}
    </div>` +
    (verworfenHtml ? `<div class="mv-ld-section">${verworfenHtml}</div>` : '') +
    `<div class="mv-ld-section">
      <div class="mv-ld-section-head">TRACK-EREIGNISSE LETZTE 30 s</div>
      ${trackEventsHtml}
    </div>`;
  detHost.querySelectorAll('.mv-ld-row[data-label]').forEach((row) => {
    row.addEventListener('click', () => {
      const lbl = row.dataset.label;
      S.selectedLabel = S.selectedLabel === lbl ? null : lbl;
      _renderBboxOverlay();
      _renderDetailPill();
    });
  });
}

export function _renderActiveTrackRow(d) {
  const c = colors[d.label] || colors.unknown;
  const lblText = OBJ_LABEL[d.label] || d.label;
  const iconRaw = OBJ_SVG[d.label] || '';
  const iconHtml = iconRaw.replace('width="16" height="16"', 'width="14" height="14"');
  const tn = Number.isFinite(d.track_num) ? d.track_num : null;
  const scorePct = Math.round((d.score || 0) * 100);
  const ageStr = d.age_seconds != null ? `${Math.round(d.age_seconds)} s` : '';
  return `<button type="button" class="mv-ld-row mv-ld-row-active" data-label="${esc(d.label)}">
    <span class="mv-ld-row-icon">${iconHtml}</span>
    ${tn != null ? `<span class="mv-ld-row-num" style="background:${c}">#${tn}</span>` : '<span class="mv-ld-row-num-spacer"></span>'}
    <span class="mv-ld-row-label">${esc(lblText)}</span>
    ${ageStr ? `<span class="mv-ld-row-age">${esc(ageStr)}</span>` : ''}
    <span class="mv-ld-row-verdict mv-ld-row-verdict-pass">PASS ${scorePct}%</span>
  </button>`;
}

export function _renderVerworfenRow(d) {
  const scorePct = Math.round((d.score || 0) * 100);
  return `<div class="mv-ld-row mv-ld-row-verworfen">
    <span class="mv-ld-row-icon mv-ld-row-icon-andere" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <circle cx="6" cy="12" r="1.6" fill="#5a7a68"/>
        <circle cx="12" cy="12" r="1.6" fill="#5a7a68"/>
        <circle cx="18" cy="12" r="1.6" fill="#5a7a68"/>
      </svg>
    </span>
    <span class="mv-ld-row-label">${esc(d.label)}</span>
    <span class="mv-ld-row-score">${scorePct}%</span>
    <span class="mv-ld-row-verdict mv-ld-row-verdict-mute">gefiltert</span>
  </div>`;
}

// Build the last-30-s track events log from the in-memory trace
// lines. For SIMU-04b we derive events from the existing decision_
// trace stream (no backend ring buffer yet): [det] lines map to
// CONT./SPAWN heuristically based on whether the bbox label has
// been seen recently. RE-ID and explicit DEATH events come in
// SIMU-05 when the backend adds the ring buffer.
export function _buildTrackEventsHtml() {
  const lines = S.traceLines.slice(-30).reverse();
  if (!lines.length) {
    return '<div class="mv-ld-empty-row">Noch keine Track-Ereignisse</div>';
  }
  return lines
    .map((line) => {
      const text = typeof line === 'string' ? line : line?.text || '';
      const kind = _classifyTrackEvent(text);
      const tagColor =
        kind === 'spawn'
          ? '#6ee7b7'
          : kind === 'death'
            ? '#fda4af'
            : kind === 'reid'
              ? '#ffcd6e'
              : '#b6d4be';
      const tagLabel =
        kind === 'spawn'
          ? 'SPAWN'
          : kind === 'death'
            ? 'DEATH'
            : kind === 'reid'
              ? 'RE-ID'
              : 'CONT.';
      return `<div class="mv-ld-track-event">
        <span class="mv-ld-track-event-tag" style="color:${tagColor}">${tagLabel}</span>
        <span class="mv-ld-track-event-text">${esc(text)}</span>
      </div>`;
    })
    .join('');
}

export function _classifyTrackEvent(text) {
  if (!text) return 'cont';
  if (text.indexOf('REJECTED') !== -1 || text.indexOf('grace') !== -1) return 'death';
  if (text.indexOf('PASS') !== -1) return 'spawn';
  if (text.indexOf('re-id') !== -1 || text.indexOf('RE-ID') !== -1) return 'reid';
  return 'cont';
}

export function _renderLiveSwimlane() {
  // Build a synthetic _tracks payload from the 60 s buffer (one
  // synthetic track per label) and ask the recorded swimlane to
  // render it. Sample timestamps are shifted into [0, 60] so the
  // existing rendering treats the window as a 60-second "clip".
  if (!S.session) return;
  const now = Date.now();
  const windowStart = now - _LIVE_WINDOW_MS;
  // SIMU-03a · enforce the camera's object_filter. Off-filter
  // detections stay in S.detBuffer (the Trace tab + "Andere" lane
  // below still surface them) but they don't get their own
  // swimlane row. Mirrors mediathek/bbox-overlay/timeline-panel.js
  // line 225 — same gate, applied per detection on the live window.
  const cam = (state.cameras || []).find((c) => c.id === S.session.camId) || {};
  const filterArr = Array.isArray(cam.object_filter) ? cam.object_filter : null;
  const objFilter = filterArr && filterArr.length > 0 ? new Set(filterArr) : null;
  const byLabel = new Map();
  for (const e of S.detBuffer) {
    if (e.ms < windowStart) continue;
    if (objFilter && !objFilter.has(e.label)) continue;
    const t = (e.ms - windowStart) / 1000;
    if (!byLabel.has(e.label)) byLabel.set(e.label, []);
    byLabel.get(e.label).push({
      f: byLabel.get(e.label).length,
      t,
      bbox: {
        x1: e.bbox?.[0] || 0,
        y1: e.bbox?.[1] || 0,
        x2: (e.bbox?.[0] || 0) + (e.bbox?.[2] || 0),
        y2: (e.bbox?.[1] || 0) + (e.bbox?.[3] || 0),
      },
      score: e.score,
      source: 'detect',
    });
  }
  // SIMU-03a · canonical OBJ_LABEL order for the kept lanes.
  // OBJ_LABEL's insertion order is the canonical project sort
  // (person · cat · bird · car · dog · squirrel · motion · alarm).
  // Labels not in OBJ_LABEL (rare unknowns) sort to the end
  // alphabetically.
  const labelOrder = Object.keys(OBJ_LABEL);
  const sortedLabels = Array.from(byLabel.keys()).sort((a, b) => {
    const ai = labelOrder.indexOf(a);
    const bi = labelOrder.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  // 1-based per-render _num so the timeline-panel renders "#1", "#2"
  // bar labels instead of "#undefined". Mirrors the stamping that
  // bbox-overlay/fetcher.js does on recorded tracks at fetch time —
  // the timeline-panel reads tr._num directly.
  const tracks = [];
  let _num = 0;
  for (const label of sortedLabels) {
    const samples = byLabel.get(label);
    _num += 1;
    tracks.push({
      track_id: `live-${label}`,
      _num,
      label,
      color: colors[label] || '#94a3b8',
      first_frame: 0,
      last_frame: samples.length - 1,
      best_score: Math.max(0, ...samples.map((s) => s.score || 0)),
      best_frame: 0,
      samples,
    });
  }
  // SIMU-03b · the live-specific swimlane renderer takes over from
  // the recorded lbRenderTrackTimeline. Same #lightboxBottomStack
  // host; cleaner layout, "Andere" lane for off-filter detections,
  // and the SIMU-03c-g progression (icon labels, LIVE marker,
  // scrolling, track-#N badges, CSS grid) builds on top.
  const stackHost = byId('lightboxBottomStack');
  if (stackHost) {
    renderLiveSwimlane(stackHost, {
      camId: S.session.camId,
      detBuffer: S.detBuffer,
      windowMs: _LIVE_WINDOW_MS,
      objectFilter: objFilter,
    });
  }
  // The synthetic liveItem is still surfaced for any callers that
  // index off S.session.lastTracks (e.g. SIMU-04+ panel renderers).
  S.session.lastTracksItem = {
    type: 'live-detect',
    event_id: `live-${S.session.camId}`,
    camera_id: S.session.camId,
    _tracks: {
      tracks,
      filter_applied: filterArr,
      duration_s: _LIVE_WINDOW_MS / 1000,
    },
  };
  _pinScrubberRight();
}

export function _renderDetailPill() {
  // SIMU-01 · pill sits over the video at the bottom-left corner.
  const host = zoneEl('video') || byId('lightboxMediaWrap');
  if (!host) return;
  let pill = byId('mvLiveDetailPill');
  if (!S.selectedLabel) {
    if (pill) pill.remove();
    return;
  }
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'mvLiveDetailPill';
    pill.className = 'mv-live-detail-pill';
    host.appendChild(pill);
  }
  const c = colors[S.selectedLabel] || colors.unknown;
  const lblText = OBJ_LABEL[S.selectedLabel] || S.selectedLabel;
  // Find the live detection for this label (most recent).
  const det = (S.session?.lastDetections || []).find((d) => d.label === S.selectedLabel);
  if (!det) {
    // L5 · shared renderer's empty-state so the "not in frame" copy
    // matches every mode.
    renderDetailPill(pill, { tracks: [], emptyText: `${lblText} · aktuell nicht im Bild` });
    return;
  }
  const cam = (state.cameras || []).find((x) => x.id === S.session.camId) || {};
  const perCls = cam.label_thresholds || {};
  const generalThresh = Number(cam.detection_min_score) || 0.55;
  const scoreThresh =
    perCls[S.selectedLabel] != null ? Number(perCls[S.selectedLabel]) : generalThresh;
  const fs = S.session.lastFrameSize || { w: 1920, h: 1080 };
  const bh = det.bbox?.[3] || 0;
  const bw = det.bbox?.[2] || 0;
  // L5 · the ONE shared gauge renderer (detail-pill.js) — single-track
  // card for the pinned label (Score with Settings-Limit tick + amber
  // below, Höhe, Fläche). Same cards the recorded gauge draws.
  renderDetailPill(pill, {
    tracks: [
      {
        label: lblText,
        color: c,
        score: det.score || 0,
        scoreThresh,
        fracH: fs.h > 0 ? bh / fs.h : 0,
        fracArea: fs.w * fs.h > 0 ? (bw * bh) / (fs.w * fs.h) : 0,
        num: Number.isFinite(det.track_num) ? det.track_num : null,
      },
    ],
  });
}

export function _appendTrace(lines) {
  if (!Array.isArray(lines) || !S.session) return;
  for (const line of lines) {
    S.traceLines.push({ kind: _classifyTrace(line), text: line });
  }
  while (S.traceLines.length > _TRACE_CAP) S.traceLines.shift();
  // Detections-tab fold (flat running log + diag header).
  if (S.session.fold) {
    const body = document.querySelector('#lightboxSettings .mv-fafold-body');
    const wasAtBottom = body ? body.scrollHeight - body.scrollTop - body.clientHeight < 24 : true;
    S.session.fold.setLines(S.traceLines);
    if (body && wasAtBottom) {
      body.scrollTop = body.scrollHeight;
    }
  }
  // Q2-3 · record this tick as a group for the Trace tab's per-tick
  // view. Each _appendTrace call is exactly one backend tick's
  // decision_trace, so one push == one block, newest-on-top in the tab.
  if (lines.length) {
    S.traceTicks.push({
      ts: Date.now(),
      lines: lines.map((l) => ({ prefix: tracePrefix(l), text: l })),
    });
    while (S.traceTicks.length > _TRACE_TICK_CAP) S.traceTicks.shift();
  }
  _renderTraceTab();
}

// Q2-3 · paint the per-tick trace into the Trace tab panel
// (#mvLdPanel-trace) — the panel the skeleton created but nothing ever
// rendered into. Gated on the tab being active (cheap no-op otherwise);
// the onTabChange bridge repaints on switch-in so it's never stale.
export function _renderTraceTab() {
  if (typeof getActiveTab === 'function' && getActiveTab() !== 'trace') return;
  const host = panelEl('trace');
  if (host) renderLiveTrace(host, S.traceTicks);
}

export function _classifyTrace(line) {
  if (!line) return 'info';
  if (line.indexOf(' PASS') !== -1) return 'pass';
  if (line.indexOf(' REJECTED') !== -1 || line.indexOf(' FILTERED') !== -1) return 'reject';
  if (line.indexOf('no detection survived') !== -1) return 'no-detection';
  return 'info';
}

// Suppress the OBJ_SVG / objIconSvg "imported but unused" warnings —
// kept around in case a future refactor lifts the detail-pill into
// the shared detail-pill.js module which uses these for the
// per-class icon glyph above the gauges. Cheaper than re-importing
// when that lands.
void OBJ_SVG;
void objIconSvg;
