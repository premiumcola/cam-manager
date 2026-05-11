// ─── statistics.js ─────────────────────────────────────────────────────────
// Stage 15 of the legacy.js → ES modules refactor — the Statistik
// section (period pills + per-camera donut + top-detection labels +
// last-24h heatmap). Loaded lazily via IntersectionObserver so the
// /api/timeline?hours=720 fetch only fires when the user scrolls
// the section into view.
import { byId, esc } from './core/dom.js';
import { state, STAT_MEDIA_DRILLDOWN } from './core/state.js';
import { j } from './core/api.js';
import { CAT_COLORS } from './timeline.js';
import { colors, OBJ_LABEL, OBJ_SVG, objIconSvg, getCameraIcon, getCameraColor } from './core/icons.js';
// Erkennungswolke is rendered into its own mount node inside the
// Statistik section. Importing here keeps its IntersectionObserver
// lifecycle in lockstep with the rest of the panel.
import { initDetectionCloud } from './detection-cloud.js';

const _STAT_LABEL_ICONS  = { motion: '👁', person: '🧍', cat: '🐈', bird: '🐦', car: '🚗', dog: '🐕', fox: '🦊', hedgehog: '🦔', squirrel: '🐿️', horse: '🐴' };
const _STAT_LABEL_COLORS = { motion: '#36a2ff', person: '#ff6b6b', cat: '#9b8cff', bird: '#62d26f', car: '#00c2ff', dog: '#7c2d12', fox: '#ff7a1a', hedgehog: '#a67c52', squirrel: '#c8651a' };
// Section title icons — monochrome, currentColor, ~14 px stroke style.
const _STAT_TITLE_SVG = {
  camera: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5h2.5l1-1.5h5l1 1.5H14a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><circle cx="8" cy="9" r="2.7"/></svg>`,
  search: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><line x1="10.5" y1="10.5" x2="14" y2="14"/></svg>`,
  clock:  `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><polyline points="8,4.5 8,8 11,9.5"/></svg>`,
  grid:   `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1.2"/><rect x="9" y="2" width="5" height="5" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx="1.2"/><rect x="9" y="9" width="5" height="5" rx="1.2"/></svg>`,
};

let _statLoaded = false;
let _hmTip = null;

async function loadStatistik(){
  const content = byId('statContent');
  if (!content) return;
  _statLoaded = true;
  content.innerHTML = '<div class="stat-empty" style="padding:32px 0">Lade …</div>';
  const [monthData, dayData] = await Promise.all([
    j('/api/timeline?hours=720').catch(() => ({ tracks: [], merged: [] })),
    j('/api/timeline?hours=24').catch(() => ({ tracks: [], merged: [] })),
  ]);
  _renderStatistik(monthData, dayData);
}

// Inline onclick="_statOpenMedia(camId, label)" used by the donut /
// label tiles / heatmap rows when STAT_MEDIA_DRILLDOWN is on.
window._statOpenMedia = function(camId, label){
  if (camId) state.mediaCamera = camId;
  state.mediaLabels = label ? new Set([label]) : new Set();
  const mediaSection = document.querySelector('#media');
  if (!mediaSection) return;
  mediaSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => {
    if (typeof window.loadMedia === 'function') window.loadMedia();
  }, 400);
};

function _renderStatistik(monthData, dayData){
  const content = byId('statContent');
  if (!content) return;
  const now = new Date();
  const todayISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const weekAgoISO = new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  const allMonth = monthData.merged || [];

  const todayCount = allMonth.filter(e => (e.time || '').startsWith(todayISO)).length;
  const weekCount  = allMonth.filter(e => e.time >= weekAgoISO).length;
  const monthCount = allMonth.length;

  const camCounts = {};
  (monthData.tracks || []).forEach(t => { camCounts[t.camera_id] = (t.points || []).length; });
  const cameras = state.cameras || [];

  const labelCounts = {};
  allMonth.forEach(e => (e.labels || []).forEach(l => { labelCounts[l] = (labelCounts[l] || 0) + 1; }));
  const totalLabels = Object.values(labelCounts).reduce((a, b) => a + b, 0) || 1;
  const top3 = Object.entries(labelCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);

  // Rolling 24h buckets indexed by hoursAgo (0 = current hour, 23 = ~24h ago).
  // Rendering reverses this so the rightmost cell is hoursAgo=0 — the user
  // reads the strip right-to-left from "now".
  const hmData = {};
  cameras.forEach(c => { hmData[c.id] = new Array(24).fill(0); });
  const nowMs = Date.now();
  (dayData.tracks || []).forEach(t => {
    if (!hmData[t.camera_id]) hmData[t.camera_id] = new Array(24).fill(0);
    (t.points || []).forEach(e => {
      const tt = new Date(e.time).getTime();
      if (!tt) return;
      const hoursAgo = Math.floor((nowMs - tt) / 3600000);
      if (hoursAgo >= 0 && hoursAgo < 24) hmData[t.camera_id][hoursAgo]++;
    });
  });
  const hmMax = Math.max(1, ...cameras.flatMap(c => hmData[c.id] || []));
  const hmHasData = cameras.some(c => (hmData[c.id] || []).some(v => v > 0));
  // Column 0 (leftmost) = hoursAgo=23, column 23 (rightmost) = hoursAgo=0.
  const hmColLabels = Array.from({ length: 24 }, (_, col) => new Date(nowMs - (23 - col) * 3600000).getHours());

  const periodPills = [['Heute', todayCount], ['Diese Woche', weekCount], ['Dieser Monat', monthCount]]
    .map(([label, count]) => `<div class="stat-period-pill"><div class="stat-period-num">${count}</div><div class="stat-period-label">${label}</div></div>`).join('');

  // Slice + swatch colour comes from the camera icon (getCameraColor) so the
  // chart matches the icon next to each legend label.
  const camsWithEvents = cameras.map(c => ({ c, cnt: camCounts[c.id] || 0 })).filter(x => x.cnt > 0);
  const camTotal = camsWithEvents.reduce((s, x) => s + x.cnt, 0);
  let camBars;
  if (!camsWithEvents.length){
    camBars = '<div class="stat-empty">Keine Ereignisse</div>';
  } else {
    const R = 60, C = 2 * Math.PI * R;
    let offset = 0;
    const slices = camsWithEvents.map(x => {
      const frac = x.cnt / camTotal;
      const len = frac * C;
      const dash = `${len.toFixed(2)} ${(C - len).toFixed(2)}`;
      const seg = `<circle cx="80" cy="80" r="${R}" fill="none" stroke="${getCameraColor(x.c.name || x.c.id)}" stroke-width="22" stroke-dasharray="${dash}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 80 80)"/>`;
      offset += len;
      return seg;
    }).join('');
    const legend = camsWithEvents.map(x => {
      const color = getCameraColor(x.c.name || x.c.id);
      const pct = Math.round(x.cnt / camTotal * 100);
      const rowCls = STAT_MEDIA_DRILLDOWN ? 'stat-donut-row stat-drillable' : 'stat-donut-row';
      const rowClick = STAT_MEDIA_DRILLDOWN ? `onclick="_statOpenMedia('${esc(x.c.id)}','')"` : '';
      const nm = x.c.name || x.c.id;
      return `<div class="${rowCls}" ${rowClick}>
        <span class="stat-donut-sw" style="background:${color}"></span>
        <span class="stat-donut-icon">${getCameraIcon(nm)}</span>
        <span class="stat-donut-name" title="${esc(nm)}">${esc(nm)}</span>
        <span class="stat-donut-cnt">${x.cnt}</span>
        <span class="stat-donut-pct">${pct}%</span>
      </div>`;
    }).join('');
    camBars = `<div class="stat-donut-wrap">
      <div class="stat-donut-chart">
        <svg viewBox="0 0 160 160" width="160" height="160" aria-hidden="true">
          <circle cx="80" cy="80" r="${R}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="22"/>
          ${slices}
        </svg>
        <div class="stat-donut-center">
          <div class="stat-donut-total">${camTotal}</div>
          <div class="stat-donut-sub">EVENTS</div>
        </div>
      </div>
      <div class="stat-donut-legend">${legend}</div>
    </div>`;
  }

  const topN = top3.slice(0, 4);
  const topLabels = topN.length
    ? topN.map(([label, cnt]) => {
        const pct = Math.round(cnt / totalLabels * 100);
        const color = CAT_COLORS[label] || colors[label] || _STAT_LABEL_COLORS[label] || '#cbd5e1';
        const icon = OBJ_SVG[label] ? objIconSvg(label, 18) : (_STAT_LABEL_ICONS[label] || '🔍');
        const name = OBJ_LABEL[label] || label;
        const lblCls = STAT_MEDIA_DRILLDOWN ? 'stat-tile-row stat-drillable' : 'stat-tile-row';
        const lblClick = STAT_MEDIA_DRILLDOWN ? `onclick="_statOpenMedia('','${esc(label)}')"` : '';
        return `<div class="${lblCls}" ${lblClick}>
          <div class="stat-tile-chip" style="background:${color}24"><span class="stat-tile-icon">${icon}</span></div>
          <div class="stat-tile-info">
            <div class="stat-tile-name">${esc(name)}</div>
            <div class="stat-tile-cnt">${cnt} Events</div>
          </div>
          <div class="stat-tile-pct" style="color:${color}">${pct}%</div>
        </div>`;
      }).join('')
    : '<div class="stat-empty">Keine Erkennungen</div>';

  const heatmap = hmHasData
    ? `<div class="stat-heatmap-wrap"><div class="stat-hm-grid">
        <div class="stat-hm-header">
          <div class="stat-hm-cam-col"></div>
          <div class="stat-hm-hours">${hmColLabels.map(h => `<div class="stat-hm-hlabel">${h}</div>`).join('')}</div>
        </div>
        ${cameras.map(c => {
          const hours = hmData[c.id] || new Array(24).fill(0);
          const hmCamCls = STAT_MEDIA_DRILLDOWN ? 'stat-hm-cam stat-drillable' : 'stat-hm-cam';
          const hmCamClick = STAT_MEDIA_DRILLDOWN ? `onclick="_statOpenMedia('${esc(c.id)}','')"` : '';
          const cells = hmColLabels.map((labelHour, col) => {
            const hoursAgo = 23 - col;
            const cnt = hours[hoursAgo] || 0;
            const alpha = cnt === 0 ? 0 : Math.max(0.18, 0.12 + cnt / hmMax * 0.6);
            const bg = cnt === 0 ? 'rgba(255,255,255,0.04)' : `rgba(255,255,255,${alpha.toFixed(2)})`;
            const prevHour = new Date(nowMs - (hoursAgo + 1) * 3600000).getHours();
            const h0 = String(prevHour).padStart(2, '0');
            const h1 = String(labelHour).padStart(2, '0');
            return `<div class="stat-hm-cell" style="background:${bg}" data-tip="${h0}:00–${h1}:00 · ${cnt} Events"></div>`;
          }).join('');
          return `<div class="stat-hm-row">
            <div class="${hmCamCls}" title="${esc(c.name || c.id)}" ${hmCamClick}>${getCameraIcon(c.name || c.id)}&nbsp;${esc(c.name || c.id)}</div>
            <div class="stat-hm-cells">${cells}</div>
          </div>`;
        }).join('')}
      </div></div>`
    : '<div class="stat-empty">Keine Ereignisse in den letzten 24h</div>';

  // 1–3: overview + per-camera + top detections
  content.innerHTML = `
    <div class="stat-period-row">${periodPills}</div>
    <div class="stat-split">
      <div class="stat-card"><div class="stat-card-title">${_STAT_TITLE_SVG.camera}<span>Events pro Kamera · letzter Monat</span></div>${camBars}</div>
      <div class="stat-card"><div class="stat-card-title">${_STAT_TITLE_SVG.search}<span>Top Erkennungen · letzter Monat</span></div>${topLabels}</div>
    </div>`;

  // 5: last 24h heatmap — rendered after the static timeline block (#4)
  const hmBlock = byId('statHeatmapBlock');
  if (hmBlock) hmBlock.innerHTML = `<div class="stat-card" style="margin-top:0"><div class="stat-card-title">${_STAT_TITLE_SVG.grid}<span>Letzte 24h · Aktivität nach Stunde</span></div>${heatmap}</div>`;

  // Camera label column auto-sizes to the widest entry so long names like
  // "Squirrel Town 'Nut Bar'" don't get clipped. Measure with the same
  // font as .stat-hm-cam (12px, weight 600). Clamp 80–180 px.
  if (hmBlock && cameras.length){
    const grid = hmBlock.querySelector('.stat-hm-grid');
    if (grid){
      const probe = document.createElement('canvas').getContext('2d');
      probe.font = '600 12px Inter,system-ui,Segoe UI,Roboto,Arial,sans-serif';
      let widest = 0;
      for (const c of cameras){
        // Same content the row renders: icon + nbsp + name. Icon is one
        // emoji wide (~16px); pad 12px for the cell's right padding.
        const txt = `${getCameraIcon(c.name || c.id)} ${c.name || c.id}`;
        const w = probe.measureText(txt).width;
        if (w > widest) widest = w;
      }
      const labelW = Math.max(80, Math.min(180, Math.ceil(widest) + 24));
      grid.style.setProperty('--hm-label-w', labelW + 'px');
    }
  }

  // Wire fixed-position tooltip for heatmap cells (CSS ::after clips
  // inside overflow-x:auto).
  if (!_hmTip){
    _hmTip = document.createElement('div');
    _hmTip.style.cssText = 'position:fixed;z-index:9999;background:#0d1422;color:#edf4fb;font-size:11px;font-weight:600;padding:4px 9px;border-radius:8px;white-space:nowrap;pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.6);display:none;border:1px solid rgba(255,255,255,.08)';
    document.body.appendChild(_hmTip);
  }
  (hmBlock || content).querySelectorAll('.stat-hm-cell[data-tip]').forEach(cell => {
    cell.addEventListener('mouseenter', e => {
      _hmTip.textContent = cell.dataset.tip;
      _hmTip.style.display = 'block';
      _hmTip.style.left = (e.clientX + 14) + 'px';
      _hmTip.style.top = (e.clientY - 36) + 'px';
    });
    cell.addEventListener('mousemove', e => {
      _hmTip.style.left = (e.clientX + 14) + 'px';
      _hmTip.style.top = (e.clientY - 36) + 'px';
    });
    cell.addEventListener('mouseleave', () => { _hmTip.style.display = 'none'; });
  });
}

byId('statRefreshBtn')?.addEventListener('click', () => { _statLoaded = false; loadStatistik(); });
const _statSection = byId('statistik');
if (_statSection){
  new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)){
      if (!_statLoaded) loadStatistik();
      initDetectionCloud();
    }
  }, { threshold: 0.05 }).observe(_statSection);
}

// Redirect #timeline → #statistik for nav backwards-compatibility.
(function(){
  const redirectTl = () => {
    if (window.location.hash === '#timeline'){
      byId('statistik')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };
  redirectTl();
  window.addEventListener('hashchange', redirectTl);
})();
