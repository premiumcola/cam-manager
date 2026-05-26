// ─── weather/stats-summary.js ──────────────────────────────────────────────
// R11 — extracted from stats.js. Numeric summary chips below the chart
// (per-field current value, click-to-isolate) and the explainer card
// that appears when one field is isolated. Reads the latest history
// snapshot from _wsStatsState owned by stats.js.
import { byId } from '../core/dom.js';
import {
  WEATHER_STATS_PALETTE,
  _WS_FIELD_ORDER,
  _wsStatsState,
  _wsFmtVal,
  renderWeatherStats,
} from './stats.js';

function _wsCurrentValue(key) {
  // Walk back to the most recent non-null sample for this field. A single
  // failed poll (sun-altitude calc miss, API hiccup) shouldn't blank the
  // chip and strip its unit — the chip is meant to read as "this field's
  // latest known value", not "the last sample's value".
  const samples = _wsStatsState.data?.samples || [];
  for (let i = samples.length - 1; i >= 0; i--) {
    const v = (samples[i].values || {})[key];
    if (typeof v === 'number' && isFinite(v)) return v;
  }
  return null;
}

// Field-detail copy shown beneath the chart when a legend chip is isolated.
// Three short German blocks per field: relevance for animal observation
// (Squirreling · Sightings's domain), weather correlation, seasonal pattern. Source of truth
// for the explainer card.
const WEATHER_STATS_EXPLAINERS = {
  precipitation: {
    summary:
      'Niederschlag misst Regen, Schnee und Graupel als Wassersäule pro Stunde — die Standard-Einheit ist mm/h.',
    relevance_for_animals:
      'Aktivitäts-Indikator: viele Vögel und Eichhörnchen reduzieren die Aktivität bei >2 mm/h, andere (Drosseln, Regenwürmer-Sucher) werden gerade dann sichtbar.',
    weather_correlation: 'Korreliert positiv mit Bewölkung und Blitz-Potential, negativ mit Sicht.',
    seasonal_pattern:
      'In Mitteleuropa Maximum Juni–August (konvektive Schauer) und ein Nebenmaximum im Herbst.',
  },
  snowfall: {
    summary:
      'Schneefall in cm Neuschnee pro Stunde. 1 cm/h entspricht je nach Dichte etwa 0,7–1,2 mm/h Wasseräquivalent.',
    relevance_for_animals:
      'Frische Schneedecke macht Spuren und Wärmesignaturen besser erkennbar; viele Wildtiere reduzieren Aktivität auf wenige Spitzen am Tag.',
    weather_correlation:
      'Tritt nur bei Lufttemperaturen ≤ 1 °C zusammen mit aktivem Niederschlag auf.',
    seasonal_pattern:
      'In Mitteleuropa typisch von November bis März; vereinzelte Reste in Mittelgebirgen bis April.',
  },
  lightning_potential: {
    summary:
      'Konvektives Energiepotential (CAPE) in J/kg. Werte > 1000 J/kg gelten als Gewitter-Schwelle, > 2000 J/kg als markant unwetterträchtig.',
    relevance_for_animals:
      'Hohes Blitz-Potential verschiebt Tier-Aktivität in geschützte Bereiche; nach dem Durchzug oft eine kurze, hohe Aktivitätsspitze.',
    weather_correlation:
      'Korreliert positiv mit feucht-warmen Luftmassen, starkem vertikalem Temperaturgradient und herannahenden Frontensystemen.',
    seasonal_pattern:
      'Schwerpunkt Mai–August; gelegentliches Herbstmaximum bei warmen Mittelmeer-Tiefs.',
  },
  visibility: {
    summary:
      'Atmosphärische Sichtweite in Metern — die Distanz, in der ein Objekt vor dem Himmel noch erkennbar ist. Werte unter 1000 m gelten als Nebel.',
    relevance_for_animals:
      'Kameras verlieren Tier-Detail unter ~200 m, IR-Erkennung fällt zuerst aus. Manche Arten (Rehe, Füchse) nutzen reduzierte Sicht zur Annäherung an Häuser.',
    weather_correlation:
      'Sinkt mit hoher Luftfeuchte, Niederschlag und Inversionswetterlagen; steigt nach Frontdurchgängen mit kalter, trockener Luft.',
    seasonal_pattern:
      'Jahresminimum im Spätherbst und Winter (Strahlungs- und Hochnebel); Maximum im klaren Frühling nach kühlen Polarluft-Vorstößen.',
  },
  wind_gusts_10m: {
    summary:
      'Maximalwind-Böen in 10 m Höhe in km/h, gemittelt über das letzte 10-min-Intervall. Beaufort 6 ≈ 39 km/h, Sturm Beaufort 9 ≈ 75 km/h.',
    relevance_for_animals:
      'Vögel und kletternde Säuger reduzieren Aktivität ab ~30 km/h Böen; Greifvögel nutzen den Aufwind. Mikrofone werden ab ~25 km/h unbrauchbar.',
    weather_correlation:
      'Korreliert mit Druckgradient, Frontaldurchgang und nachmittäglicher thermischer Konvektion.',
    seasonal_pattern:
      'Winter- und Frühjahrsmaximum bei kräftigen Westwetterlagen; Sommer-Spitzen bei Gewitterböen.',
  },
  cloud_cover: {
    summary:
      'Bewölkungsgrad in Prozent — 0 % wolkenlos, 100 % bedeckt. Open-Meteo summiert tiefe, mittlere und hohe Wolken.',
    relevance_for_animals:
      'Diffuses Licht bei 60–90 % Bewölkung verlängert die Dämmerungsphase und erhöht Tier-Aktivität auf Lichtungen.',
    weather_correlation:
      'Vorlaufindikator für Niederschlag; hohe Bewölkung dämpft den Tagesgang der Temperatur um mehrere Grad.',
    seasonal_pattern:
      'Mittlere Bedeckung in Mitteleuropa ~60 %, mit November-Maximum (Dauergrau) und Aprilspitzen bei Aprilwetter.',
  },
  sun_altitude: {
    summary:
      'Sonnenhöhe ist der Winkel der Sonne über dem Horizont, gemessen in Grad. 0° = Horizont, 90° = direkt im Zenit, negative Werte = unter dem Horizont (Nacht).',
    relevance_for_animals:
      'Tagaktive Tiere folgen dem Sonnenstand: morgendliche und abendliche Aktivitätsspitzen liegen typisch zwischen 5° und 20° Höhe (sog. blue/golden hour für Beobachtung).',
    weather_correlation:
      'Direkter Treiber von Tagestemperatur, Schattenwurf und IR-Beleuchtungsbedarf der Kameras. Keine Wetter-Schwelle — eine astronomische Größe.',
    seasonal_pattern:
      'Maximum bei Sommersonnenwende (~63° in Nürnberg), Minimum bei Wintersonnenwende (~16°). Über das Jahr eine glatte Sinuskurve.',
  },
};

function _wsRenderExplainer(key) {
  const e = WEATHER_STATS_EXPLAINERS[key];
  if (!e) return '';
  const colour = WEATHER_STATS_PALETTE[key] || '#94a3b8';
  const label = (_wsStatsState.data?.labels_de || {})[key] || key;
  return `<div class="ws-explainer-card" style="--cb:${colour}">
    <div class="ws-explainer-head">
      <span class="ws-explainer-dot" style="background:${colour}"></span>
      <h4>${label}</h4>
    </div>
    <p class="ws-explainer-summary">${e.summary}</p>
    <dl class="ws-explainer-list">
      <dt>Für Tierbeobachtung</dt><dd>${e.relevance_for_animals}</dd>
      <dt>Wetterzusammenhang</dt><dd>${e.weather_correlation}</dd>
      <dt>Jahresverlauf</dt><dd>${e.seasonal_pattern}</dd>
    </dl>
  </div>`;
}

export function renderWeatherStatsExplainer() {
  const el = byId('weatherStatsExplainer');
  if (!el) return;
  const k = _wsStatsState.isolated;
  if (!k) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.innerHTML = _wsRenderExplainer(k);
}

export function renderWeatherStatsLegend() {
  const wrap = byId('weatherStatsLegend');
  if (!wrap) return;
  const data = _wsStatsState.data;
  if (!data) {
    wrap.innerHTML = '';
    return;
  }
  const isolated = _wsStatsState.isolated;
  const labels = data.labels_de || {};
  const html = _WS_FIELD_ORDER
    .map((key) => {
      const colour = WEATHER_STATS_PALETTE[key] || '#94a3b8';
      const label = labels[key] || key;
      const val = _wsFmtVal(key, _wsCurrentValue(key));
      // When one series is isolated, the others render with .is-disabled
      // (opacity .35) so the active chip stands out without needing a
      // background pill to mark it. With no isolation, all chips render
      // at full opacity.
      let cls = 'ws-stats-chip';
      if (isolated) {
        cls += isolated === key ? ' is-isolated' : ' is-disabled';
      }
      return `<button type="button" class="${cls}" data-field="${key}" aria-pressed="${isolated === key ? 'true' : 'false'}">
      <span class="ws-stats-chip-dot" style="--cb:${colour};background:${colour}"></span>
      <span class="ws-stats-chip-meta">
        <span class="ws-stats-chip-label">${label}</span>
        <span class="ws-stats-chip-value">${val}</span>
      </span>
    </button>`;
    })
    .join('');
  wrap.innerHTML = html;
  // Wire chip clicks once per render (innerHTML wipes prior listeners).
  wrap.querySelectorAll('.ws-stats-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.field;
      _wsStatsState.isolated = _wsStatsState.isolated === key ? null : key;
      renderWeatherStats();
    });
  });
}
