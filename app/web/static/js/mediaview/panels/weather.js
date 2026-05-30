// ─── mediaview/panels/weather.js ───────────────────────────────────────────
// "Wetter" tab — read-only snapshot of conditions at recording time.
// SINGLE owner of weather-row rendering across MediaView: the
// weather-mode shell (G) and the recorded-panel composer
// (panels/orchestration.js) both render their Wetter tab through this
// so the field labels / units / sun rows live in exactly one place
// (CLAUDE.md · no parallel implementations).
//
// Supported item shapes:
//   item.weather      → simple {temperature_c, cloud_cover_pct, …}
//                       (motion-clip / generic timelapse)
//   item.api_snapshot → Open-Meteo raw snapshot dict (weather sighting);
//                       Wind-Böen = wind_gusts_10m, etc.
//   item.sun_snapshot → altitude/azimuth (single) for a clip, or
//                       *_at_start / *_at_end brackets for a sun-timelapse.

import { esc } from '../../core/dom.js';

// Merged field-label map — the union of weather/stats.js
// (WEATHER_FIELD_LABEL_DE, used by the legacy weather-sighting player)
// and the broader set the recorded-panel composer carried, so NO key
// loses its German label regardless of which snapshot shape arrives.
const _WS_FIELD_LBL = {
  temperature_2m: 'Temperatur',
  apparent_temperature: 'Gefühlt',
  humidity_2m: 'Luftfeuchte',
  precipitation: 'Niederschlag',
  rain: 'Regen',
  snowfall: 'Schneefall',
  lightning_potential: 'Blitz-Potential',
  visibility: 'Sicht',
  cloud_cover: 'Bewölkung',
  wind_speed_10m: 'Wind',
  wind_gusts_10m: 'Wind-Böen',
  pressure_msl: 'Luftdruck',
  weather_code: 'Wettercode',
};
const _WS_FIELD_UNIT = {
  temperature_2m: '°C',
  apparent_temperature: '°C',
  humidity_2m: '%',
  precipitation: 'mm/h',
  rain: 'mm/h',
  snowfall: 'cm/h',
  lightning_potential: 'J/kg',
  visibility: 'm',
  cloud_cover: '%',
  wind_speed_10m: 'km/h',
  wind_gusts_10m: 'km/h',
  pressure_msl: 'hPa',
  weather_code: '',
};

// Sonnenstand labels — sun_snapshot keys → German. Sightings carry a
// single altitude/azimuth; sun-timelapses carry start/end brackets.
const _SUN_LBL = {
  altitude: 'Sonne · Höhe',
  azimuth: 'Sonne · Azimut',
  altitude_at_start: 'Sonne · Höhe (Start)',
  altitude_at_end: 'Sonne · Höhe (Ende)',
  azimuth_at_start: 'Sonne · Azimut (Start)',
  azimuth_at_end: 'Sonne · Azimut (Ende)',
  noon_altitude: 'Sonne mittags · Höhe',
  sunrise_azimuth: 'Sonnenaufgang · Azimut',
  sunset_azimuth: 'Sonnenuntergang · Azimut',
};

/**
 * Render the weather data rows into ``host``.
 *
 * @param {HTMLElement} host
 * @param {Object} item  Carries item.weather | item.api_snapshot |
 *   item.sun_snapshot.
 */
export function renderWeatherPanel(host, item) {
  if (!host) return;
  const w = item?.weather;
  const snap = item?.api_snapshot;
  const sun = item?.sun_snapshot;
  const hasAny =
    (w && typeof w === 'object') ||
    (snap && typeof snap === 'object') ||
    (sun && typeof sun === 'object');
  if (!hasAny) {
    host.innerHTML = `<div class="mv-rescan-empty">Keine Wetterdaten für diese Aufnahme.</div>`;
    return;
  }
  let rows = [];
  if (w && typeof w === 'object') {
    rows = [
      ['Temperatur', w.temperature_c, '°C'],
      ['Bewölkung', w.cloud_cover_pct, '%'],
      ['Niederschlag', w.precip_mm, 'mm'],
      ['Wind', w.wind_kmh, 'km/h'],
      ['Luftfeuchte', w.humidity_pct, '%'],
      ['Bedingung', w.condition, ''],
    ];
  } else if (snap && typeof snap === 'object') {
    rows = Object.entries(snap)
      .filter(([k, v]) => v !== null && v !== undefined && k !== 'time')
      .map(([k, v]) => [_WS_FIELD_LBL[k] || k, v, _WS_FIELD_UNIT[k] || '']);
  }
  rows = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  const sunRows =
    sun && typeof sun === 'object'
      ? Object.entries(sun)
          .filter(([, v]) => v !== null && v !== undefined)
          .map(([k, v]) => {
            const label = _SUN_LBL[k] || 'Sonne · ' + k.replaceAll('_', ' ');
            return [label, Number(v).toFixed(1), '°'];
          })
      : [];
  const allRows = [...rows, ...sunRows];
  if (!allRows.length) {
    host.innerHTML = `<div class="mv-rescan-empty">Keine Wetterdaten für diese Aufnahme.</div>`;
    return;
  }
  host.innerHTML =
    `<div class="mv-weather">` +
    allRows
      .map(
        ([k, v, unit]) =>
          `<div class="mv-weather-row"><span class="mv-weather-key">${esc(k)}</span><span class="mv-weather-val">${esc(String(v))}${unit ? ' ' + esc(unit) : ''}</span></div>`,
      )
      .join('') +
    `</div>`;
}
