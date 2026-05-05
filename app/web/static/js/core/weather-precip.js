// ─── core/weather-precip.js ────────────────────────────────────────────
// Mirror of app/app/weather_service/_precip_label.py — DWD-style
// intensity bands for precipitation rate. Used by the weather sighting
// gallery + lightbox so the badge label reflects the *actual* current
// rate instead of the static event-type name "Starkregen", which only
// describes the trigger threshold.
//
// Keep these branches in sync with the Python helper. Backend sends the
// raw mm/h value in api_snapshot; the frontend bands it for display.

export function precipitationLabel(mmPerHour){
  if (mmPerHour === null || mmPerHour === undefined) return 'Trocken';
  const v = Number(mmPerHour);
  if (!Number.isFinite(v) || v <= 0) return 'Trocken';
  if (v <= 0.5)  return 'Nieselregen';
  if (v <= 2.5)  return 'Leichter Regen';
  if (v <= 7.5)  return 'Mäßiger Regen';
  if (v <= 15.0) return 'Starker Regen';
  return 'Starkregen';
}
