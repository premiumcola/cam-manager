// ─── weather/settings.js ───────────────────────────────────────────────────
// Stage 24 of the legacy.js → ES modules refactor — Wetter-Einstellungen
// tab: tabs, save lifecycle, per-camera sun-timelapse panels,
// event-trigger blocks, OpenStreetMap location picker, status panel.
// Pure code move from legacy.js, no behaviour changes.
//
// Leaflet is loaded via a global <script> tag in index.html, so the
// `L.*` reference at runtime is the global. WEATHER_TYPES + colours +
// helpers are imported from their respective core modules.
import { byId, esc } from "../core/dom.js";
import { state } from "../core/state.js";
import { j } from "../core/api.js";
import { showToast } from "../core/toast.js";
import { getCameraIcon } from "../core/icons.js";
import { WEATHER_TYPES } from "../core/weather-types.js";
// Threshold-slider unit hints — single source of truth lives in
// weather/stats.js. Without this import _renderWeatherEventsList and
// _renderEventsBlock throw "WEATHER_THRESHOLD_HINTS is not defined",
// which propagates out of hydrateWeatherSettings → loadAll() →
// .then(loadAchievements()) never fires → Sichtungen panel stays empty.
import { WEATHER_THRESHOLD_HINTS } from "./stats.js";

function initWeatherTabs(){
  const bar = document.querySelector('.ws-tab-bar'); if (!bar) return;
  const allPanels = ['ws-panel-cams', 'ws-panel-location', 'ws-panel-events', 'ws-panel-status'];
  bar.querySelectorAll('.set-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      bar.querySelectorAll('.set-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.tab;
      allPanels.forEach(id => { const p = byId(id); if (p) p.hidden = (id !== target); });
      if (target === 'ws-panel-status') _refreshWeatherStatus();
      if (target === 'ws-panel-location') _initWeatherMap();
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
// repeated open/close cycles.
let _wsLiveTimer = null;

function _wsFmtCountdown(targetIso, endIso){
  if (!targetIso) return '';
  const now = Date.now();
  const target = new Date(targetIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : target;
  const dt = target - now;
  if (dt <= 0){
    // Capture is in progress until endIso, then "fertig" until the next
    // backend resolution rolls the row to tomorrow's event.
    if (now <= end) return 'läuft';
    return 'fertig';
  }
  const s = Math.floor(dt / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h >= 1) return `in ${h}h ${m}m`;
  if (m >= 1) return `in ${m}m ${sec}s`;
  return `in ${sec}s`;
}

function _wsTickLive(){
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const nowStr = `${hh}:${mm}:${ss}`;
  document.querySelectorAll('[data-ws-now]').forEach(el => {
    el.textContent = nowStr;
  });
  document.querySelectorAll('[data-ws-countdown]').forEach(el => {
    const target = el.getAttribute('data-ws-countdown');
    const end = el.getAttribute('data-ws-countdown-end') || '';
    el.textContent = _wsFmtCountdown(target, end);
  });
}

function _initWsLiveTickerLifecycle(){
  const sec = byId('set-weather');
  if (!sec || sec.dataset.wsLiveObs === '1') return;
  sec.dataset.wsLiveObs = '1';
  const start = () => {
    _wsTickLive();
    if (!_wsLiveTimer) _wsLiveTimer = setInterval(_wsTickLive, 1000);
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
async function _weatherPanelSave(url, payload){
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

async function _saveWeatherCfg(partial){
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
function _debouncedWeatherSave(partial, ms = 600){
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

// Loose Reolink-stream-URL detector. Only the path matters — Reolink RTSP
// paths consistently follow /(h264|h265)?Preview_<channel>_<main|sub>. A
// false positive just means the daynight HTTP call fails and the helper
// logs and falls back; cost is one warning, no broken capture.
function _isReolinkRtsp(rtspUrl){
  if (!rtspUrl || typeof rtspUrl !== 'string') return false;
  return /\/(h264|h265)?Preview_\d+_(main|sub)/i.test(rtspUrl);
}

// 🎨 Farbmodus erzwingen — sub-row of a sun-timelapse row. Renders the
// toggle + lead-time slider; only meaningful on Reolink cams. The whole
// row is dimmed and the toggle disabled for non-Reolink cams (the user
// can still inspect what the control would do).
function _renderSunDnovRow(camId, phase, pcfg, isReolink){
  const dn = pcfg.daynight_override || {};
  const dnEnabled = !!dn.enabled;
  const lead = Math.max(1, Math.min(15, parseInt(dn.lead_min, 10) || 5));
  const disabledAttr = isReolink ? '' : 'disabled';
  const titleAttr = isReolink ? '' : ' title="Funktioniert nur mit Reolink-Kameras"';
  const dimCls = isReolink ? '' : ' ws-sun-dnov--disabled';
  return `
    <div class="ws-sun-dnov${dimCls}" data-phase="${esc(phase)}"${titleAttr}>
      <span class="ws-sun-dnov-label">🎨 Farbmodus erzwingen</span>
      <label class="switch ws-sun-dnov-toggle"><input type="checkbox" data-sun-dnov="${esc(phase)}" ${dnEnabled ? 'checked' : ''} ${disabledAttr}/><span class="slider"></span></label>
      <div class="ws-sun-dnov-detail" ${dnEnabled ? '' : 'hidden'}>
        <input type="range" min="1" max="15" step="1" value="${lead}" data-sun-dnov-lead="${esc(phase)}" ${disabledAttr}/>
        <span><span class="ws-sun-dnov-lead-num">${lead}</span> min vorher</span>
      </div>
      <div class="ws-sun-dnov-help">${isReolink
        ? 'Schaltet die Reolink-Kamera per API kurz vor Aufnahme auf Farbe und nach Ende zurück auf Auto.'
        : 'Funktioniert nur mit Reolink-Kameras (h264/h265Preview-RTSP-Pfade).'}</div>
    </div>`;
}

// Sun-timelapse video-length helpers. fps is fixed at 25 here — the user
// picks a target duration in seconds; we derive the capture interval from
// the configured window so the resulting video lands close to the target.
const _WS_LENGTH_OPTIONS = [10, 15, 20, 30, 45];
const _WS_DEFAULT_LENGTH_S = 20;
const _WS_FPS = 25;

function _wsLengthPlan(window_min, target_duration_s){
  const fps = _WS_FPS;
  const target = parseInt(target_duration_s, 10) || _WS_DEFAULT_LENGTH_S;
  const window_s = (parseInt(window_min, 10) || 30) * 60;
  const frames_target = Math.max(1, target * fps);
  const interval_s = Math.max(1, Math.round(window_s / frames_target));
  const actual_frames = Math.floor(window_s / interval_s);
  const actual_duration_s = Math.round((actual_frames / fps) * 10) / 10;
  return {
    target, fps, frames_target, interval_s,
    actual_frames, actual_duration_s,
    was_clamped: actual_duration_s + 0.05 < target,
  };
}

function _wsRenderLengthPreview(plan){
  const main = `→ <b>${plan.actual_frames}</b> Frames · 1 Bild alle <b>${plan.interval_s}</b> s · <b>${plan.fps}</b> fps`;
  const warn = plan.was_clamped
    ? ` <span class="ws-sun-length-warn">Fenster zu kurz für ${plan.target} s — wird ~${plan.actual_duration_s} s</span>`
    : '';
  return main + warn;
}

function _wsRenderLengthRow(phase, pcfg){
  const window_min = parseInt(pcfg.window_min, 10) || 30;
  const target = parseInt(pcfg.target_duration_s, 10) || _WS_DEFAULT_LENGTH_S;
  const plan = _wsLengthPlan(window_min, target);
  const opts = _WS_LENGTH_OPTIONS.map(s =>
    `<option value="${s}"${s === plan.target ? ' selected' : ''}>${s} s</option>`
  ).join('');
  return `
    <div class="ws-sun-length" data-phase="${esc(phase)}">
      <span class="ws-sun-length-label">Video-Länge</span>
      <select data-sun-length="${esc(phase)}">${opts}</select>
      <span class="ws-sun-length-preview" data-sun-length-preview="${esc(phase)}">${_wsRenderLengthPreview(plan)}</span>
    </div>`;
}

// Picker selection persists across renders within a session. Falls back
// to the first weather-enabled camera (or first overall) when the cached
// id is no longer in the camera list (e.g. after a delete).
let _wsSelectedCam = null;

function _renderWeatherCamList(){
  const wrap = byId('weatherCamList'); if (!wrap) return;
  const cams = state.cameras || [];
  if (!cams.length) { wrap.innerHTML = '<div class="field-help">Keine Kameras konfiguriert.</div>'; return; }
  if (!cams.find(c => c.id === _wsSelectedCam)){
    const firstEnabled = cams.find(c => c.weather && c.weather.enabled);
    _wsSelectedCam = (firstEnabled || cams[0]).id;
  }
  const tabsHtml = cams.length > 1
    ? `<div class="set-tabs ws-cam-tabs">${cams.map(c => `
        <button type="button" class="set-tab${c.id === _wsSelectedCam ? ' active' : ''}" data-ws-cam-tab="${esc(c.id)}">
          ${getCameraIcon(c.name)} ${esc(c.name || c.id)}
        </button>`).join('')}</div>`
    : '';
  const sel = cams.find(c => c.id === _wsSelectedCam);
  wrap.innerHTML = `${tabsHtml}<div class="ws-cam-tab-content">${_renderWeatherCamPanel(sel)}</div>`;
  wrap.querySelectorAll('[data-ws-cam-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      _wsSelectedCam = btn.dataset.wsCamTab;
      _renderWeatherCamList();
    });
  });
  _bindWeatherCamPanel(wrap, sel);
}

function _renderWeatherCamPanel(c){
  if (!c) return '';
  const wEnabled = !!(c.weather && c.weather.enabled);
  const sun = (c.weather && c.weather.sun_timelapse) || {};
  const sr = sun.sunrise || {}, ss = sun.sunset || {};
  const sunPreview = state.weather._sunTimes || { cameras: [] };
  const pre = (sunPreview.cameras || []).find(e => e.id === c.id) || {};
  const previewLine = (phase, p) => {
    if (!p.enabled) return '';
    if (!sunPreview.location_set) return '<span class="ws-sun-preview ws-sun-preview--err">Standort fehlt</span>';
    const ev = pre[phase] || {};
    if (!ev.window_start) return '<span class="ws-sun-preview">Polartag — kein ' + (phase === 'sunrise' ? 'Aufgang' : 'Untergang') + ' heute</span>';
    // Day-label switches to "Morgen" once today's window is past and the
    // backend has rolled to tomorrow's event. The live ticker below keeps
    // both the clock and the countdown current to the second.
    const dayLabel = ev.next_is_tomorrow ? 'Morgen' : 'Heute';
    const liveLine = ev.capture_start_iso
      ? `
        <span class="ws-sun-live">
          <span class="ws-sun-live-chip">Jetzt <span data-ws-now>—</span></span>
          <span class="ws-sun-live-chip">${ev.next_is_tomorrow ? 'Morgen ' : ''}nächste Aufnahme <span data-ws-countdown="${esc(ev.capture_start_iso)}" data-ws-countdown-end="${esc(ev.capture_end_iso || '')}">…</span></span>
        </span>`
      : '';
    return `<span class="ws-sun-preview">${dayLabel}: ${esc(ev.sun_event)} · Fenster ${esc(ev.window_start)} – ${esc(ev.window_end)}</span>${liveLine}`;
  };
  const isReolink = _isReolinkRtsp(c.rtsp_url);
  return `
    <div class="ws-cam-block" data-cam="${esc(c.id)}">
      <label class="toggle-row" style="margin:0">
        <span class="toggle-row-label">📷 ${esc(c.name || c.id)}</span>
        <label class="switch"><input type="checkbox" data-ws-cam="${esc(c.id)}" ${wEnabled ? 'checked' : ''}/><span class="slider"></span></label>
      </label>
      <div class="ws-sun-rows" ${wEnabled ? '' : 'hidden'}>
        <div class="ws-sun-row" data-phase="sunrise">
          <span class="ws-sun-icon" style="color:#e89540">${WEATHER_TYPES.sun_timelapse_rise.icon}</span>
          <span class="ws-sun-name">Sonnenaufgang</span>
          <label class="switch ws-sun-toggle"><input type="checkbox" data-sun-toggle="sunrise" ${sr.enabled ? 'checked' : ''}/><span class="slider"></span></label>
          <input type="range" class="ws-sun-slider" min="10" max="60" step="5" value="${sr.window_min || 30}" data-sun-window="sunrise"/>
          <span class="ws-sun-window"><span class="ws-sun-window-num">${sr.window_min || 30}</span> min</span>
          ${previewLine('sunrise', sr)}
          ${sr.enabled ? _wsRenderLengthRow('sunrise', sr) : ''}
          ${sr.enabled ? _renderSunDnovRow(c.id, 'sunrise', sr, isReolink) : ''}
        </div>
        <div class="ws-sun-row" data-phase="sunset">
          <span class="ws-sun-icon" style="color:#d4823a">${WEATHER_TYPES.sun_timelapse_set.icon}</span>
          <span class="ws-sun-name">Sonnenuntergang</span>
          <label class="switch ws-sun-toggle"><input type="checkbox" data-sun-toggle="sunset" ${ss.enabled ? 'checked' : ''}/><span class="slider"></span></label>
          <input type="range" class="ws-sun-slider" min="10" max="60" step="5" value="${ss.window_min || 30}" data-sun-window="sunset"/>
          <span class="ws-sun-window"><span class="ws-sun-window-num">${ss.window_min || 30}</span> min</span>
          ${previewLine('sunset', ss)}
          ${ss.enabled ? _wsRenderLengthRow('sunset', ss) : ''}
          ${ss.enabled ? _renderSunDnovRow(c.id, 'sunset', ss, isReolink) : ''}
        </div>
        ${_renderEventTLBlock(c)}
      </div>
    </div>`;
}

function _bindWeatherCamPanel(wrap, c){
  if (!c) return;
  const block = wrap.querySelector('.ws-cam-block'); if (!block) return;
  const camId = c.id;
  // Helper: read the current target_duration_s for a phase from the
  // in-memory state — fall back to the default if unset.
  const targetFor = (phase) => {
    const p = (((c.weather || {}).sun_timelapse || {})[phase] || {});
    return parseInt(p.target_duration_s, 10) || _WS_DEFAULT_LENGTH_S;
  };
  // Phase enable toggle.
  block.querySelectorAll('[data-sun-toggle]').forEach(cb => {
    cb.addEventListener('change', () => _saveSunPhase(camId, cb.dataset.sunToggle, { enabled: cb.checked }));
  });
  // Window slider — saving also recomputes interval_s so the backend sees
  // the new pacing without us round-tripping the formula on Python side.
  block.querySelectorAll('[data-sun-window]').forEach(sl => {
    const phase = sl.dataset.sunWindow;
    const numEl = sl.parentElement.querySelector('.ws-sun-window-num');
    const previewEl = block.querySelector(`[data-sun-length-preview="${phase}"]`);
    const refreshPreview = () => {
      if (!previewEl) return;
      const plan = _wsLengthPlan(parseInt(sl.value, 10), targetFor(phase));
      previewEl.innerHTML = _wsRenderLengthPreview(plan);
    };
    sl.addEventListener('input', () => {
      if (numEl) numEl.textContent = sl.value;
      refreshPreview();
    });
    sl.addEventListener('change', () => {
      const window_min = parseInt(sl.value, 10);
      const plan = _wsLengthPlan(window_min, targetFor(phase));
      _saveSunPhase(camId, phase, { window_min, interval_s: plan.interval_s });
    });
  });
  // Video-length select — persists the user's TARGET; backend uses the
  // recomputed interval_s for actual capture pacing.
  block.querySelectorAll('[data-sun-length]').forEach(sel => {
    const phase = sel.dataset.sunLength;
    const previewEl = block.querySelector(`[data-sun-length-preview="${phase}"]`);
    sel.addEventListener('change', () => {
      const target_duration_s = parseInt(sel.value, 10) || _WS_DEFAULT_LENGTH_S;
      const sliderEl = block.querySelector(`[data-sun-window="${phase}"]`);
      const window_min = sliderEl ? parseInt(sliderEl.value, 10) : 30;
      const plan = _wsLengthPlan(window_min, target_duration_s);
      if (previewEl) previewEl.innerHTML = _wsRenderLengthPreview(plan);
      _saveSunPhase(camId, phase, { target_duration_s, interval_s: plan.interval_s });
    });
  });
  // Day/night override toggles + lead-time sliders. _saveSunPhase
  // deep-merges the daynight_override sub-object so toggling enabled
  // doesn't wipe the lead_min the user dialled in (and vice versa).
  block.querySelectorAll('[data-sun-dnov]').forEach(cb => {
    cb.addEventListener('change', () => _saveSunPhase(camId, cb.dataset.sunDnov, {
      daynight_override: { enabled: cb.checked, revert: 'auto' },
    }));
  });
  block.querySelectorAll('[data-sun-dnov-lead]').forEach(sl => {
    const numEl = sl.parentElement.querySelector('.ws-sun-dnov-lead-num');
    sl.addEventListener('input', () => { if (numEl) numEl.textContent = sl.value; });
    sl.addEventListener('change', () => _saveSunPhase(camId, sl.dataset.sunDnovLead, {
      daynight_override: { lead_min: parseInt(sl.value, 10) },
    }));
  });
}

async function _saveSunPhase(camId, phase, partial){
  const cam = (state.cameras || []).find(c => c.id === camId);
  if (!cam) return;
  // Phase block is a 1-level merge by default. The daynight_override
  // sub-object needs an explicit 2nd-level merge so toggling `enabled`
  // doesn't wipe `lead_min` (and vice versa).
  const prevPhase = (((cam.weather || {}).sun_timelapse || {})[phase] || {});
  const mergedPhase = { ...prevPhase, ...partial };
  if (partial && partial.daynight_override){
    mergedPhase.daynight_override = {
      ...(prevPhase.daynight_override || {}),
      ...partial.daynight_override,
    };
  }
  const updated = { ...cam,
    weather: {
      ...(cam.weather || { enabled: false }),
      sun_timelapse: {
        ...((cam.weather && cam.weather.sun_timelapse) || {}),
        [phase]: mergedPhase,
      },
    },
  };
  const r = await _weatherPanelSave('/api/settings/cameras', updated);
  if (r && r.ok) {
    cam.weather = updated.weather;
    // Refresh the preview line for this camera by re-fetching sun-times.
    const st = await fetch('/api/weather/sun-times').then(x => x.json()).catch(() => null);
    if (st) state.weather._sunTimes = st;
    _renderWeatherCamList();
  }
}

// ── Event-Timelapse: per-camera Settings rows ─────────────────────────────────

const _EVENT_TL_TRIGGERS = ['thunder_rising', 'front_passing', 'storm_front'];

function _renderEventTLBlock(cam, sun){
  const evt = (cam.weather && cam.weather.event_timelapse) || {};
  const enabled = !!evt.enabled;
  const triggers = evt.triggers || {};
  const win = evt.window_min || 60;
  const trigChips = _EVENT_TL_TRIGGERS.map(t => {
    const meta = WEATHER_TYPES[t] || { de: t, color: '#94a3b8', icon: '' };
    const on = triggers[t] !== false;
    return `
      <div class="ws-evt-trigger-row" data-trig="${esc(t)}">
        <span class="ws-evt-trigger-chip" style="background:${meta.color}22;border:1px solid ${meta.color}55;color:${meta.color}">${meta.icon} ${esc(meta.de)}</span>
        <label class="switch ws-evt-trigger-toggle"><input type="checkbox" data-evt-trigger="${esc(t)}" ${on ? 'checked' : ''}/><span class="slider"></span></label>
      </div>`;
  }).join('');
  return `
    <div class="ws-evt-block" data-cam-evt="${esc(cam.id)}">
      <div class="ws-evt-head">
        <span class="ws-evt-icon">⛈</span>
        <span class="ws-evt-name">Ereignis-Timelapse</span>
        <label class="switch"><input type="checkbox" data-evt-master ${enabled ? 'checked' : ''}/><span class="slider"></span></label>
      </div>
      <div class="ws-evt-body" ${enabled ? '' : 'hidden'}>
        <div class="ws-evt-window-row">
          <span class="ws-evt-window-label">Fenster</span>
          <input type="range" class="ws-evt-window-slider" min="30" max="120" step="15" value="${win}" data-evt-window/>
          <span class="ws-evt-window-val"><span class="ws-evt-window-num">${win}</span> min</span>
        </div>
        ${trigChips}
        <div class="ws-evt-hint">Maximal 2 Ereignis-Timelapses pro Kamera und Tag · 4 h Cooldown nach jedem Trigger.</div>
      </div>
    </div>`;
}

async function _saveEventTL(camId, partial){
  const cam = (state.cameras || []).find(c => c.id === camId);
  if (!cam) return;
  // Deep-merge `partial` (e.g. {triggers:{thunder_rising:true}}) into the
  // current event_timelapse block so a single toggle save doesn't wipe
  // sibling fields.
  const cur = (cam.weather && cam.weather.event_timelapse) || {};
  const merged = { ...cur, ...partial };
  if (partial.triggers) merged.triggers = { ...(cur.triggers || {}), ...partial.triggers };
  const updated = { ...cam,
    weather: {
      ...(cam.weather || { enabled: false }),
      event_timelapse: merged,
    },
  };
  const r = await _weatherPanelSave('/api/settings/cameras', updated);
  if (r && r.ok) {
    cam.weather = updated.weather;
    _renderWeatherCamList();
  }
}

// Wire event-tl handlers via the existing weatherCamList delegated listener
// added in Phase Sun-TL.
document.addEventListener('change', (e) => {
  const block = e.target.closest('.ws-evt-block'); if (!block) return;
  const camId = block.dataset.camEvt;
  if (e.target.matches('[data-evt-master]')) {
    _saveEventTL(camId, { enabled: !!e.target.checked });
    return;
  }
  if (e.target.matches('[data-evt-trigger]')) {
    const trig = e.target.dataset.evtTrigger;
    _saveEventTL(camId, { triggers: { [trig]: !!e.target.checked } });
    return;
  }
});
document.addEventListener('input', (e) => {
  if (!e.target.matches('[data-evt-window]')) return;
  const block = e.target.closest('.ws-evt-block'); if (!block) return;
  const numEl = block.querySelector('.ws-evt-window-num');
  if (numEl) numEl.textContent = e.target.value;
});
document.addEventListener('change', (e) => {
  if (!e.target.matches('[data-evt-window]')) return;
  const block = e.target.closest('.ws-evt-block'); if (!block) return;
  const camId = block.dataset.camEvt;
  _saveEventTL(camId, { window_min: parseInt(e.target.value, 10) });
});

function _renderWeatherEventsList(events){
  const wrap = byId('weatherEventsList'); if (!wrap) return;
  // Sun-Timelapse types are configured in the per-camera section below;
  // they don't have a single global threshold to slide, so skip them in
  // this list to avoid an undefined-`hint` crash.
  const tunable = Object.keys(WEATHER_TYPES).filter(t => WEATHER_THRESHOLD_HINTS[t]);
  wrap.innerHTML = tunable.map(t => {
    const meta = WEATHER_TYPES[t];
    const cfg = events[t] || {};
    const hint = WEATHER_THRESHOLD_HINTS[t];
    const v = cfg[hint.key] != null ? Number(cfg[hint.key]) : (hint.min + (hint.max - hint.min) / 2);
    return `
      <div class="ws-event-row" data-event="${esc(t)}">
        <span class="ws-event-chip" style="background:${meta.color}22;border:1px solid ${meta.color}55;color:${meta.color}">${meta.icon} ${esc(meta.de)}</span>
        <label class="switch ws-event-toggle"><input type="checkbox" ${cfg.enabled !== false ? 'checked' : ''} data-ws-event-toggle/><span class="slider"></span></label>
        <input type="range" class="ws-event-slider" min="${hint.min}" max="${hint.max}" step="${hint.step}" value="${v}" data-ws-event-slider/>
        <span class="ws-event-val"><span class="ws-event-num">${v}</span> ${esc(hint.unit)}</span>
      </div>`;
  }).join('');
}

// ── Weather location map (Leaflet) ──────────────────────────────────────────
// Lazy singleton — Leaflet can only render once its container is visible, so
// init is deferred until the Standort tab is opened. Subsequent opens just
// invalidateSize() so the tile grid refits the (possibly resized) container.
let _wsMap = null;
let _wsMarker = null;
let _wsSyncing = false;        // suppresses input handlers while we write
                               // values from the map back into the inputs
let _wsLocSaveTimer = null;

function _wsPinIcon(){
  // Flat-design teardrop pin in storm-blue. 32×42 visual on a 44×44 hit area
  // so the touch target hits the project's iOS minimum.
  const svg = '<svg viewBox="0 0 32 44" width="32" height="42" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M16 2C9.4 2 4 7.4 4 14c0 9 12 26 12 26s12-17 12-26c0-6.6-5.4-12-12-12z" '
    + 'fill="rgb(127,174,201)" stroke="rgba(0,0,0,.35)" stroke-width="1"/>'
    + '<circle cx="16" cy="14" r="4.5" fill="#fff"/></svg>';
  return L.divIcon({
    className: 'ws-map-pin-wrap',
    html: '<div class="ws-map-pin-hit">' + svg + '</div>',
    iconSize: [44, 44],
    iconAnchor: [22, 42],
  });
}

function _initWeatherMap(){
  const el = byId('weatherMap');
  if (!el) return;
  if (typeof L === 'undefined') return; // Leaflet CDN unreachable — fail silent
  if (_wsMap) { _wsMap.invalidateSize(); return; }
  const lat = parseFloat(byId('ws_lat').value);
  const lon = parseFloat(byId('ws_lon').value);
  const hasLoc = Number.isFinite(lat) && Number.isFinite(lon);
  _wsMap = L.map(el, {
    center: hasLoc ? [lat, lon] : [51.16, 10.45],
    zoom:   hasLoc ? 15 : 5,
    scrollWheelZoom: true,
  });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
  }).addTo(_wsMap);
  if (hasLoc) _setWeatherMapMarker(lat, lon, false);
  _wsMap.on('click', (e) => {
    _setWeatherMapMarker(e.latlng.lat, e.latlng.lng, false);
    _wsWriteInputsFromMap(e.latlng.lat, e.latlng.lng);
    _saveWeatherLocation();
  });
  // Container was hidden when init started in some flows — ensure tile grid
  // matches the visible size on the next paint.
  setTimeout(() => { if (_wsMap) _wsMap.invalidateSize(); }, 60);
}

function _setWeatherMapMarker(lat, lon, panTo){
  if (!_wsMap) return;
  const ll = [lat, lon];
  if (!_wsMarker) {
    _wsMarker = L.marker(ll, { draggable: true, icon: _wsPinIcon() }).addTo(_wsMap);
    _wsMarker.on('dragend', (ev) => {
      const p = ev.target.getLatLng();
      _wsWriteInputsFromMap(p.lat, p.lng);
      _saveWeatherLocation();
    });
  } else {
    _wsMarker.setLatLng(ll);
  }
  if (panTo) _wsMap.setView(ll, Math.max(_wsMap.getZoom(), 13));
}

function _wsWriteInputsFromMap(lat, lon){
  _wsSyncing = true;
  const elLat = byId('ws_lat'); if (elLat) elLat.value = lat.toFixed(6);
  const elLon = byId('ws_lon'); if (elLon) elLon.value = lon.toFixed(6);
  _wsSyncing = false;
}

async function _saveWeatherLocation(){
  const lat = parseFloat(byId('ws_lat').value);
  const lon = parseFloat(byId('ws_lon').value);
  const elevRaw = byId('ws_elev').value;
  const elev = elevRaw === '' ? null : parseFloat(elevRaw);
  const partial = { server: { location: {
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    elevation: Number.isFinite(elev) ? elev : null,
  } } };
  const r = await _weatherPanelSave('/api/settings/app', partial);
  if (r && r.ok) {
    state.config.server = state.config.server || {};
    state.config.server.location = partial.server.location;
    if (Number.isFinite(lat) && Number.isFinite(lon) && elevRaw === '') {
      _wsAutoFetchElevation(lat, lon);
    }
  }
}

async function _wsAutoFetchElevation(lat, lon){
  // Open-Meteo /v1/elevation: free, no key, returns {elevation:[<m>]}.
  // Silent failure — manual elev entry stays the user's fallback.
  try {
    const r = await fetch('https://api.open-meteo.com/v1/elevation?latitude=' + lat + '&longitude=' + lon);
    if (!r.ok) return;
    const d = await r.json();
    const m = Array.isArray(d.elevation) ? d.elevation[0] : null;
    if (m == null || !Number.isFinite(m)) return;
    const elv = byId('ws_elev');
    if (!elv || elv.value !== '') return; // user filled it in meanwhile
    _wsSyncing = true;
    elv.value = Math.round(m);
    _wsSyncing = false;
    _saveWeatherLocation();
  } catch (_) { /* silent */ }
}

function _bindWsLocationInputs(){
  // Debounced input handler: pans the map and saves once typing settles.
  // The dataset guard makes re-binding (re-hydrate) a no-op.
  for (const id of ['ws_lat', 'ws_lon', 'ws_elev']) {
    const el = byId(id);
    if (!el || el.dataset.wsBound === '1') continue;
    el.dataset.wsBound = '1';
    el.addEventListener('input', () => {
      if (_wsSyncing) return;
      clearTimeout(_wsLocSaveTimer);
      _wsLocSaveTimer = setTimeout(() => {
        const lat = parseFloat(byId('ws_lat').value);
        const lon = parseFloat(byId('ws_lon').value);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          _setWeatherMapMarker(lat, lon, true);
        }
        _saveWeatherLocation();
      }, 400);
    });
  }
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
  byId('weatherEventsList')?.addEventListener('change', (e) => {
    const row = e.target.closest('.ws-event-row'); if (!row) return;
    const evt = row.dataset.event;
    if (e.target.matches('[data-ws-event-toggle]')) {
      _saveWeatherCfg({ events: { [evt]: { enabled: !!e.target.checked } } });
    }
  });
  byId('weatherEventsList')?.addEventListener('input', (e) => {
    if (!e.target.matches('[data-ws-event-slider]')) return;
    const row = e.target.closest('.ws-event-row');
    const evt = row.dataset.event;
    const hint = WEATHER_THRESHOLD_HINTS[evt];
    const v = parseFloat(e.target.value) || 0;
    row.querySelector('.ws-event-num').textContent = v;
    _debouncedWeatherSave({ events: { [evt]: { [hint.key]: v } } });
  });
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
  } catch (e) {
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
