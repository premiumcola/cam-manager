// ─── core/weather-types.js ─────────────────────────────────────────────────
// Stage 16 of the legacy.js → ES modules refactor — single source of
// truth for Wetter-Ereignis type → label/color/icon. Backend mirror
// lives in app/app/weather_service.py:EVENT_LABEL_DE / EVENT_ICON_HEX
// — keep both in sync.
//
// Extracting this constant first (ahead of the rest of the weather
// domain) lets push.js drop its `window.WEATHER_TYPES` lookup in
// favour of a direct named import; the larger weather modules
// (sightings, chart, settings, map, recaps) stay in legacy.js until a
// dedicated weather extraction stage.

// `de`      = short label shown on chips, badges, and the gallery pill row
// `de_full` = full German label, used for aria-label / title and any
//             surface where space is not the constraint. The pill
//             renderer falls back to `de` when `de_full` is absent.
export const WEATHER_TYPES = {
  thunder:    { de: 'Gewitter',        color: '#7faec9',
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2L3 14h7l-1 8 11-14h-7l0-6z"/></svg>' },
  heavy_rain: { de: 'Starkregen',      color: '#5a8aa8',
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 13a5 5 0 0 0 0-10 7 7 0 0 0-13.5 2.5"/><path d="M7 17l-2 4"/><path d="M11 19l-1 2"/><path d="M14 17l-2 4"/></svg>' },
  snow:       { de: 'Schnee',          color: '#a8c0d4',
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18M5 7l14 10M5 17l14-10"/></svg>' },
  fog:        { de: 'Nebel',           color: '#6d7787',
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h16M3 12h18M5 16h14M7 20h10"/></svg>' },
  // `sunset` (the score-based raw event clip) was removed — sunrise +
  // sunset content lives only in the sun_timelapse_* pipeline below.
  // Old sightings on disk still render via the gallery's fallback
  // ({ de: s.event_type, color: '#94a3b8', icon: '' }) so nothing
  // 404s; they just don't surface in the filter pill row.
  // Tägliche Sonnen-Timelapses — eigener Sub-Typ in der Wetter-Mediathek,
  // unabhängig vom score-gefilterten "sunset"-Wetter-Ereignis-Clip.
  // The "TL" suffix on `de` is required: without it, sun_timelapse_set
  // would collapse onto the same visible pill label as `sunset` (both
  // render to "Untergang") and produce two filter pills with identical
  // visible text but different counts. Tooltip / aria stays the full
  // descriptive form via de_full.
  sun_timelapse_rise: { de: 'sunrise', de_full: 'Sonnenaufgang (Timelapse)', color: '#e89540',
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="15" r="3.5"/><path d="M12 7v-4M5 11l-2-2M19 11l2-2M3 19h18"/><polyline points="9,5 12,2 15,5"/></svg>' },
  sun_timelapse_set:  { de: 'sunset', de_full: 'Sonnenuntergang (Timelapse)', color: '#d4823a',
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="15" r="3.5"/><path d="M12 7v-4M5 11l-2-2M19 11l2-2M3 19h18"/><polyline points="9,1 12,4 15,1"/></svg>' },
  // Wetter-Ereignis-Timelapses — drei Trigger-Subtypen, ein gemeinsamer
  // 60-min-Capture-Mechanismus. Eigener event_type je Trigger, damit
  // Filter-Pills + Card-Badges in der Wetter-Mediathek auseinandergehalten
  // werden können.
  thunder_rising: { de: 'Gewitter zieht auf', color: '#7a8eb5',
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 16a5 5 0 0 0 0-10 7 7 0 0 0-13.5 2.5A4 4 0 0 0 5 16h12z"/><polyline points="11,11 9,15 12,15 10,19"/></svg>' },
  front_passing:  { de: 'Front zieht durch', color: '#9aa5b3',
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7c3-2 6 2 9 0s6-2 9 0M3 12c3-2 6 2 9 0s6-2 9 0M3 17c3-2 6 2 9 0s6-2 9 0"/></svg>' },
  storm_front:    { de: 'Sturmfront', color: '#b08070',
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 13a5 5 0 0 0 0-10 7 7 0 0 0-13.5 2.5"/><line x1="2" y1="16" x2="20" y2="16"/><line x1="5" y1="20" x2="22" y2="20"/></svg>' },
};

// Bridged on window because legacy.js still has 30+ inline references
// to `WEATHER_TYPES` and the Phase-3 monkey-patches at the bottom of
// legacy.js read the same name. Kept until the rest of the weather
// domain extracts.
window.WEATHER_TYPES = WEATHER_TYPES;
