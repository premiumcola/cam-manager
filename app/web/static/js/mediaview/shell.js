// ─── mediaview/shell.js ────────────────────────────────────────────────────
// Config-driven composition of the MediaView chrome. mountMediaView
// builds the shell host node and assembles the shared pieces — title
// bar, mode indicator + tiling-grid layer, status legend, overlay
// toggles, class-colour legend, re-trigger button, colour-coded panel
// tabs, fine-analysis fold — entirely from the openMediaView config
// (mode + overlays{} + panels{}). The actual viewer bodies (recorded /
// weather / live) are migrated onto this shell in tasks G/H/I; F builds
// and verifies the chrome shell itself with no real data wired.
//
// Each mode flips a small flag set (_MODE_FLAGS) the composition reads;
// every piece is guarded so any mode × overlay × panel flag combination
// composes without error and returns a single teardown handle.

import { byId } from '../core/dom.js';
import { renderTitleBar } from './title-bar.js';
import { renderModeIndicator, renderTilingGrid } from './mode-indicator.js';
import { renderStatusLegend } from './status-legend.js';
import { renderClassLegend } from './class-legend.js';
import { renderOverlayToggles } from './overlay-toggles.js';
import { renderRetriggerButton } from './retrigger-button.js';
import { renderPanelTabs } from './panel-tabs.js';
import { renderFineAnalysisFold } from './fine-analysis-fold.js';

// Per-mode shell behaviour. interactiveMode → live segmented control vs
// read-only badge; osdBand → where the camera OSD timestamp sits so the
// floating legend dodges it; contextKey → overlay-toggle persistence
// scope; retrigger / fineFold → whether those pieces mount by default.
const _MODE_FLAGS = {
  recorded: {
    interactiveMode: false,
    osdBand: 'top',
    contextKey: 'mediathek',
    retrigger: true,
    fineFold: true,
  },
  timelapse: {
    interactiveMode: false,
    osdBand: 'top',
    contextKey: 'timelapse',
    retrigger: false,
    fineFold: false,
  },
  weather: {
    interactiveMode: false,
    osdBand: 'top',
    contextKey: 'weather',
    retrigger: false,
    fineFold: true,
  },
  live: {
    interactiveMode: true,
    osdBand: 'top',
    contextKey: 'live',
    retrigger: true,
    fineFold: true,
  },
  'live-detect': {
    interactiveMode: true,
    osdBand: 'top',
    contextKey: 'live',
    retrigger: true,
    fineFold: true,
  },
};

// Panel-flag key → tab descriptor. F mounts placeholder bodies; G/H/I
// swap in the real panel renderers (weather.js / recording-settings.js
// / detections.js) without changing the tab wiring here.
const _TAB_META = {
  detections: { id: 'detections', label: 'Detections' },
  tracksList: { id: 'tracks', label: 'Tracks' },
  settings: { id: 'settings', label: 'Aufnahme-Settings' },
  recordingSettings: { id: 'erkennung', label: 'Erkennung' },
  weather: { id: 'weather', label: 'Wetter' },
};

function _buildTabs(panels, panelRenderers, item) {
  const out = [];
  for (const key of Object.keys(_TAB_META)) {
    if (!panels[key]) continue;
    const meta = _TAB_META[key];
    // A real renderer wired by the consumer (G: weather; H/I: recorded
    // / live panels) takes over; otherwise a placeholder marks the tab
    // as not-yet-migrated so the strip still composes.
    const custom = panelRenderers && typeof panelRenderers[key] === 'function';
    out.push({
      id: meta.id,
      label: meta.label,
      render: custom
        ? (host) => panelRenderers[key](host, item)
        : (host) => {
            host.innerHTML = `<div class="mv-tab-placeholder">${meta.label} · wird migriert</div>`;
          },
    });
  }
  return out;
}

const _SHELL_HTML =
  `<div class="mv-shell-titlebar" data-slot="titlebar"></div>` +
  `<div class="mv-shell-stage" data-slot="stage">` +
  `<div class="mv-shell-frame" data-slot="frame"></div>` +
  `<svg class="mv-shell-grid" data-slot="grid" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" hidden></svg>` +
  `<div class="mv-shell-modeind" data-slot="modeind"></div>` +
  `<div class="mv-shell-legend" data-slot="legend"></div></div>` +
  `<div class="mv-shell-chrome" data-slot="chrome">` +
  `<div class="mv-shell-toggles" data-slot="toggles"></div>` +
  `<div class="mv-shell-classlegend" data-slot="classlegend"></div>` +
  `<div class="mv-shell-actions" data-slot="actions"></div></div>` +
  `<div class="mv-shell-panels" data-slot="panels">` +
  `<div class="mv-shell-tabs" data-slot="tabs"></div>` +
  `<div class="mv-shell-fafold" data-slot="fafold"></div></div>`;

/**
 * Build the MediaView shell from a config and (optionally) mount it.
 *
 * @param {Object} config  openMediaView config — { mode, overlays{},
 *   panels{}, item, actions{}, appliedTiling?, detMode?, classes?,
 *   osdBand?, mount? }.
 * @returns {{ root: HTMLElement, components: Object, teardown(): void }}
 */
export function mountMediaView(config = {}) {
  const mode = config.mode || 'recorded';
  const flags = _MODE_FLAGS[mode] || _MODE_FLAGS.recorded;
  const overlays = config.overlays || {};
  const panels = config.panels || {};
  const actions = config.actions || {};
  const osdBand = config.osdBand || flags.osdBand;
  const teardowns = [];
  const components = {};

  const root = document.createElement('div');
  root.className = 'mv-shell';
  root.dataset.mode = mode;
  root.innerHTML = _SHELL_HTML;
  const slot = (name) => root.querySelector(`[data-slot="${name}"]`);

  const tb = renderTitleBar(slot('titlebar'), config);
  if (tb) {
    components.titleBar = tb;
    teardowns.push(tb.teardown);
  }

  const gridSvg = slot('grid');
  // ``hidden`` is an HTMLElement IDL property — it does NOT reflect to
  // the attribute on an SVGElement, so toggle the attribute directly.
  const gridVisible = () => gridSvg && !gridSvg.hasAttribute('hidden');
  const setGridVisible = (show, id) => {
    if (!gridSvg) return;
    if (show) {
      renderTilingGrid(gridSvg, id);
      gridSvg.removeAttribute('hidden');
    } else {
      gridSvg.setAttribute('hidden', '');
    }
  };

  // Mode indicator — interactive for live; read-only "angewandt: X"
  // badge for recorded/weather when an applied tiling is known.
  if (flags.interactiveMode || config.appliedTiling) {
    const mi = renderModeIndicator(slot('modeind'), {
      interactive: flags.interactiveMode,
      value: config.detMode || config.appliedTiling || 'off',
      onChange: (id) => {
        if (gridVisible()) renderTilingGrid(gridSvg, id);
        if (typeof actions.onModeChange === 'function') actions.onModeChange(id);
      },
      onToggleGrid: (show, id) => setGridVisible(show, id),
    });
    if (mi) {
      components.modeIndicator = mi;
      teardowns.push(mi.teardown);
    }
  }

  // Status legend floats over the frame only when detections are
  // meaningful (the bbox layer is available in this mode).
  if (overlays.bboxes) {
    const sl = renderStatusLegend(slot('legend'), { float: true, osdBand });
    if (sl) {
      components.statusLegend = sl;
      teardowns.push(sl.teardown);
    }
  }

  // Overlay toggles — the available layers are the keys present in
  // config.overlays (weather passes only zones/masks, etc.).
  const available = Object.keys(overlays);
  if (available.length) {
    const ot = renderOverlayToggles(slot('toggles'), {
      available,
      contextKey: flags.contextKey,
      onChange: actions.onOverlayChange,
    });
    if (ot) {
      components.overlayToggles = ot;
      teardowns.push(ot.teardown);
    }
  }

  // Class-colour legend pairs with the bbox layer.
  if (overlays.bboxes) {
    const cl = renderClassLegend(slot('classlegend'), { classes: config.classes });
    if (cl) {
      components.classLegend = cl;
      teardowns.push(cl.teardown);
    }
  }

  if (flags.retrigger || typeof actions.onRetrigger === 'function') {
    const rt = renderRetriggerButton(slot('actions'), { onClick: actions.onRetrigger });
    if (rt) {
      components.retrigger = rt;
      teardowns.push(rt.teardown);
    }
  }

  const tabs = _buildTabs(panels, config.panelRenderers, config.item);
  if (tabs.length) {
    const pt = renderPanelTabs(slot('tabs'), tabs, {
      mode,
      initialId: config.initialTab || tabs[0].id,
    });
    if (pt) components.panelTabs = pt;
  }

  // config.showFineFold overrides the mode default — recaps pass false
  // (a compilation has no per-event trace), sightings keep the fold.
  const wantFold =
    config.showFineFold !== undefined
      ? !!config.showFineFold
      : flags.fineFold || !!panels.fineAnalysis;
  if (wantFold) {
    // renderFineAnalysisFold(host, lines, opts) — live modes pass the
    // ``live`` flag so the fold reads "Warte auf ersten Tick …" and
    // gets the live accent; recorded/weather start with no lines.
    const ff = renderFineAnalysisFold(slot('fafold'), [], { live: flags.interactiveMode });
    if (ff) components.fineFold = ff;
  }

  if (config.mount) {
    const host = typeof config.mount === 'string' ? byId(config.mount) : config.mount;
    if (host) host.appendChild(root);
  }

  return {
    root,
    components,
    teardown: () => {
      for (const fn of teardowns) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
      root.remove();
    },
  };
}
