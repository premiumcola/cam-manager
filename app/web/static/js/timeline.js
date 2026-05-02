// ─── timeline.js ───────────────────────────────────────────────────────────
// Stage 6 of the legacy.js → ES modules refactor — the 7d/30d event
// timeline shown on the dashboard. Renders every camera as a stack of
// per-class lanes; click a bar to navigate to the Mediathek pre-
// filtered to that camera+label slice.
import { state, STAT_MEDIA_DRILLDOWN } from './core/state.js';
import { byId, esc } from './core/dom.js';
import { colors, OBJ_LABEL, OBJ_SVG, getCameraIcon } from './core/icons.js';

export const CAT_COLORS = {
  alle: '#8888aa', motion: '#cbd5e1', person: '#facc15', cat: '#fb923c',
  bird: '#38bdf8', car: '#f87171', dog: '#7c2d12', squirrel: '#7c4a1f',
  timelapse: '#a855f7',
};
// Lane order top-down; lanes auto-filter by content presence (any lane
// with zero events in the visible time range is omitted).
export const TL_LANES = ['motion', 'person', 'cat', 'bird', 'car', 'dog', 'squirrel'];
export const GAP_MS = 2 * 60 * 1000;

function _tlGroupLane(points, label, tMin, tMax) {
  const filtered = points
    .filter(p => {
      const t = new Date(p.time).getTime();
      if (!t || t < tMin || t > tMax) return false;
      const labs = p.labels || [];
      if (label === 'motion') return labs.length === 0 || labs.every(l => l === 'motion');
      return labs.includes(label);
    })
    .sort((a, b) => new Date(a.time) - new Date(b.time));
  const groups = [];
  let curr = null;
  for (const p of filtered) {
    const t = new Date(p.time).getTime();
    if (!curr || t - curr.endTime > GAP_MS) {
      curr = { startTime: t, endTime: t, count: 1 };
      groups.push(curr);
    } else {
      curr.endTime = t;
      curr.count++;
    }
  }
  return groups;
}

function _tlFmtTs(ts, hours) {
  const d = new Date(ts);
  if (hours <= 3)   return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  if (hours <= 24)  return d.getHours().toString().padStart(2, '0') + ':00';
  if (hours <= 168) return ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][d.getDay()] + ' ' + d.getDate() + '.' + (d.getMonth() + 1);
  return d.getDate() + '.' + (d.getMonth() + 1) + '.';
}

export function renderTimeline() {
  const container = byId('timelineContainer'); if (!container) return;
  const tracks = state.timeline?.tracks || [];

  let earliestMs = null;
  tracks.forEach(tr => {
    (tr.points || []).forEach(p => {
      const t = new Date(p.time).getTime();
      if (t && (!earliestMs || t < earliestMs)) earliestMs = t;
    });
  });
  const now = Date.now();

  const slider = byId('tlRangeSlider');
  if (slider && earliestMs && !state._tlInitialized) {
    const dataHours = Math.max(1, Math.ceil((now - earliestMs) / 3600000));
    state.tlHours = dataHours;
    state._tlInitialized = true;
    slider.value = dataHours;
  }

  const hours = state.tlHours || 12;
  const lbl = byId('tlRangeLabel');
  if (lbl) lbl.textContent = hours < 24 ? `letzte ${hours}h` : `${Math.round(hours / 24)} Tage`;

  const tMax = now;
  let tMin = now - hours * 3600000;
  if (earliestMs && earliestMs > tMin) tMin = earliestMs;
  const span = tMax - tMin || 1;

  const camLaneGroups = tracks.map(tr => {
    const lanes = TL_LANES
      .map(label => ({ label, groups: _tlGroupLane(tr.points || [], label, tMin, tMax) }))
      .filter(l => l.groups.length > 0);
    return { tr, lanes };
  }).filter(c => c.lanes.length > 0);

  if (!camLaneGroups.length) {
    container.innerHTML = '<div class="tl-empty">Keine Ereignisse im gewählten Zeitraum.</div>';
    return;
  }

  let html = '';
  camLaneGroups.forEach(({ tr, lanes }, ti) => {
    const cam = (state.config?.cameras || []).find(c => c.id === tr.camera_id) || {};
    const camName = cam.name || tr.camera_id;
    const camIcon = getCameraIcon(camName);
    html += `<div class="tl-cam-block${ti > 0 ? ' tl-cam-block--notfirst' : ''}">`;
    const sbCls = STAT_MEDIA_DRILLDOWN ? 'tl-cam-sidebox stat-drillable' : 'tl-cam-sidebox';
    const sbClick = STAT_MEDIA_DRILLDOWN ? `onclick="_statOpenMedia('${esc(tr.camera_id)}','')"` : '';
    html += `<div class="${sbCls}" ${sbClick}><div class="tl-cam-icon">${camIcon}</div><div class="tl-cam-name">${esc(camName)}</div></div>`;
    html += `<div class="tl-lanes-wrap">`;
    for (let k = 1; k < 5; k++) html += `<div class="tl-vgrid" style="left:calc(var(--tl-label-w) + (100% - var(--tl-label-w))*${k}/5)"></div>`;
    lanes.forEach(({ label, groups }) => {
      const color = colors[label] || colors.unknown;
      const labelText = OBJ_LABEL[label] || label;
      html += `<div class="tl-lane">`;
      html += `<div class="tl-lane-label" style="--lane-c:${CAT_COLORS[label] || '#8888aa'}"><span class="tl-lane-label-icon">${OBJ_SVG[label] || ''}</span><span class="tl-lane-label-text">${labelText}</span></div>`;
      html += `<div class="tl-track">`;
      groups.forEach(g => {
        const leftPct = Math.max(0, (g.startTime - tMin) / span * 100);
        const widthPct = Math.max(0.8, Math.min((g.endTime - g.startTime) / span * 100, 100 - leftPct));
        if (leftPct >= 100) return;
        html += `<div class="tl-bar" style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;background:${color};opacity:0.85" data-camid="${esc(tr.camera_id)}" data-label="${esc(label)}" title="${g.count} Events · ${labelText}"></div>`;
      });
      html += `</div></div>`;
    });
    html += `</div></div>`;
  });

  html += `<div class="tl-xaxis">`;
  for (let k = 0; k < 6; k++) html += `<span class="tl-xlabel">${_tlFmtTs(tMin + span * k / 5, hours)}</span>`;
  html += `</div>`;
  container.innerHTML = html;

  // Bar click → navigate to Mediathek. Touch devices show a small tip
  // first on the inaugural tap; second tap navigates. Mediathek
  // navigation goes via window.X because loadMedia + renderMediaGrid
  // still live in legacy.js.
  const _isCoarsePtr = () => window.matchMedia('(hover:none) and (pointer:coarse)').matches;
  container.querySelectorAll('.tl-bar').forEach(bar => {
    bar.onclick = (ev) => {
      if (_isCoarsePtr() && !bar.classList.contains('tl-bar--tip-shown')) {
        ev.preventDefault();
        _tlShowBarTooltip(bar);
        return;
      }
      state.mediaCamera = bar.dataset.camid;
      state.mediaLabels = bar.dataset.label ? new Set([bar.dataset.label]) : new Set();
      document.querySelector('#media').scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (typeof window.loadMedia === 'function') {
        window.loadMedia().then(() => window.renderMediaGrid && window.renderMediaGrid());
      }
    };
  });
}

let _tlTipEl = null, _tlTipTimer = 0;
function _tlShowBarTooltip(bar) {
  const text = bar.getAttribute('title') || '';
  if (!text) return;
  if (!_tlTipEl) {
    _tlTipEl = document.createElement('div');
    _tlTipEl.className = 'tl-bar-tooltip';
    document.body.appendChild(_tlTipEl);
  }
  _tlTipEl.textContent = text;
  const r = bar.getBoundingClientRect();
  _tlTipEl.style.left = Math.max(8, Math.min(window.innerWidth - 220, r.left + r.width / 2 - 110)) + 'px';
  _tlTipEl.style.top = Math.max(8, r.top - 44) + 'px';
  _tlTipEl.classList.add('visible');
  bar.classList.add('tl-bar--tip-shown');
  clearTimeout(_tlTipTimer);
  _tlTipTimer = setTimeout(() => _tlHideBarTooltip(), 2500);
  document.addEventListener('click', _tlOutsideTipHandler, { capture: true, once: true });
}
function _tlHideBarTooltip() {
  if (_tlTipEl) _tlTipEl.classList.remove('visible');
  document.querySelectorAll('.tl-bar--tip-shown').forEach(b => b.classList.remove('tl-bar--tip-shown'));
}
function _tlOutsideTipHandler(e) {
  if (e.target?.closest?.('.tl-bar')) return;
  _tlHideBarTooltip();
}
