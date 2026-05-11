// ─── detection-cloud.js ────────────────────────────────────────────────────
// Erkennungswolke — per-frame detection scatter under the Statistik
// panel. Reads /api/detection_cloud (which flattens tracks.json
// sidecars) and plots one dot per detector sample so the operator can
// visually find the confidence cluster boundary between real
// detections and noise. Imported by statistics.js so it shares the
// section's IntersectionObserver lifecycle.
import { byId, esc } from './core/dom.js';
import { state, STAT_MEDIA_DRILLDOWN } from './core/state.js';
import { j } from './core/api.js';
import { CAT_COLORS } from './timeline.js';
import { colors, OBJ_LABEL, OBJ_SVG, objIconSvg, getCameraIcon, getCameraColor } from './core/icons.js';

// Title icons — match statistics.js stroke style so the section reads
// as one coherent column.
const _DC_TITLE_SVG = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4" cy="11" r="1.6"/><circle cx="8" cy="6.5" r="1.6"/><circle cx="12.5" cy="9" r="1.6"/><circle cx="11" cy="13" r="1.2"/><circle cx="5.5" cy="5" r="1.2"/></svg>`;
const _DC_LIVE_SVG  = `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><circle cx="8" cy="8" r="3.5" fill="currentColor"/></svg>`;
const _DC_VIEW_TIME = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><polyline points="8,4.5 8,8 10.5,9.5"/></svg>`;
const _DC_VIEW_CLS  = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="4" height="4" rx=".7"/><rect x="9.5" y="2.5" width="4" height="4" rx=".7"/><rect x="2.5" y="9.5" width="4" height="4" rx=".7"/><rect x="9.5" y="9.5" width="4" height="4" rx=".7"/></svg>`;
const _DC_REFRESH   = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 8A6 6 0 0 1 2 8a6 6 0 0 1 10.3-4.2"/><polyline points="14,2 14,6 10,6"/></svg>`;

// Persistent UI/runtime state — module-private, no state.js leakage.
// The points map is keyed by sample_key so the live-poll merge is
// O(1) and naturally dedups across overlapping windows.
const _dc = {
  initialized:   false,
  points:        new Map(),   // sample_key -> point
  coverage:      { events_total: 0, events_with_sidecar: 0 },
  newKeys:       new Set(),   // keys that arrived since last render (drive pulse)
  pulseUntil:    new Map(),   // key -> ms timestamp when pulse ends
  filter: {
    hours:     12,
    cameras:   new Set(),     // empty = "all"
    classes:   new Set(),     // empty = "all"
    minScore:  0.0,
    view:      'time',        // 'time' | 'class'
    live:      false,
  },
  // Race / lifecycle plumbing.
  fetchToken:    0,
  abortCtrl:     null,
  pollTimer:     null,
  pollIntervalMs: 20_000,
  isVisible:     false,
  reducedMotion: false,
  tooltip:       null,
  // Chart geometry — recomputed on every render so the SVG scales with
  // the card width. The current values are stashed so the tooltip
  // handler can project (clientX,clientY) → time/score on demand.
  geom:          null,
  // The classes pill set is auto-built from data; we keep the union
  // ordering so a class doesn't change position when a new poll cycle
  // adds samples for a different label.
  knownClasses:  [],
};

// Public bootstrap — called from statistics.js once on first reveal.
export function initDetectionCloud() {
  if (_dc.initialized) return;
  _dc.initialized = true;
  _dc.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;
  _renderShell();
  _wireVisibilityObserver();
  _fetchAndRender(true);
}

// ── Fetch ─────────────────────────────────────────────────────────────────
function _buildUrl() {
  const params = new URLSearchParams({
    hours: String(_dc.filter.hours),
    min_score: String(_dc.filter.minScore.toFixed(2)),
    limit: '5000',
  });
  // The cameras-filter param is for *server-side* scope: when the
  // user explicitly chose one camera, drop the others from the
  // payload entirely so the network cost stays small. When empty we
  // omit the param (server interprets that as "all enabled cams").
  if (_dc.filter.cameras.size && _dc.filter.cameras.size < (state.cameras || []).length){
    params.set('cameras', Array.from(_dc.filter.cameras).join(','));
  }
  return `/api/detection_cloud?${params.toString()}`;
}

async function _fetchAndRender(replace) {
  if (_dc.abortCtrl){ try { _dc.abortCtrl.abort(); } catch {} }
  const ctrl = new AbortController();
  _dc.abortCtrl = ctrl;
  const myToken = ++_dc.fetchToken;
  const url = _buildUrl();
  try {
    const data = await j(url, { signal: ctrl.signal });
    if (myToken !== _dc.fetchToken) return;
    const prevKnown = _dc.knownClasses.length;
    _mergeData(data, replace);
    // Re-render class pills when the union of seen labels grew so a
    // brand-new species/class joining doesn't stay invisible until the
    // operator forces another refresh.
    if (_dc.knownClasses.length !== prevKnown) _renderPills();
    _renderChart();
    _renderCoverage();
  } catch (_e) {
    if (myToken !== _dc.fetchToken) return;
    if (replace){
      // Only surface the empty state on a *full* failed fetch — a
      // failed live poll should keep showing the last good data.
      _renderEmpty('Konnte Erkennungs-Daten nicht laden');
    }
  }
}

function _mergeData(data, replace) {
  if (replace) {
    _dc.points.clear();
    _dc.newKeys.clear();
    _dc.pulseUntil.clear();
  }
  const incoming = data?.points || [];
  const now = Date.now();
  const pulseFor = _dc.reducedMotion ? 0 : 600;
  for (const p of incoming) {
    const key = p.sample_key;
    if (!key) continue;
    if (!_dc.points.has(key) && !replace){
      // True new point during a live poll → pulse it briefly.
      _dc.newKeys.add(key);
      if (pulseFor) _dc.pulseUntil.set(key, now + pulseFor);
    }
    _dc.points.set(key, p);
  }
  _dc.coverage = data?.coverage || _dc.coverage;
  // Refresh the union of seen classes — keeps existing order so a new
  // class joining mid-session lands at the end rather than reshuffling
  // the pills the operator just clicked.
  const cls = new Set(_dc.knownClasses);
  for (const p of _dc.points.values()) cls.add(p.label || 'unknown');
  _dc.knownClasses = Array.from(cls);
}

// ── Card shell ─────────────────────────────────────────────────────────────
function _renderShell() {
  const host = byId('statDetCloudBlock');
  if (!host) return;
  host.innerHTML = `
    <div class="stat-card stat-dc-card" style="margin-top:12px">
      <div class="stat-dc-hdr">
        <div class="stat-card-title">${_DC_TITLE_SVG}<span>Erkennungswolke · pro Sample</span></div>
        <div class="stat-dc-hdr-actions">
          <div class="stat-dc-view" role="tablist" aria-label="Achsen-Modus">
            <button type="button" class="stat-dc-view-btn is-active" data-view="time" role="tab" aria-selected="true">${_DC_VIEW_TIME}<span>Zeit</span></button>
            <button type="button" class="stat-dc-view-btn" data-view="class" role="tab" aria-selected="false">${_DC_VIEW_CLS}<span>Klasse</span></button>
          </div>
          <button type="button" class="stat-dc-live" data-live="0" aria-pressed="false" title="Live-Polling alle 20 s">
            <span class="stat-dc-live-dot">${_DC_LIVE_SVG}</span><span>Live</span>
          </button>
          <button type="button" class="stat-dc-refresh" title="Jetzt aktualisieren">${_DC_REFRESH}</button>
        </div>
      </div>
      <div class="stat-dc-filters">
        <div class="stat-dc-pillrow" id="dcCamPills"></div>
        <div class="stat-dc-pillrow" id="dcClsPills"></div>
        <div class="stat-dc-sliders">
          <label class="stat-dc-slider">
            <span class="stat-dc-slider-lbl">Min. Konfidenz <b id="dcMinScoreLbl">0 %</b></span>
            <input type="range" id="dcMinScore" min="0" max="100" step="1" value="0" aria-label="Mindest-Konfidenz">
          </label>
          <label class="stat-dc-slider">
            <span class="stat-dc-slider-lbl">Zeitraum <b id="dcHoursLbl">letzte 12 h</b></span>
            <input type="range" id="dcHours" min="1" max="720" step="1" value="12" aria-label="Zeitraum">
          </label>
        </div>
        <div class="stat-dc-coverage" id="dcCoverage" aria-live="polite"></div>
      </div>
      <div class="stat-dc-chart-wrap">
        <div class="stat-dc-chart" id="dcChart"></div>
      </div>
    </div>
  `;
  _renderPills();
  _wireHandlers();
  _renderEmpty('Lade Erkennungs-Sidecars …');
  _renderCoverage();
}

function _renderPills() {
  const camHost = byId('dcCamPills');
  const clsHost = byId('dcClsPills');
  if (!camHost || !clsHost) return;
  const cams = state.cameras || [];
  camHost.innerHTML = cams.map(c => {
    const id = c.id;
    const nm = c.name || c.id;
    const color = getCameraColor(nm);
    const active = !_dc.filter.cameras.size || _dc.filter.cameras.has(id);
    const ico = getCameraIcon(nm);
    return `<button type="button" class="stat-dc-pill stat-dc-pill--cam${active ? ' is-active' : ''}" data-cam="${esc(id)}" title="${esc(nm)}" style="--pill-c:${color}">
      <span class="stat-dc-pill-dot" style="background:${color}"></span>
      <span class="stat-dc-pill-ico">${ico}</span>
      <span class="stat-dc-pill-text">${esc(nm)}</span>
    </button>`;
  }).join('');
  const classes = _dc.knownClasses.length ? _dc.knownClasses : ['person','cat','bird','car','dog','squirrel'];
  clsHost.innerHTML = classes.map(lbl => {
    const active = !_dc.filter.classes.size || _dc.filter.classes.has(lbl);
    const color = CAT_COLORS[lbl] || colors[lbl] || '#cbd5e1';
    const icon  = OBJ_SVG[lbl] ? objIconSvg(lbl, 14) : '';
    const name  = OBJ_LABEL[lbl] || lbl;
    return `<button type="button" class="stat-dc-pill stat-dc-pill--cls${active ? ' is-active' : ''}" data-cls="${esc(lbl)}" title="${esc(name)}" style="--pill-c:${color}">
      <span class="stat-dc-pill-dot" style="background:${color}"></span>
      ${icon ? `<span class="stat-dc-pill-ico">${icon}</span>` : ''}
      <span class="stat-dc-pill-text">${esc(name)}</span>
    </button>`;
  }).join('');
}

function _renderCoverage() {
  const host = byId('dcCoverage');
  if (!host) return;
  const total = _dc.coverage.events_total || 0;
  const ok = _dc.coverage.events_with_sidecar || 0;
  const points = _dc.points.size;
  const ratio = total > 0 ? (ok / total) : 1;
  const amber = total > 0 && ratio < 0.8;
  host.classList.toggle('is-amber', amber);
  host.innerHTML = `
    <span class="stat-dc-cov-num">${points}</span>
    <span class="stat-dc-cov-sep">Erkennungen ·</span>
    <span class="stat-dc-cov-num">${ok}/${total}</span>
    <span class="stat-dc-cov-sep">Clips mit Sidecar</span>
  `;
}

// ── Empty state ───────────────────────────────────────────────────────────
function _renderEmpty(message) {
  const host = byId('dcChart');
  if (!host) return;
  host.innerHTML = `<div class="stat-dc-empty">
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="14" r="1.4"/><circle cx="12" cy="9" r="1.4"/><circle cx="17" cy="13" r="1.4"/><circle cx="20" cy="6" r="1"/></svg>
    <span>${esc(message)}</span>
  </div>`;
}

// ── Chart ─────────────────────────────────────────────────────────────────
function _filteredPoints() {
  const camActive = _dc.filter.cameras;
  const clsActive = _dc.filter.classes;
  const minS = _dc.filter.minScore;
  const out = [];
  for (const p of _dc.points.values()){
    if (camActive.size && !camActive.has(p.camera_id)) continue;
    if (clsActive.size && !clsActive.has(p.label)) continue;
    if ((p.score ?? 0) < minS) continue;
    out.push(p);
  }
  return out;
}

function _renderChart() {
  const host = byId('dcChart');
  if (!host) return;
  const points = _filteredPoints();
  if (!points.length){
    const hadAny = _dc.coverage.events_with_sidecar > 0;
    _renderEmpty(hadAny
      ? 'Keine Punkte unter dem aktuellen Filter'
      : 'Noch keine Erkennungs-Sidecars im Zeitraum');
    return;
  }

  const W = host.clientWidth || 720;
  // Mobile breakpoint mirrors the CSS @media(max-width:768px) clause
  // so the chart height collapses in sync with the rest of the layout.
  const isNarrow = W < 560;
  const H = isNarrow ? 240 : 320;
  const padL = isNarrow ? 36 : 48;
  const padR = 14;
  const padT = 12;
  const padB = isNarrow ? 30 : 36;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // Time / class axis projection.
  let xOf;
  let xLabels;
  let xGridLines = [];
  const tNow = Date.now();
  const tMin = tNow - _dc.filter.hours * 3600 * 1000;
  if (_dc.filter.view === 'class'){
    // Build a stable category index from the union of classes present
    // in the *filtered* points so the X axis shrinks to what's visible.
    const cats = Array.from(new Set(points.map(p => p.label || 'unknown')));
    cats.sort();
    const slot = plotW / Math.max(1, cats.length);
    const idx = new Map(cats.map((c, i) => [c, i]));
    // Jitter is deterministic per sample_key so a re-render doesn't
    // shimmer the points. Hash → (-0.4..0.4)*slot.
    xOf = (p) => {
      const i = idx.get(p.label || 'unknown') ?? 0;
      const baseX = padL + slot * (i + 0.5);
      const h = _strHash(p.sample_key);
      const jit = ((h % 1000) / 1000 - 0.5) * 0.8 * Math.min(slot - 14, 60);
      return baseX + jit;
    };
    xLabels = cats.map((c, i) => {
      const x = padL + slot * (i + 0.5);
      const name = OBJ_LABEL[c] || c;
      return `<text x="${x.toFixed(1)}" y="${(H - 10).toFixed(1)}" class="stat-dc-xlbl" text-anchor="middle">${esc(name)}</text>`;
    }).join('');
    xGridLines = cats.slice(1).map((_c, i) => {
      const x = padL + slot * (i + 1);
      return `<line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${(padT + plotH).toFixed(1)}" class="stat-dc-grid"/>`;
    });
  } else {
    xOf = (p) => {
      const t = new Date(p.time).getTime();
      const frac = (t - tMin) / Math.max(1, tNow - tMin);
      return padL + Math.max(0, Math.min(1, frac)) * plotW;
    };
    const ticks = isNarrow ? 4 : 6;
    const buf = [];
    for (let k = 0; k <= ticks; k++){
      const x = padL + plotW * (k / ticks);
      const t = tMin + (tNow - tMin) * (k / ticks);
      buf.push(`<text x="${x.toFixed(1)}" y="${(H - 10).toFixed(1)}" class="stat-dc-xlbl" text-anchor="middle">${_fmtTs(t, _dc.filter.hours)}</text>`);
      if (k > 0 && k < ticks){
        xGridLines.push(`<line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${(padT + plotH).toFixed(1)}" class="stat-dc-grid"/>`);
      }
    }
    xLabels = buf.join('');
  }

  // Y axis: confidence 0..100 (always; the slider is a *floor*, not a zoom).
  const yOf = (score) => padT + plotH * (1 - Math.max(0, Math.min(1, score)));
  const yTicks = [0, 0.25, 0.5, 0.75, 1.0];
  const yLabels = yTicks.map(v => {
    const y = yOf(v);
    return `<text x="${(padL - 8).toFixed(1)}" y="${(y + 4).toFixed(1)}" class="stat-dc-ylbl" text-anchor="end">${Math.round(v*100)}%</text>`;
  }).join('');
  const yGrid = yTicks.map(v => {
    const y = yOf(v);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${(padL + plotW).toFixed(1)}" y2="${y.toFixed(1)}" class="stat-dc-grid"/>`;
  }).join('');

  // Min-score reference line — dashed.
  const refY = yOf(_dc.filter.minScore);
  const refLine = _dc.filter.minScore > 0
    ? `<line x1="${padL}" y1="${refY.toFixed(1)}" x2="${(padL + plotW).toFixed(1)}" y2="${refY.toFixed(1)}" class="stat-dc-ref"/>`
    : '';

  // Point rendering — radius from bbox_frac_area; color from camera.
  // The pulse for new points rides through CSS animation (so the
  // browser does the timing, not us).
  const now = Date.now();
  const camNameById = new Map((state.cameras || []).map(c => [c.id, c.name || c.id]));
  const dotSvg = points.map(p => {
    const cx = xOf(p);
    const cy = yOf(p.score);
    const r  = _radiusFor(p.bbox_frac_area);
    const camName = camNameById.get(p.camera_id) || p.camera_id;
    const color = getCameraColor(camName);
    const pulseUntil = _dc.pulseUntil.get(p.sample_key) || 0;
    const isPulse = pulseUntil > now;
    return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(2)}" fill="${color}" class="stat-dc-dot${isPulse ? ' is-fresh' : ''}" data-key="${esc(p.sample_key)}"></circle>`;
  }).join('');

  // Drop expired pulse keys so the next re-render doesn't keep
  // reapplying the animation class.
  for (const [k, until] of _dc.pulseUntil){
    if (until <= now) _dc.pulseUntil.delete(k);
  }

  host.innerHTML = `
    <svg class="stat-dc-svg" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img" aria-label="Erkennungs-Wolke">
      ${yGrid}
      ${xGridLines.join('')}
      ${refLine}
      ${yLabels}
      ${xLabels}
      ${dotSvg}
    </svg>
  `;
  _dc.geom = { points, padL, padR, padT, padB, plotW, plotH, W, H };
  _attachDotHandlers(host);
}

function _radiusFor(area) {
  if (area == null) return 3.4;
  // 1080p ≈ 0.05 frac for a small bird → r ~3; a person filling half
  // the frame → r ~7. Clamp 2..8 keeps tiny noise visible without
  // letting one big bbox dominate the whole chart.
  const r = 2 + Math.sqrt(area) * 22;
  return Math.max(2, Math.min(8, r));
}

function _strHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++){
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function _fmtTs(ts, hours) {
  const d = new Date(ts);
  const HH = String(d.getHours()).padStart(2, '0');
  const MM = String(d.getMinutes()).padStart(2, '0');
  if (hours <= 3)   return `${HH}:${MM}`;
  if (hours <= 24)  return `${HH}:00`;
  if (hours <= 168) return ['So','Mo','Di','Mi','Do','Fr','Sa'][d.getDay()] + ' ' + d.getDate() + '.';
  return d.getDate() + '.' + (d.getMonth() + 1) + '.';
}

// ── Tooltip + drilldown ──────────────────────────────────────────────────
function _ensureTooltip() {
  if (_dc.tooltip && document.body.contains(_dc.tooltip)) return _dc.tooltip;
  const el = document.createElement('div');
  el.className = 'stat-dc-tip';
  el.style.display = 'none';
  document.body.appendChild(el);
  _dc.tooltip = el;
  // Tap-outside to dismiss — only matters for the mobile path; on
  // desktop the mouseleave handler covers it.
  document.addEventListener('pointerdown', (e) => {
    if (!_dc.tooltip || _dc.tooltip.style.display === 'none') return;
    const inDot = e.target.closest?.('.stat-dc-dot');
    const inTip = e.target === _dc.tooltip || _dc.tooltip.contains(e.target);
    if (!inDot && !inTip) _hideTooltip();
  }, true);
  return el;
}

function _hideTooltip() {
  if (_dc.tooltip) _dc.tooltip.style.display = 'none';
}

function _attachDotHandlers(host) {
  const svg = host.querySelector('svg');
  if (!svg) return;
  const dotMap = new Map(_dc.geom.points.map(p => [p.sample_key, p]));
  const onEnter = (e) => {
    const dot = e.target.closest?.('.stat-dc-dot');
    if (!dot) return;
    const key = dot.dataset.key;
    const p = dotMap.get(key);
    if (!p) return;
    _showTooltipFor(p, e.clientX, e.clientY);
  };
  const onLeave = (e) => {
    if (e.relatedTarget?.closest?.('.stat-dc-tip')) return;
    _hideTooltip();
  };
  svg.addEventListener('mouseover', onEnter);
  svg.addEventListener('mousemove', (e) => {
    if (_dc.tooltip && _dc.tooltip.style.display === 'block'){
      _positionTooltip(e.clientX, e.clientY);
    }
  });
  svg.addEventListener('mouseout', onLeave);
  svg.addEventListener('touchstart', (e) => {
    const t = e.touches[0]; if (!t) return;
    const target = document.elementFromPoint(t.clientX, t.clientY);
    const dot = target?.closest?.('.stat-dc-dot');
    if (!dot) return;
    const p = dotMap.get(dot.dataset.key);
    if (!p) return;
    _showTooltipFor(p, t.clientX, t.clientY);
  }, { passive: true });
  // Tap-to-drilldown — fires on click; on mobile the touchstart above
  // shows the tooltip first, the click then opens the media drilldown.
  svg.addEventListener('click', (e) => {
    const dot = e.target.closest?.('.stat-dc-dot');
    if (!dot) return;
    const p = dotMap.get(dot.dataset.key);
    if (!p) return;
    if (STAT_MEDIA_DRILLDOWN && typeof window._statOpenMedia === 'function'){
      window._statOpenMedia(p.camera_id, p.label);
    } else if (p.event_id){
      // Fall back to the per-event hash route the timeline dots use.
      window.location.hash = `#event-${p.event_id}`;
    }
  });
}

function _showTooltipFor(p, clientX, clientY) {
  const tip = _ensureTooltip();
  const camName = (state.cameras || []).find(c => c.id === p.camera_id)?.name || p.camera_id;
  const camIcon = getCameraIcon(camName);
  const camColor = getCameraColor(camName);
  const clsName = OBJ_LABEL[p.label] || p.label;
  const clsIcon = OBJ_SVG[p.label] ? objIconSvg(p.label, 14) : '';
  const clsColor = CAT_COLORS[p.label] || colors[p.label] || '#cbd5e1';
  const dt = new Date(p.time);
  const HH = String(dt.getHours()).padStart(2,'0');
  const MM = String(dt.getMinutes()).padStart(2,'0');
  const SS = String(dt.getSeconds()).padStart(2,'0');
  const DD = String(dt.getDate()).padStart(2,'0');
  const MO = String(dt.getMonth()+1).padStart(2,'0');
  const thumb = p.snapshot_url
    ? `<img class="stat-dc-tip-thumb" src="${esc(p.snapshot_url)}" alt="" loading="lazy">`
    : '';
  tip.innerHTML = `
    ${thumb}
    <div class="stat-dc-tip-body">
      <div class="stat-dc-tip-row">
        <span class="stat-dc-tip-dot" style="background:${camColor}"></span>
        <span class="stat-dc-tip-ico">${camIcon}</span>
        <span class="stat-dc-tip-name">${esc(camName)}</span>
      </div>
      <div class="stat-dc-tip-row">
        ${clsIcon ? `<span class="stat-dc-tip-ico" style="color:${clsColor}">${clsIcon}</span>` : ''}
        <span class="stat-dc-tip-name">${esc(clsName)}</span>
        <span class="stat-dc-tip-score">${(p.score * 100).toFixed(1)} %</span>
      </div>
      <div class="stat-dc-tip-row stat-dc-tip-meta">
        <span>${HH}:${MM}:${SS} · ${DD}.${MO}.</span>
      </div>
    </div>
  `;
  tip.style.display = 'block';
  _positionTooltip(clientX, clientY);
}

function _positionTooltip(clientX, clientY) {
  if (!_dc.tooltip) return;
  const tip = _dc.tooltip;
  // Measure first paint so the auto-flip math has a real height.
  const rect = tip.getBoundingClientRect();
  const tipW = rect.width  || 220;
  const tipH = rect.height || 90;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Auto-flip above the tap-point on mobile so a fat finger doesn't
  // cover the tooltip. Threshold mirrors the chart's narrow-mode
  // breakpoint.
  const isNarrow = vw < 560;
  let left = clientX + 14;
  let top  = clientY - tipH - 14;
  if (isNarrow){
    left = clientX - tipW / 2;
    top  = clientY - tipH - 18;
    if (top < 8) top = clientY + 18; // tap near top edge → fall to below
  } else if (top < 8){
    top = clientY + 14;
  }
  if (left + tipW > vw - 8) left = vw - tipW - 8;
  if (left < 8) left = 8;
  if (top + tipH > vh - 8) top = vh - tipH - 8;
  tip.style.left = left + 'px';
  tip.style.top  = top + 'px';
}

// ── Live-poll lifecycle + IntersectionObserver ────────────────────────────
function _setLive(on) {
  _dc.filter.live = !!on;
  const btn = document.querySelector('.stat-dc-live');
  if (btn){
    btn.dataset.live = on ? '1' : '0';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('is-on', !!on);
  }
  _refreshPollTimer();
}

function _refreshPollTimer() {
  if (_dc.pollTimer){ clearInterval(_dc.pollTimer); _dc.pollTimer = null; }
  if (_dc.filter.live && _dc.isVisible){
    _dc.pollTimer = setInterval(() => {
      if (!_dc.filter.live || !_dc.isVisible) return;
      _fetchAndRender(false);
    }, _dc.pollIntervalMs);
  }
}

function _wireVisibilityObserver() {
  const host = byId('statDetCloudBlock');
  if (!host) return;
  const obs = new IntersectionObserver(entries => {
    for (const e of entries){
      _dc.isVisible = e.isIntersecting;
    }
    _refreshPollTimer();
  }, { threshold: 0.05 });
  obs.observe(host);
}

// ── Event wiring ──────────────────────────────────────────────────────────
function _wireHandlers() {
  const card = document.querySelector('.stat-dc-card');
  if (!card) return;

  // View toggle.
  card.querySelectorAll('.stat-dc-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.view;
      if (v !== 'time' && v !== 'class') return;
      if (_dc.filter.view === v) return;
      _dc.filter.view = v;
      card.querySelectorAll('.stat-dc-view-btn').forEach(b => {
        const on = b.dataset.view === v;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      _renderChart();
    });
  });

  // Camera + class pills — delegated so re-renders don't drop the
  // listeners.
  const camHost = byId('dcCamPills');
  const clsHost = byId('dcClsPills');
  camHost?.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.stat-dc-pill--cam');
    if (!btn) return;
    const id = btn.dataset.cam;
    _togglePillSet(_dc.filter.cameras, id, (state.cameras || []).map(c => c.id));
    _renderPills();
    _renderChart();
  });
  clsHost?.addEventListener('click', (e) => {
    const btn = e.target.closest?.('.stat-dc-pill--cls');
    if (!btn) return;
    const cls = btn.dataset.cls;
    _togglePillSet(_dc.filter.classes, cls, _dc.knownClasses);
    _renderPills();
    _renderChart();
  });

  // Min-score slider — only triggers a re-fetch when *lowered* so a
  // higher floor stays purely client-side (cheap).
  const minEl = byId('dcMinScore');
  const minLbl = byId('dcMinScoreLbl');
  let lastMin = _dc.filter.minScore;
  minEl?.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10) / 100;
    _dc.filter.minScore = v;
    if (minLbl) minLbl.textContent = Math.round(v * 100) + ' %';
    _renderChart();
  });
  minEl?.addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10) / 100;
    if (v < lastMin){
      // Lowered → server may have more points now within reach.
      lastMin = v;
      _fetchAndRender(true);
    } else {
      lastMin = v;
    }
  });

  // Hours slider — always re-fetches (window changed).
  const hoursEl = byId('dcHours');
  const hoursLbl = byId('dcHoursLbl');
  let hoursDebounce = null;
  hoursEl?.addEventListener('input', (e) => {
    const v = Math.max(1, Math.min(720, parseInt(e.target.value, 10) || 1));
    _dc.filter.hours = v;
    if (hoursLbl) hoursLbl.textContent = _fmtHours(v);
    clearTimeout(hoursDebounce);
    hoursDebounce = setTimeout(() => _fetchAndRender(true), 250);
  });

  // Live + refresh.
  card.querySelector('.stat-dc-live')?.addEventListener('click', () => {
    _setLive(!_dc.filter.live);
  });
  card.querySelector('.stat-dc-refresh')?.addEventListener('click', () => {
    _fetchAndRender(true);
  });
}

function _togglePillSet(set, value, all) {
  // Empty set means "all" — interpret a click on a single pill as
  // "show only this one" so the operator can drill quickly. A second
  // click on the same pill clears the filter (back to all).
  if (set.size === 0){
    set.add(value);
    return;
  }
  if (set.has(value)){
    set.delete(value);
    if (set.size === 0){
      // Empty fallback → behave like "all", same UX as never touched.
      return;
    }
    return;
  }
  set.add(value);
  // If every option is now selected, normalize back to empty = all so
  // the badge layout reads cleanly.
  if (set.size >= all.length) set.clear();
}

function _fmtHours(h) {
  if (h <= 48) return `letzte ${h} h`;
  const d = Math.round(h / 24);
  return `letzte ${d} d`;
}

// Re-render the chart when the window resizes — the SVG uses pixel
// dimensions (not %-based viewBox) so we need to recompute geometry
// on layout shifts.
let _dcResizeTimer = null;
window.addEventListener('resize', () => {
  if (!_dc.initialized) return;
  clearTimeout(_dcResizeTimer);
  _dcResizeTimer = setTimeout(() => { _renderPills(); _renderChart(); }, 120);
});
