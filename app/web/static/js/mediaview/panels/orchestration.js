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
import { renderWeatherPanel } from './weather.js';

function _renderSettingsTab(host, item) {
  // Reuse the existing settings renderer with a custom host. After
  // it renders, auto-expand the body so the user doesn't have to
  // click twice (once for the tab, once for the panel collapse).
  lbRenderSettingsPanel(item, host);
  const body = host.querySelector('.lbset-body');
  const header = host.querySelector('.lbset-header');
  if (body && header && body.hidden) {
    body.hidden = false;
    header.setAttribute('aria-expanded', 'true');
  }
}

// Public entry — called from lightbox.js for BOTH motion clips and
// timelapses. Motion clips get Aufnahme-Settings + optional Wetter;
// timelapses get Wetter when present (no Aufnahme-Settings since
// timelapses don't carry recording_settings — they're not produced
// by the alarm pipeline). The Nach-Erkennung tab was retired —
// its single regenerate action moved into the overlay-toggles row
// (lightbox.js · mountReindexButton) so it's always visible.
export function mountRecordedPanels(item) {
  const host = byId('lightboxSettings');
  if (!host) return;
  if (!item) {
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
  if (!isTimelapse) {
    tabs.push({
      id: 'settings',
      label: 'Aufnahme-Settings',
      render: (h) => _renderSettingsTab(h, item),
    });
  }
  // Weather tab — mounted whenever the item carries a weather
  // snapshot. Two shapes are accepted: item.weather (normalised
  // pairs) and item.api_snapshot (raw Open-Meteo dict, used by
  // weather sightings via openTLPlayer). Motion clips usually
  // carry neither; timelapses + weather sightings do.
  const hasWeather = !!(
    (item.weather && typeof item.weather === 'object') ||
    (item.api_snapshot && typeof item.api_snapshot === 'object')
  );
  if (hasWeather) {
    // Single owner of weather-row rendering (mediaview/panels/weather.js)
    // — the recorded-panel composer and the weather-mode shell both
    // render their Wetter tab through it, no parallel implementation.
    tabs.push({ id: 'weather', label: 'Wetter', render: (h) => renderWeatherPanel(h, item) });
  }
  // Initial tab — Aufnahme-Settings for motion clips; Wetter for
  // timelapses when present. Timelapses with no weather data fall
  // through to the empty tab strip + fold below.
  let initialId;
  if (isTimelapse && hasWeather) initialId = 'weather';
  else if (!isTimelapse) initialId = 'settings';
  if (tabs.length) {
    renderPanelTabs(tabsHost, tabs, { initialId });
  }
  // Recorded clips don't carry a server-side decision trace today —
  // the fold renders the standard "Trace nur im Live-Test verfügbar"
  // empty state. When the trace gets persisted (future change), pass
  // the lines through here.
  renderFineAnalysisFold(faHost, null);
}
