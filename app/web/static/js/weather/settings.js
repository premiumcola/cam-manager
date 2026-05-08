// ─── weather/settings.js ───────────────────────────────────────────────────
// Stage 24 of the legacy.js → ES modules refactor — Wetter-Einstellungen
// tab: tabs, save lifecycle, status panel.
//
// R10 split: per-tab forms live in focused sub-modules:
//   * settings-suntl.js     — per-camera Sun-Timelapse form + live ticker
//   * settings-eventtl.js   — per-camera Event-Timelapse block
//   * settings-location.js  — Standort tab (Leaflet map, lat/lon/elev)
//   * settings-types.js     — Ereignistypen tab (trigger toggles + sliders)
//
// What stays here:
//   * tab activation listener + tab-specific lazy hooks
//   * _weatherPanelSave — the single chokepoint every save POST goes through
//   * _saveWeatherCfg / _debouncedWeatherSave (used by ws_enabled + types)
//   * the "zuletzt gespeichert" hint + its lifecycle observer
//   * the live-ticker MutationObserver (delegates the actual DOM tick to
//     settings-suntl.js's tickSunTlPreview)
//   * hydrateWeatherSettings — top-level boot entry point
//   * _refreshWeatherStatus — the Status sub-tab content
import { byId, esc } from "../core/dom.js";
import { state } from "../core/state.js";
import { showToast } from "../core/toast.js";
import { WEATHER_TYPES } from "../core/weather-types.js";
import { _renderWeatherCamList, tickSunTlPreview } from "./settings-suntl.js";
import { _initWeatherMap, _bindWsLocationInputs } from "./settings-location.js";
import { _renderWeatherEventsList, bindWeatherTypesHandlers } from "./settings-types.js";
import { renderSunTlTestPanel, stopSunTlTestPolling } from "./settings-suntltest.js";
// Side-effect: settings-eventtl.js registers delegated document listeners
// for the Event-TL chips on import.
import "./settings-eventtl.js";

function initWeatherTabs(){
  const bar = document.querySelector('.ws-tab-bar'); if (!bar) return;
  const allPanels = ['ws-panel-cams', 'ws-panel-location', 'ws-panel-events', 'ws-panel-status', 'ws-panel-suntltest'];
  bar.querySelectorAll('.set-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      bar.querySelectorAll('.set-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.tab;
      allPanels.forEach(id => { const p = byId(id); if (p) p.hidden = (id !== target); });
      if (target === 'ws-panel-status') _refreshWeatherStatus();
      if (target === 'ws-panel-location') _initWeatherMap();
      if (target === 'ws-panel-suntltest') renderSunTlTestPanel();
      else stopSunTlTestPolling();
    });
  });
}

// ── Weather "zuletzt gespeichert" hint ─────────────────────────────────────
// Quiet auto-save signal that replaces the per-input toast spam. Tick only
// runs while #set-weather is open — driven by a MutationObserver on the
// section's class list, so toggleSetSection stays untouched.
let _wsHintTimer = null;

let _wsPulseTimer = null;

function _wsBumpSavedHint(){
  state.weather = state.weather || {};
  state.weather._lastSavedAt = Date.now();
  _wsRenderSavedHint();
  const el = byId('weatherSavedHint');
  if (!el) return;
  // Restart the pulse animation on every save, even back-to-back ones.
  // The reflow read between remove/add forces the browser to retrigger.
  // Cancel the prior cleanup timer so a fast second save can't drop the
  // class mid-animation of the third.
  el.classList.remove('is-pulsing');
  void el.offsetWidth;
  el.classList.add('is-pulsing');
  if (_wsPulseTimer) clearTimeout(_wsPulseTimer);
  _wsPulseTimer = setTimeout(() => el.classList.remove('is-pulsing'), 2400);
}

function _wsRenderSavedHint(){
  const el = byId('weatherSavedHint');
  if (!el) return;
  const ts = state.weather && state.weather._lastSavedAt;
  if (!ts) { el.textContent = 'noch nicht gespeichert'; return; }
  const ageS = Math.max(0, (Date.now() - ts) / 1000);
  const label = ageS < 60
    ? 'gerade eben'
    : new Date(ts).toLocaleTimeString('de-DE', { hour12: false });
  el.textContent = 'zuletzt gespeichert · ' + label;
}

function _initWsSavedHintLifecycle(){
  const sec = byId('set-weather');
  if (!sec || sec.dataset.wsHintObs === '1') return;
  sec.dataset.wsHintObs = '1';
  const start = () => {
    _wsRenderSavedHint();
    if (!_wsHintTimer) _wsHintTimer = setInterval(_wsRenderSavedHint, 15000);
  };
  const stop = () => {
    if (_wsHintTimer) { clearInterval(_wsHintTimer); _wsHintTimer = null; }
  };
  const sync = () => sec.classList.contains('open') ? start() : stop();
  new MutationObserver(sync).observe(sec, { attributes: true, attributeFilter: ['class'] });
  sync();
}

// ── Live clock + countdown for the sun-tl preview rows ────────────────────
// One interval ticks every 1s while the Wetter-Settings panel is open and
// updates every [data-ws-now] (current local time) + [data-ws-countdown]
// (time until capture_start_iso). Mirrors _initWsSavedHintLifecycle so the
// timer stops cleanly when the user collapses the section — no leaks on
// repeated open/close cycles. The actual DOM update lives in
// settings-suntl.js (tickSunTlPreview).
let _wsLiveTimer = null;

function _initWsLiveTickerLifecycle(){
  const sec = byId('set-weather');
  if (!sec || sec.dataset.wsLiveObs === '1') return;
  sec.dataset.wsLiveObs = '1';
  const start = () => {
    tickSunTlPreview();
    if (!_wsLiveTimer) _wsLiveTimer = setInterval(tickSunTlPreview, 1000);
  };
  const stop = () => {
    if (_wsLiveTimer) { clearInterval(_wsLiveTimer); _wsLiveTimer = null; }
  };
  const sync = () => sec.classList.contains('open') ? start() : stop();
  new MutationObserver(sync).observe(sec, { attributes: true, attributeFilter: ['class'] });
  sync();
}

let _weatherSaveTimer = null;

// Single chokepoint for every save inside the weather panel. Routes
// through one helper so new handlers can't forget to bump the
// "zuletzt gespeichert" hint — the prior sprinkle pattern silently
// missed the Farbmodus and Ereignis-Timelapse sliders. Returns the
// raw Response (or null on network error) so callers can still
// r.json() and guard state mutations on r.ok.
export async function _weatherPanelSave(url, payload){
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (_) {
    showToast('Speichern fehlgeschlagen.', 'error');
    return null;
  }
  if (r.ok) _wsBumpSavedHint();
  else      showToast('Speichern fehlgeschlagen.', 'error');
  return r;
}

export async function _saveWeatherCfg(partial){
  const r = await _weatherPanelSave('/api/settings/app', { weather: partial });
  if (r && r.ok) {
    state.config.weather = state.config.weather || {};
    _wsMergeDeep(state.config.weather, partial);
  }
}
function _wsMergeDeep(t, s){
  for (const k of Object.keys(s || {})) {
    if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k]) && t[k] && typeof t[k] === 'object') {
      _wsMergeDeep(t[k], s[k]);
    } else { t[k] = s[k]; }
  }
}
export function _debouncedWeatherSave(partial, ms = 600){
  clearTimeout(_weatherSaveTimer);
  _weatherSaveTimer = setTimeout(() => _saveWeatherCfg(partial), ms);
}

function hydrateWeatherSettings(){
  const w = state.config?.weather || {};
  const srvLoc = state.config?.server?.location || {};
  const badge = byId('weatherStatusBadge');
  if (badge) {
    badge.textContent = w.enabled ? 'aktiv' : 'aus';
    badge.className = 'set-status-badge ' + (w.enabled ? 'set-status-badge--on' : 'set-status-badge--off');
  }
  const en = byId('ws_enabled'); if (en) en.checked = !!w.enabled;
  const lat = byId('ws_lat'); if (lat) lat.value = srvLoc.lat ?? '';
  const lon = byId('ws_lon'); if (lon) lon.value = srvLoc.lon ?? '';
  const elv = byId('ws_elev'); if (elv) elv.value = srvLoc.elevation ?? '';
  // Sun-Times preview lives next to the per-camera toggles. Fetched once
  // before the first render so window labels show the right values; the
  // _saveSunPhase handler refreshes it after each save.
  fetch('/api/weather/sun-times').then(r => r.json()).then(st => {
    state.weather._sunTimes = st;
    _renderWeatherCamList();
  }).catch(() => _renderWeatherCamList());
  _renderWeatherEventsList(w.events || {});
  _bindWeatherHandlers();
  _refreshWeatherStatus();
  _initWsSavedHintLifecycle();
  _initWsLiveTickerLifecycle();
}

function _bindWeatherHandlers(){
  byId('ws_enabled')?.addEventListener('change', (e) => {
    _saveWeatherCfg({ enabled: e.target.checked });
    const badge = byId('weatherStatusBadge');
    if (badge) {
      badge.textContent = e.target.checked ? 'aktiv' : 'aus';
      badge.className = 'set-status-badge ' + (e.target.checked ? 'set-status-badge--on' : 'set-status-badge--off');
    }
  });
  _bindWsLocationInputs();
  // Per-camera toggles — read full cam dict from state.cameras, mutate
  // weather.enabled, POST whole dict back. upsert_camera fills defaults
  // for missing fields, so a partial post would stomp valid data.
  byId('weatherCamList')?.addEventListener('change', async (e) => {
    const cb = e.target.closest('input[data-ws-cam]'); if (!cb) return;
    const camId = cb.dataset.wsCam;
    const cam = (state.cameras || []).find(c => c.id === camId);
    if (!cam) return;
    const updated = { ...cam, weather: { ...(cam.weather || {}), enabled: !!cb.checked } };
    const r = await _weatherPanelSave('/api/settings/cameras', updated);
    if (r && r.ok) {
      cam.weather = updated.weather;
      // Re-render so the sun-timelapse rows reveal/collapse with the
      // master toggle (sun rows live inside .ws-sun-rows[hidden]).
      _renderWeatherCamList();
    }
  });
  bindWeatherTypesHandlers();
}

let _wsStatusTimer = null;
async function _refreshWeatherStatus(){
  const wrap = byId('weatherStatusPanel'); if (!wrap) return;
  try {
    const r = await fetch('/api/weather/status');
    const d = await r.json();
    const ago = d.last_poll_at
      ? Math.max(0, Math.round((Date.now() - new Date(d.last_poll_at).getTime()) / 1000))
      : null;
    const stateRows = Object.entries(d.current_state || {})
      .map(([k, v]) => {
        const meta = WEATHER_TYPES[k] || { de: k, color: '#94a3b8' };
        return `<span class="ws-status-pill" style="--cb:${meta.color};opacity:${v ? 1 : 0.45}">${meta.icon} ${esc(meta.de)} ${v ? '·  aktiv' : ''}</span>`;
      }).join('');
    wrap.innerHTML = `
      <div class="field-help">Aktualisiert sich alle 15 Sekunden.</div>
      <div class="ws-status-row"><span class="ws-status-key">Letzter Poll</span><span class="ws-status-val">${ago == null ? '— noch nie —' : 'vor ' + ago + ' s'}</span></div>
      <div class="ws-status-row"><span class="ws-status-key">API-Antwort</span><span class="ws-status-val">${d.last_api_ok === true ? '🟢 OK' : d.last_api_ok === false ? '🔴 Fehler' : '— noch nie —'}</span></div>
      <div class="ws-status-row"><span class="ws-status-key">Standort</span><span class="ws-status-val">${d.location?.lat != null ? `${d.location.lat}, ${d.location.lon}` : '— nicht gesetzt —'}</span></div>
      <div class="ws-status-row" style="flex-direction:column;align-items:flex-start;gap:6px"><span class="ws-status-key">Aktuelle Trigger</span><div style="display:flex;flex-wrap:wrap;gap:6px">${stateRows}</div></div>
    `;
  } catch (_err) {
    wrap.innerHTML = '<div class="field-help">Status nicht erreichbar.</div>';
  }
  clearTimeout(_wsStatusTimer);
  _wsStatusTimer = setTimeout(_refreshWeatherStatus, 15000);
}

// Public surface — bridges in legacy.js consume these by name.

export {

  initWeatherTabs,

  hydrateWeatherSettings,

};

// ── window.* bridges ────────────────────────────────────────────────────────
// loadAll() in live-update.js looks these up by global name; without
// the bridges the weather-settings panel never hydrates and the
// initWeatherTabs DOM listeners never bind. Each evaporates when its
// caller migrates to a direct named import.
window.initWeatherTabs       = initWeatherTabs;
window.hydrateWeatherSettings = hydrateWeatherSettings;
