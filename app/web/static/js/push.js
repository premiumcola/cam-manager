// ─── push.js ───────────────────────────────────────────────────────────────
// Stage 12 of the legacy.js → ES modules refactor — Telegram push
// settings (the "Was senden" tab + per-label thresholds + quiet
// hours + night alert + presets), plus the weather-events extension
// that hooks into the same "Was senden" panel. Both bind to a single
// settings.telegram.push subtree on the server.
import { byId, esc } from './core/dom.js';
import { state } from './core/state.js';
import { showToast, showConfirm } from './core/toast.js';
import { colors, OBJ_LABEL } from './core/icons.js';
import { WEATHER_TYPES } from './core/weather-types.js';

// Order in the "Was senden" list — matches the spec's reading order
// (Person first, animals + person before motion).
const _PUSH_LABEL_ORDER = ['person', 'squirrel', 'dog', 'car', 'cat', 'bird', 'motion'];

// Schema-default block — used by the "Standard"-Preset and as a
// fallback when the backend hasn't shipped the keys yet. Mirror of
// _TELEGRAM_PUSH_DEFAULTS in settings_store.py — keep the two in sync.
function _pushDefaults(){
  return {
    enabled: true, rate_limit_seconds: 30,
    quiet_hours: { start: '22:00', end: '07:00' },
    night_alert: { enabled: true, armed_only: true, use_sun: true, lat: null, lon: null, start: '22:00', end: '07:00' },
    labels: {
      person:   { push: true,  threshold: 0.85 },
      cat:      { push: false, threshold: 0.80 },
      dog:      { push: true,  threshold: 0.80 },
      bird:     { push: false, threshold: 0.90 },
      car:      { push: true,  threshold: 0.85 },
      squirrel: { push: true,  threshold: 0.80 },
      motion:   { push: false, threshold: 0.0 },
    },
    daily_report: { enabled: true, time: '22:00' },
    highlight:    { enabled: true, time: '19:00' },
    system:       { enabled: true },
    timelapse:    { enabled: true },
  };
}

// Pull current push config from loaded state with safe fallbacks.
function _pushCfg(){
  const tg = state.config?.telegram || {};
  // Deep merge defaults under user values so the UI never gets undefined.
  const def = _pushDefaults();
  const cur = tg.push || {};
  const merge = (d, c) => {
    const out = { ...d };
    for (const k of Object.keys(c || {})){
      if (c[k] && typeof c[k] === 'object' && !Array.isArray(c[k]) && d[k] && typeof d[k] === 'object'){
        out[k] = merge(d[k], c[k]);
      } else {
        out[k] = c[k];
      }
    }
    return out;
  };
  return merge(def, cur);
}

let _pushSaveTimer = null;
async function savePushCfg(partial){
  // Optimistic local merge so the UI reflects the change instantly;
  // the next /api/bootstrap refresh will overwrite if anything diverged.
  if (state.config){
    state.config.telegram = state.config.telegram || {};
    state.config.telegram.push = _mergeDeep(state.config.telegram.push || {}, partial);
  }
  await fetch('/api/settings/telegram/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(partial) });
}

function _mergeDeep(t, s){
  for (const k of Object.keys(s || {})){
    if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k]) && t[k] && typeof t[k] === 'object'){
      _mergeDeep(t[k], s[k]);
    } else {
      t[k] = s[k];
    }
  }
  return t;
}

function _debouncedPushSave(partial, ms = 600){
  // Coalesce a flurry of slider input events into one POST.
  clearTimeout(_pushSaveTimer);
  _pushSaveTimer = setTimeout(() => savePushCfg(partial), ms);
}

let _pushDepsTimer = null;

export function hydratePushUI(){
  const cfg = _pushCfg();
  // ── "Wann senden" ────────────────────────────────────────────────────────
  const set = (id, prop, val) => { const el = byId(id); if (el) el[prop] = val; };
  set('push_enabled',           'checked', !!cfg.enabled);
  set('push_daily_enabled',     'checked', !!cfg.daily_report?.enabled);
  set('push_daily_time',        'value',   cfg.daily_report?.time || '22:00');
  set('push_highlight_enabled', 'checked', !!cfg.highlight?.enabled);
  set('push_highlight_time',    'value',   cfg.highlight?.time || '19:00');
  set('push_quiet_enabled',     'checked', !!cfg.quiet_hours?.start && !!cfg.quiet_hours?.end);
  set('push_quiet_start',       'value',   cfg.quiet_hours?.start || '22:00');
  set('push_quiet_end',         'value',   cfg.quiet_hours?.end || '07:00');
  set('push_night_enabled',     'checked', !!cfg.night_alert?.enabled);
  set('push_night_armed',       'checked', !!cfg.night_alert?.armed_only);
  const useSun = cfg.night_alert?.use_sun !== false;
  document.querySelectorAll('input[name="push_night_mode"]').forEach(r => {
    r.checked = (r.value === (useSun ? 'sun' : 'time'));
  });
  set('push_night_start', 'value', cfg.night_alert?.start || '22:00');
  set('push_night_end',   'value', cfg.night_alert?.end   || '07:00');
  _updatePushNightModeUI();

  // ── "Was senden" — labels list + bottom toggles ──────────────────────────
  _renderPushLabelsList(cfg.labels || {});
  set('push_timelapse_enabled', 'checked', !!cfg.timelapse?.enabled);
  set('push_system_enabled',    'checked', !!cfg.system?.enabled);

  // ── "Abhängigkeiten" ─────────────────────────────────────────────────────
  hydratePushDeps();
  if (!_pushDepsTimer) _pushDepsTimer = setInterval(hydratePushDeps, 30000);

  _bindPushHandlers();

  // Weather extension — extends the same "Was senden" tab with a
  // wetter-events row + recap toggle. Inlined here so the previous
  // monkey-patch (`hydratePushUI = function(){...}`) goes away.
  _hydratePushWeather();
  _bindPushWeatherHandlers();
}

function _renderPushLabelsList(labels){
  const wrap = byId('pushLabelsList');
  if (!wrap) return;
  wrap.innerHTML = _PUSH_LABEL_ORDER.map(lbl => {
    const l = labels[lbl] || { push: false, threshold: 0.8 };
    const color = colors[lbl] || '#5bc8f5';
    const name = OBJ_LABEL[lbl] || lbl;
    const pct = Math.round((l.threshold || 0) * 100);
    return `
      <div class="push-label-row" data-label="${esc(lbl)}">
        <span class="push-label-chip" style="background:${esc(color)}22;border:1px solid ${esc(color)}55;color:${esc(color)}">${esc(name)}</span>
        <label class="switch push-label-toggle"><input type="checkbox" ${l.push ? 'checked' : ''} data-push-toggle/><span class="slider"></span></label>
        <input type="range" class="push-label-slider" min="0.5" max="1.0" step="0.05" value="${l.threshold || 0.8}" ${l.push ? '' : 'disabled'} data-push-slider/>
        <span class="push-label-pct">${pct}%</span>
      </div>`;
  }).join('');
}

function _updatePushNightModeUI(){
  const useSun = document.querySelector('input[name="push_night_mode"][value="sun"]')?.checked;
  const sunInfo = byId('push_night_sun_info');
  const timeRow = byId('push_night_time_row');
  if (timeRow) timeRow.style.display = useSun ? 'none' : 'grid';
  if (!sunInfo) return;
  if (useSun){
    const cfg = _pushCfg();
    const lat = cfg.night_alert?.lat, lon = cfg.night_alert?.lon;
    if (lat == null || lon == null){
      sunInfo.innerHTML = '<span style="color:#ef4444">Standort in App &amp; Server festlegen, sonst fällt der Nacht-Alarm auf die feste Uhrzeit zurück.</span>';
    } else {
      sunInfo.textContent = `Standort gesetzt (lat ${lat}, lon ${lon}). Nacht-Erkennung über Sonnenstand (Civil Dusk = elev < −6°).`;
    }
  } else {
    sunInfo.textContent = '';
  }
}

function _bindPushHandlers(){
  // Top-level master switch.
  byId('push_enabled')?.addEventListener('change', e => savePushCfg({ enabled: e.target.checked }));
  // Daily / highlight: toggle + time.
  for (const [id, key] of [['push_daily_enabled', 'daily_report'], ['push_highlight_enabled', 'highlight']]){
    byId(id)?.addEventListener('change', e => savePushCfg({ [key]: { enabled: e.target.checked } }));
  }
  byId('push_daily_time')?.addEventListener('change', e => savePushCfg({ daily_report: { time: e.target.value } }));
  byId('push_highlight_time')?.addEventListener('change', e => savePushCfg({ highlight: { time: e.target.value } }));
  // Quiet hours.
  byId('push_quiet_enabled')?.addEventListener('change', e => {
    // "off" ≈ start==end. Backend has no separate enabled flag — to actually
    // disable, blank out start/end (backend's is_quiet_now returns false).
    if (e.target.checked){
      savePushCfg({ quiet_hours: { start: byId('push_quiet_start').value || '22:00', end: byId('push_quiet_end').value || '07:00' } });
    } else {
      savePushCfg({ quiet_hours: { start: '00:00', end: '00:00' } });
    }
  });
  byId('push_quiet_start')?.addEventListener('change', e => savePushCfg({ quiet_hours: { start: e.target.value } }));
  byId('push_quiet_end')?.addEventListener('change',   e => savePushCfg({ quiet_hours: { end: e.target.value } }));
  // Night alert.
  byId('push_night_enabled')?.addEventListener('change', e => savePushCfg({ night_alert: { enabled: e.target.checked } }));
  byId('push_night_armed')?.addEventListener('change',   e => savePushCfg({ night_alert: { armed_only: e.target.checked } }));
  document.querySelectorAll('input[name="push_night_mode"]').forEach(r => {
    r.addEventListener('change', () => {
      const useSun = document.querySelector('input[name="push_night_mode"][value="sun"]').checked;
      savePushCfg({ night_alert: { use_sun: useSun } });
      _updatePushNightModeUI();
    });
  });
  byId('push_night_start')?.addEventListener('change', e => savePushCfg({ night_alert: { start: e.target.value } }));
  byId('push_night_end')?.addEventListener('change',   e => savePushCfg({ night_alert: { end: e.target.value } }));
  // Per-label rows (delegated).
  byId('pushLabelsList')?.addEventListener('change', e => {
    const row = e.target.closest('.push-label-row');
    if (!row) return;
    const lbl = row.dataset.label;
    if (e.target.matches('[data-push-toggle]')){
      const on = e.target.checked;
      const slider = row.querySelector('[data-push-slider]');
      if (slider) slider.disabled = !on;
      savePushCfg({ labels: { [lbl]: { push: on } } });
    }
    // [data-push-slider] saves on input below.
  });
  byId('pushLabelsList')?.addEventListener('input', e => {
    if (!e.target.matches('[data-push-slider]')) return;
    const row = e.target.closest('.push-label-row');
    const lbl = row.dataset.label;
    const v = parseFloat(e.target.value) || 0;
    const pctEl = row.querySelector('.push-label-pct');
    if (pctEl) pctEl.textContent = Math.round(v * 100) + '%';
    _debouncedPushSave({ labels: { [lbl]: { threshold: v } } });
  });
  // Bottom toggles.
  byId('push_timelapse_enabled')?.addEventListener('change', e => savePushCfg({ timelapse: { enabled: e.target.checked } }));
  byId('push_system_enabled')?.addEventListener('change',    e => savePushCfg({ system: { enabled: e.target.checked } }));
  // Presets.
  document.querySelectorAll('.push-preset-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!await showConfirm('Aktuelle Push-Einstellungen überschreiben?')) return;
      const preset = btn.dataset.preset;
      const block = _buildPushPreset(preset);
      await savePushCfg(block);
      hydratePushUI();
      showToast('Preset angewendet.', 'success');
    });
  });
}

function _buildPushPreset(name){
  const def = _pushDefaults();
  if (name === 'standard') return def;
  if (name === 'quiet'){
    return {
      enabled: true, quiet_hours: { start: '22:00', end: '08:00' },
      highlight: { enabled: false },
      labels: {
        person:   { push: true,  threshold: 0.90 },
        car:      { push: true,  threshold: 0.90 },
        squirrel: { push: false, threshold: 0.80 },
        dog:      { push: false, threshold: 0.80 },
        cat:      { push: false, threshold: 0.80 },
        bird:     { push: false, threshold: 0.90 },
        motion:   { push: false, threshold: 0.0 },
      },
    };
  }
  if (name === 'all'){
    return {
      enabled: true, quiet_hours: { start: '00:00', end: '00:00' },
      labels: {
        person:   { push: true, threshold: 0.70 },
        car:      { push: true, threshold: 0.70 },
        squirrel: { push: true, threshold: 0.70 },
        dog:      { push: true, threshold: 0.70 },
        cat:      { push: true, threshold: 0.70 },
        bird:     { push: true, threshold: 0.70 },
        motion:   { push: false, threshold: 0.0 },
      },
    };
  }
  return def;
}

function hydratePushDeps(){
  const wrap = byId('pushDepsList');
  if (!wrap) return;
  const tg = state.config?.telegram || {};
  const srv = state.config?.server || {};
  const cams = state.cameras || [];
  const someCoral = cams.some(c => c.coral_available);
  const someBird  = cams.some(c => c.bird_species_available);
  const hasLoc = !!(srv.location?.lat || (tg.push?.night_alert?.lat));
  const tgConn = !!(tg.enabled && tg.token && tg.chat_id);
  const rows = [
    [someCoral, 'Coral TPU aktiv',              'Wildlife-Erkennung verfügbar'],
    [someBird,  'iNaturalist-Modell vorhanden', 'Vogelarten-Klassifikation'],
    [hasLoc,    'Standort gesetzt',             'Sonnenstand-basierter Nacht-Alarm'],
    [tgConn,    'Telegram-Bot verbunden',       'Push-System sendet Nachrichten'],
  ];
  wrap.innerHTML = rows.map(([ok, title, desc]) => `
    <div class="push-dep-row">
      <span class="push-dep-dot ${ok ? 'ok' : 'off'}"></span>
      <div class="push-dep-text">
        <div class="push-dep-title">${esc(title)}</div>
        <div class="push-dep-desc">${esc(desc)}</div>
      </div>
    </div>
  `).join('');
}

// ── Push Weather settings (extends the "Was senden" tab) ─────────────────

const _PUSH_WEATHER_ORDER = ['thunder', 'heavy_rain', 'snow', 'fog', 'sunset'];

function _renderPushWeatherEvents(weatherCfg){
  const wrap = byId('pushWeatherEventsList');
  if (!wrap) return;
  const events = (weatherCfg && weatherCfg.events) || {};
  wrap.innerHTML = _PUSH_WEATHER_ORDER.map(t => {
    const meta = WEATHER_TYPES[t] || { de: t, color: '#94a3b8', icon: '' };
    const on = events[t] !== undefined ? !!events[t] : false;
    return `
      <div class="push-label-row" data-weather-evt="${esc(t)}">
        <span class="push-label-chip" style="background:${meta.color}22;border:1px solid ${meta.color}55;color:${meta.color}">${meta.icon} ${esc(meta.de)}</span>
        <label class="switch push-label-toggle"><input type="checkbox" ${on ? 'checked' : ''} data-weather-event-toggle/><span class="slider"></span></label>
        <span></span>
        <span></span>
      </div>`;
  }).join('');
}

function _hydratePushWeather(){
  const w = ((state.config?.telegram?.push) || {}).weather || {};
  const en    = byId('push_weather_enabled');   if (en)    en.checked = !!w.enabled;
  const recap = byId('push_weather_recap');     if (recap) recap.checked = w.recap_push !== false;
  const sl    = byId('push_weather_min_score');
  const lbl   = byId('push_weather_min_score_pct');
  const v     = w.min_score != null ? Number(w.min_score) : 0.4;
  if (sl)  sl.value = v;
  if (lbl) lbl.textContent = Math.round(v * 100) + '%';
  _renderPushWeatherEvents(w);
}

function _bindPushWeatherHandlers(){
  byId('push_weather_enabled')?.addEventListener('change', e =>
    savePushCfg({ weather: { enabled: e.target.checked } }));
  byId('push_weather_recap')?.addEventListener('change', e =>
    savePushCfg({ weather: { recap_push: e.target.checked } }));
  byId('push_weather_min_score')?.addEventListener('input', e => {
    const v = parseFloat(e.target.value) || 0;
    const lbl = byId('push_weather_min_score_pct');
    if (lbl) lbl.textContent = Math.round(v * 100) + '%';
    _debouncedPushSave({ weather: { min_score: v } });
  });
  byId('pushWeatherEventsList')?.addEventListener('change', e => {
    const row = e.target.closest('.push-label-row[data-weather-evt]');
    if (!row) return;
    if (!e.target.matches('[data-weather-event-toggle]')) return;
    const evt = row.dataset.weatherEvt;
    savePushCfg({ weather: { events: { [evt]: !!e.target.checked } } });
  });
}
