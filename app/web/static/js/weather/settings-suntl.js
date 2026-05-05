// ─── weather/settings-suntl.js ─────────────────────────────────────────────
// R10 — extracted from settings.js. Per-camera Sun-Timelapse form: window
// slider, Farbmodus override, video-length picker, live preview ticker.
// The Event-Timelapse block lives in settings-eventtl.js but is embedded
// inside _renderWeatherCamPanel below via a static import so the panel
// stays a single render path. The live-ticker lifecycle stays in
// settings.js (MutationObserver on #set-weather); settings.js calls
// tickSunTlPreview() from each tick.
import { byId, esc } from "../core/dom.js";
import { state } from "../core/state.js";
import { getCameraIcon } from "../core/icons.js";
import { WEATHER_TYPES } from "../core/weather-types.js";
import { _weatherPanelSave } from "./settings.js";
import { _renderEventTLBlock } from "./settings-eventtl.js";

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
// Mirror of _SUN_TL_LOCKED_WINDOW_MIN in app/app/weather_service/_sun_tl.py.
// The UI no longer surfaces a duration slider — keep this constant in
// sync with the backend if the lock value ever changes.
const _SUN_TL_LOCKED_WINDOW_MIN = 75;

function _wsLengthPlan(window_min, target_duration_s){
  const fps = _WS_FPS;
  const target = parseInt(target_duration_s, 10) || _WS_DEFAULT_LENGTH_S;
  const window_s = (parseInt(window_min, 10) || _SUN_TL_LOCKED_WINDOW_MIN) * 60;
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
  // window_min is locked on the backend; pcfg.window_min may still
  // carry a stale value from older settings.json. Use the locked
  // value so the on-screen frame-count preview matches actual
  // capture behaviour.
  const window_min = _SUN_TL_LOCKED_WINDOW_MIN;
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

export function _renderWeatherCamList(){
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
    if (!ev.window_start) return '<span class="ws-sun-preview">Polartag — kein ' + (phase === 'sunrise' ? 'sunrise' : 'sunset') + ' heute</span>';
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
          <span class="ws-sun-window-locked" title="Fenster fest auf 75 Min — deckt Civil Twilight + Goldene Stunde sicher ab.">75 min · fest</span>
          ${previewLine('sunrise', sr)}
          ${sr.enabled ? _wsRenderLengthRow('sunrise', sr) : ''}
          ${sr.enabled ? _renderSunDnovRow(c.id, 'sunrise', sr, isReolink) : ''}
        </div>
        <div class="ws-sun-row" data-phase="sunset">
          <span class="ws-sun-icon" style="color:#d4823a">${WEATHER_TYPES.sun_timelapse_set.icon}</span>
          <span class="ws-sun-name">Sonnenuntergang</span>
          <label class="switch ws-sun-toggle"><input type="checkbox" data-sun-toggle="sunset" ${ss.enabled ? 'checked' : ''}/><span class="slider"></span></label>
          <span class="ws-sun-window-locked" title="Fenster fest auf 75 Min — deckt Civil Twilight + Goldene Stunde sicher ab.">75 min · fest</span>
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
  // Window length is now locked to _SUN_TL_LOCKED_WINDOW_MIN (75) on
  // the backend — the slider was removed because user-tunable values
  // could land at 10 min, far too short to capture civil twilight.
  // The video-length select still drives interval_s (captured frames
  // per minute) so the user can pick a 30 / 60 / 90 s output.
  // Video-length select — persists the user's TARGET; backend uses the
  // recomputed interval_s for actual capture pacing.
  block.querySelectorAll('[data-sun-length]').forEach(sel => {
    const phase = sel.dataset.sunLength;
    const previewEl = block.querySelector(`[data-sun-length-preview="${phase}"]`);
    sel.addEventListener('change', () => {
      const target_duration_s = parseInt(sel.value, 10) || _WS_DEFAULT_LENGTH_S;
      const window_min = _SUN_TL_LOCKED_WINDOW_MIN;
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

// ── Live clock + countdown for the sun-tl preview rows ────────────────────
// settings.js owns the MutationObserver that fires/stops the interval (so
// the timer halts when the user collapses the section); each tick calls
// tickSunTlPreview() to actually update the DOM here.
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

export function tickSunTlPreview(){
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
