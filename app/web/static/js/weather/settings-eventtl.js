// ─── weather/settings-eventtl.js ───────────────────────────────────────────
// R10 — extracted from settings.js. Per-camera Event-Timelapse block (the
// thunder/front-passing/storm-front trigger picker rendered inside the
// Sun-TL camera panel). Uses delegated document listeners so the inline
// rendering in settings-suntl.js never has to wire handlers per cell.
import { esc } from "../core/dom.js";
import { state } from "../core/state.js";
import { WEATHER_TYPES } from "../core/weather-types.js";
import { _weatherPanelSave } from "./settings.js";
import { _renderWeatherCamList } from "./settings-suntl.js";

// ── Event-Timelapse: per-camera Settings rows ─────────────────────────────────

const _EVENT_TL_TRIGGERS = ['thunder_rising', 'front_passing', 'storm_front'];

export function _renderEventTLBlock(cam, _sun){
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
