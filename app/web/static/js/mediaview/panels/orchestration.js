// ─── mediaview/panels/orchestration.js ─────────────────────────────────────
// Composes the recorded-mode panel tabs and the fine-analysis fold
// into the existing #lightboxSettings host. Replaces the direct call
// to lbRenderSettingsPanel(item) from lightbox.js so the same DOM
// real-estate now carries: tabs ("Aufnahme-Settings" · optional
// "Wetter") + the always-on fine-analysis fold below. The
// regenerate-tracking action lives in the overlay-toggles pill row
// (see lightbox.js · mountReindexButton) so it's always visible
// without paging into a tab.
//
// The settings tab is auto-expanded — inside a tab the user has
// already chosen to look at it, so the inner collapsible header from
// settings-panel.js opens by default. The legacy collapse button is
// kept (a second click hides the body again) so muscle-memory still
// works.
import { byId } from '../../core/dom.js';
import { lbRenderSettingsPanel } from '../../mediathek/bbox-overlay/settings-panel.js';
import { renderPanelTabs } from '../panel-tabs.js';
import { renderFineAnalysisFold } from '../fine-analysis-fold.js';

function _renderSettingsTab(host, item){
  // Reuse the existing settings renderer with a custom host. After
  // it renders, auto-expand the body so the user doesn't have to
  // click twice (once for the tab, once for the panel collapse).
  lbRenderSettingsPanel(item, host);
  const body = host.querySelector('.lbset-body');
  const header = host.querySelector('.lbset-header');
  if (body && header && body.hidden){
    body.hidden = false;
    header.setAttribute('aria-expanded', 'true');
  }
}

// Field-label / unit lookup for weather-sighting api_snapshot rows.
// Mirrors weather/sightings.js' WEATHER_FIELD_LABEL_DE / _UNIT_DE so
// the tab reads the same as the legacy ws-lb-rows block did. Kept
// inline (no shared module yet) because the rest of weather/* is in
// a different load order and importing it here would add a dependency
// cycle for one short dict.
const _WS_FIELD_LBL = {
  temperature_2m: 'Temperatur',
  humidity_2m: 'Luftfeuchte',
  precipitation: 'Niederschlag',
  rain: 'Regen',
  snowfall: 'Schnee',
  cloud_cover: 'Bewölkung',
  wind_speed_10m: 'Wind',
  wind_gusts_10m: 'Wind-Böen',
  pressure_msl: 'Luftdruck',
  weather_code: 'Wettercode',
  apparent_temperature: 'Gefühlt',
  visibility: 'Sicht',
};
const _WS_FIELD_UNIT = {
  temperature_2m: '°C',
  humidity_2m: '%',
  precipitation: 'mm',
  rain: 'mm',
  snowfall: 'cm',
  cloud_cover: '%',
  wind_speed_10m: 'km/h',
  wind_gusts_10m: 'km/h',
  pressure_msl: 'hPa',
  apparent_temperature: '°C',
  visibility: 'm',
};

function _renderWeatherTab(host, item){
  // Two shapes are supported:
  //   item.weather      → simple {temperature_c, cloud_cover_pct, …}
  //                       (motion-clip / future generic timelapse)
  //   item.api_snapshot → Open-Meteo raw snapshot dict (weather sighting)
  // The sighting variant also carries item.sun_snapshot for sunsets /
  // fog clips so the operator sees the altitude/azimuth alongside.
  const w = item?.weather;
  const snap = item?.api_snapshot;
  const sun = item?.sun_snapshot;
  if ((!w || typeof w !== 'object') && (!snap || typeof snap !== 'object')){
    host.innerHTML = `<div class="mv-rescan-empty">Keine Wetterdaten für diese Aufnahme.</div>`;
    return;
  }
  let rows = [];
  if (w && typeof w === 'object'){
    rows = [
      ['Temperatur',  w.temperature_c, '°C'],
      ['Bewölkung',   w.cloud_cover_pct, '%'],
      ['Niederschlag', w.precip_mm, ' mm'],
      ['Wind',        w.wind_kmh, ' km/h'],
      ['Luftfeuchte', w.humidity_pct, '%'],
      ['Bedingung',   w.condition, ''],
    ];
  } else if (snap){
    rows = Object.entries(snap)
      .filter(([k, v]) => v !== null && v !== undefined && k !== 'time')
      .map(([k, v]) => [_WS_FIELD_LBL[k] || k, v, _WS_FIELD_UNIT[k] || '']);
  }
  rows = rows.filter(([, v]) => v != null && v !== '');
  // Sun-snapshot label map — matches the keys the weather service
  // actually emits. _clip.py writes the bare `altitude`/`azimuth`
  // pair (the moment-of-clip snapshot); _sun_tl.py writes the
  // *_at_start / *_at_end pair (the sun position bracketing the
  // sun-timelapse window). Pre-fix, anything that wasn't literally
  // 'altitude' got the "Sonne · Azimut" label — so a sun-timelapse
  // showed FOUR rows all labelled "Sonne · Azimut" with different
  // values. Unknown keys fall back to a humanised version of the
  // key so a future field addition still reads sensibly.
  const _SUN_LBL = {
    altitude:          'Sonne · Höhe',
    azimuth:           'Sonne · Azimut',
    altitude_at_start: 'Sonne · Höhe (Start)',
    altitude_at_end:   'Sonne · Höhe (Ende)',
    azimuth_at_start:  'Sonne · Azimut (Start)',
    azimuth_at_end:    'Sonne · Azimut (Ende)',
    noon_altitude:     'Sonne mittags · Höhe',
    sunrise_azimuth:   'Sonnenaufgang · Azimut',
    sunset_azimuth:    'Sonnenuntergang · Azimut',
  };
  const sunRows = (sun && typeof sun === 'object')
    ? Object.entries(sun)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => {
          const label = _SUN_LBL[k]
            || ('Sonne · ' + k.replaceAll('_', ' '));
          return [label, Number(v).toFixed(1), '°'];
        })
    : [];
  const allRows = [...rows, ...sunRows];
  host.innerHTML = `
    <div class="mv-weather">
      ${allRows.map(([k, v, unit]) =>
        `<div class="mv-weather-row"><span class="mv-weather-key">${k}</span><span class="mv-weather-val">${v}${unit ? ' ' + unit : ''}</span></div>`,
      ).join('')}
    </div>`;
}

// Public entry — called from lightbox.js for BOTH motion clips and
// timelapses. Motion clips get Aufnahme-Settings + optional Wetter;
// timelapses get Wetter when present (no Aufnahme-Settings since
// timelapses don't carry recording_settings — they're not produced
// by the alarm pipeline). The Nach-Erkennung tab was retired —
// its single regenerate action moved into the overlay-toggles row
// (lightbox.js · mountReindexButton) so it's always visible.
export function mountRecordedPanels(item){
  const host = byId('lightboxSettings');
  if (!host) return;
  if (!item){
    host.innerHTML = '';
    return;
  }
  const isTimelapse = item.type === 'timelapse';
  host.innerHTML = `
    <div class="mv-recorded-panels">
      <div class="mv-recorded-tabs"></div>
      <div class="mv-recorded-fafold"></div>
    </div>`;
  const tabsHost = host.querySelector('.mv-recorded-tabs');
  const faHost = host.querySelector('.mv-recorded-fafold');
  const tabs = [];
  if (!isTimelapse){
    tabs.push({ id: 'settings',
      label: 'Aufnahme-Settings',
      render: (h) => _renderSettingsTab(h, item) });
  }
  // Weather tab — mounted whenever the item carries a weather
  // snapshot. Two shapes are accepted: item.weather (normalised
  // pairs) and item.api_snapshot (raw Open-Meteo dict, used by
  // weather sightings via openTLPlayer). Motion clips usually
  // carry neither; timelapses + weather sightings do.
  const hasWeather = !!((item.weather && typeof item.weather === 'object')
                         || (item.api_snapshot && typeof item.api_snapshot === 'object'));
  if (hasWeather){
    tabs.push({ id: 'weather',
      label: 'Wetter',
      render: (h) => _renderWeatherTab(h, item) });
  }
  // Initial tab — Aufnahme-Settings for motion clips; Wetter for
  // timelapses when present. Timelapses with no weather data fall
  // through to the empty tab strip + fold below.
  let initialId;
  if (isTimelapse && hasWeather) initialId = 'weather';
  else if (!isTimelapse) initialId = 'settings';
  if (tabs.length){
    renderPanelTabs(tabsHost, tabs, { initialId });
  }
  // Recorded clips don't carry a server-side decision trace today —
  // the fold renders the standard "Trace nur im Live-Test verfügbar"
  // empty state. When the trace gets persisted (future change), pass
  // the lines through here.
  renderFineAnalysisFold(faHost, null);
}
