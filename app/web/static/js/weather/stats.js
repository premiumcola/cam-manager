// ─── weather/stats.js ──────────────────────────────────────────────────────
// Stage 24 of the legacy.js → ES modules refactor — Wetterstatistik
// chart + explainer + legend + pill bar + auto-refresh observer.
//
// R11 split: rendering now lives in focused sub-modules:
//   * stats-chart.js       — SVG chart (axes, lines, hover tooltip)
//   * stats-thresholds.js  — threshold overlay (composed inside chart)
//   * stats-summary.js     — numeric chip strip + explainer card
//
// What stays here:
//   * shared state (_wsStatsState) + history fetch (loadWeatherStats)
//   * the orchestrator (renderWeatherStats) that drives all three renders
//   * pill-bar + IntersectionObserver lifecycle
//   * shared utilities used across modules (_wsFmtVal, palette, field
//     order, threshold/label/unit hints used by settings.js)
import { byId } from "../core/dom.js";
import { renderWeatherStatsChart } from "./stats-chart.js";
import { renderWeatherStatsLegend, renderWeatherStatsExplainer } from "./stats-summary.js";

// ── Wetterdaten & Prognose chart (Phase 4) ──────────────────────────────────
// Single-source palette for the multi-line history chart. Re-uses the
// WEATHER_TYPES colours where the parameter maps cleanly onto an event
// type, picks close siblings for the diagnostic-only fields. Order here
// determines render order (last drawn sits on top).
export const WEATHER_STATS_PALETTE = {
  precipitation:       '#5a8aa8',  // matches heavy_rain
  snowfall:            '#a8c0d4',  // matches snow
  lightning_potential: '#facc15',  // matches thunder badge
  visibility:          '#94a3b8',  // matches fog
  wind_gusts_10m:      '#84cc16',  // lime — diagnostic, distinct from the rain blues
  cloud_cover:         '#a78bfa',  // violet — diagnostic
  sun_altitude:        '#fb923c',  // matches sunset
};

export const _WS_FIELD_ORDER = [
  'precipitation', 'snowfall', 'lightning_potential', 'visibility',
  'wind_gusts_10m', 'cloud_cover', 'sun_altitude',
];

let _wsStatsTimer_chart = null;
let _wsStatsObserver = null;
export const _wsStatsState = {
  hours: 24,
  isolated: null,         // field key in isolated-mode, null = all lines
  data: null,             // last fetched payload
  inFlight: false,
};

export async function loadWeatherStats(){
  if (_wsStatsState.inFlight) return;
  _wsStatsState.inFlight = true;
  try {
    const r = await fetch('/api/weather/history?hours=' + _wsStatsState.hours);
    _wsStatsState.data = await r.json();
    renderWeatherStats();
  } catch (_err) {
    /* leave the previous render up — single transient error shouldn't blank the chart */
  } finally {
    _wsStatsState.inFlight = false;
  }
}

export function _wsFmtVal(key, v){
  if (v == null || !isFinite(v)) return '—';
  const u = (_wsStatsState.data?.units || {})[key] || '';
  let s;
  if (key === 'sun_altitude') s = v.toFixed(0);
  else if (key === 'cloud_cover' || key === 'wind_gusts_10m') s = v.toFixed(0);
  else if (key === 'visibility') s = v.toFixed(0);
  else if (key === 'lightning_potential') s = v.toFixed(0);
  else s = v.toFixed(2);
  return u ? (s + ' ' + u) : s;
}

export function renderWeatherStats(){
  renderWeatherStatsChart();
  renderWeatherStatsLegend();
  renderWeatherStatsExplainer();
}

function _bindWeatherStatsPills(){
  const bar = byId('weatherStatsPills'); if (!bar || bar.dataset.wired) return;
  bar.querySelectorAll('.ws-stats-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const h = parseInt(btn.dataset.hours, 10) || 24;
      if (h === _wsStatsState.hours) return;
      _wsStatsState.hours = h;
      bar.querySelectorAll('.ws-stats-pill').forEach(b => b.classList.toggle('is-active', b === btn));
      loadWeatherStats();
    });
  });
  bar.dataset.wired = '1';
}

function _startWeatherStatsRefresh(){
  if (_wsStatsTimer_chart) return; // already running
  loadWeatherStats();
  _wsStatsTimer_chart = setInterval(loadWeatherStats, 60_000);
}

function _stopWeatherStatsRefresh(){
  if (_wsStatsTimer_chart){ clearInterval(_wsStatsTimer_chart); _wsStatsTimer_chart = null; }
}

function initWeatherStats(){
  const block = byId('weatherStatsBlock'); if (!block) return;
  _bindWeatherStatsPills();
  if (_wsStatsObserver) return;  // already initialised
  // Pause polling while the section is off-screen — the chart is a
  // dashboard for the Wetter section, not a background task.
  _wsStatsObserver = new IntersectionObserver((entries) => {
    if (entries.some(e => e.isIntersecting)) _startWeatherStatsRefresh();
    else _stopWeatherStatsRefresh();
  }, { threshold: 0.05 });
  _wsStatsObserver.observe(block);
}

// Per-type unit hint for the threshold slider in Settings → Ereignistypen.
// Exported so weather/settings.js can populate _renderWeatherEventsList +
// the per-event slider rows from a single source of truth.
export const WEATHER_THRESHOLD_HINTS = {
  thunder:    { unit: 'J/kg', min: 0,  max: 3000, step: 50, key: 'threshold' },
  heavy_rain: { unit: 'mm/h', min: 0,  max: 30,   step: 0.5, key: 'threshold' },
  snow:       { unit: 'cm/h', min: 0,  max: 5,    step: 0.1, key: 'threshold' },
  fog:        { unit: 'm',    min: 100,max: 5000, step: 100, key: 'vis_max_m' },
  sunset:     { unit: '°',    min: -10,max: 15,   step: 1,    key: 'alt_max' },
};

export const WEATHER_FIELD_LABEL_DE = {
  precipitation:       'Niederschlag',
  snowfall:            'Schneefall',
  lightning_potential: 'Blitz-Potential',
  visibility:          'Sicht',
  wind_gusts_10m:      'Wind-Böen',
  cloud_cover:         'Bewölkung',
  weather_code:        'WMO-Code',
};
export const WEATHER_FIELD_UNIT_DE = {
  precipitation:       'mm/h',
  snowfall:            'cm/h',
  lightning_potential: 'J/kg',
  visibility:          'm',
  wind_gusts_10m:      'km/h',
  cloud_cover:         '%',
  weather_code:        '',
};

// Public surface is exposed via named exports below; legacy.js bridges
// initWeatherStats on window for loadAll().

export {
  initWeatherStats,
};

// Re-export render functions so existing consumers that import them by
// name from this module keep working without source changes.
export { renderWeatherStatsChart } from "./stats-chart.js";
export { renderWeatherStatsLegend, renderWeatherStatsExplainer } from "./stats-summary.js";

// ── window.* bridge ─────────────────────────────────────────────────────────
// loadAll() in live-update.js calls this by global name to wire the
// chart's IntersectionObserver + pill-bar listeners.
window.initWeatherStats = initWeatherStats;
