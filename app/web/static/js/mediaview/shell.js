// ─── mediaview/shell.js ────────────────────────────────────────────────────
// Config-driven composition of the MediaView chrome — now a COMPLETE
// player. mountMediaView builds the shell host node and assembles the
// shared pieces in the unified layout (top → bottom): title bar; video
// stage (media frame + overlay layers, tiling grid, overlay-toggle pills
// top-left, Stream+mode cluster top-right); inline status-legend band;
// playbar + per-class swimlane; colour-coded panel tabs + fine-analysis
// fold — entirely from the openMediaView config (mode + overlays{} +
// panels{}). Weather already rides this shell; recorded (E) + live (F)
// route through it next, so D makes every region present + composable
// with placeholder data.
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
import { lbRenderTrackTimeline, lbClearTrackTimeline } from '../mediathek/bbox-overlay/index.js';
import { renderLiveSwimlane } from './live-swimlane.js';

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

// Unified player layout, top → bottom (matches the live sim-player):
//   titlebar
//   stage    — frame + media + overlay layers, tiling grid, overlay-
//              toggle pills pinned top-left, Stream+mode cluster (with a
//              reserved Stream-selector slot) pinned top-right.
//   legendband — inline status legend + class legend + re-trigger pill,
//                directly below the stage (collapses via :empty).
//   playbar  — recorded/timelapse scrubber + per-class swimlane, or the
//              live swimlane (collapses via :empty for weather).
//   panels   — colour-coded tabs + fine-analysis fold.
const _SHELL_HTML =
  `<div class="mv-shell-titlebar" data-slot="titlebar"></div>` +
  `<div class="mv-shell-stage" data-slot="stage">` +
  `<div class="mv-shell-frame" data-slot="frame"></div>` +
  `<svg class="mv-shell-grid" data-slot="grid" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" hidden></svg>` +
  `<div class="mv-shell-toggles" data-slot="toggles"></div>` +
  `<div class="mv-shell-topright" data-slot="topright">` +
  `<div class="mv-shell-streamslot" data-slot="stream"></div>` +
  `<div class="mv-shell-modeind" data-slot="modeind"></div></div></div>` +
  `<div class="mv-shell-legendband" data-slot="legendband"></div>` +
  `<div class="mv-shell-playbar" data-slot="playbar"></div>` +
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
        // Interactive (live): selecting a tiling draws the matching split
        // over the frame; "Aus" clears it — so the operator sees how the
        // frame is subdivided for scanning. Read-only badges fire
        // onToggleGrid instead, so this branch only runs for live.
        if (flags.interactiveMode) {
          setGridVisible(id !== 'off', id);
        } else if (gridVisible()) {
          renderTilingGrid(gridSvg, id);
        }
        if (typeof actions.onModeChange === 'function') actions.onModeChange(id);
      },
      onToggleGrid: (show, id) => setGridVisible(show, id),
    });
    if (mi) {
      components.modeIndicator = mi;
      teardowns.push(mi.teardown);
    }
  }

  // Overlay-toggle pills pinned top-left INSIDE the stage. The available
  // layers are the keys present in config.overlays (weather passes none,
  // so the pinned slot stays empty + collapses).
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

  // Inline status-legend band directly below the stage (float:false —
  // no longer a floating frame overlay). The class-colour legend and the
  // "Neu erkennen" pill share the same band (retrigger pinned right via
  // 30g); the band collapses via :empty when a mode mounts none of them.
  const legendBand = slot('legendband');
  if (overlays.bboxes) {
    const sl = renderStatusLegend(legendBand, { float: false, osdBand });
    if (sl) {
      components.statusLegend = sl;
      teardowns.push(sl.teardown);
    }
    const cl = renderClassLegend(legendBand, { classes: config.classes });
    if (cl) {
      components.classLegend = cl;
      teardowns.push(cl.teardown);
    }
  }
  if (flags.retrigger || typeof actions.onRetrigger === 'function') {
    const rt = renderRetriggerButton(legendBand, { onClick: actions.onRetrigger });
    if (rt) {
      components.retrigger = rt;
      teardowns.push(rt.teardown);
    }
  }

  // Playbar + per-class swimlane, between the legend band and the panel
  // tabs. recorded/timelapse reuse the recorded scrubber + swimlane
  // (timeline-panel, host-parameterised onto the shell slot); live modes
  // reuse the live swimlane. Weather has no timeline → slot collapses.
  // Placeholder/empty data is fine this batch (no consumer feeds real
  // tracks through the shell yet — E/F wire the data path).
  const playbar = slot('playbar');
  if (playbar) {
    if (mode === 'recorded' || mode === 'timelapse') {
      lbRenderTrackTimeline(config.item || null, { host: playbar });
      teardowns.push(() => {
        try {
          lbClearTrackTimeline(playbar);
        } catch {
          /* ignore */
        }
      });
    } else if (flags.interactiveMode) {
      renderLiveSwimlane(playbar, { detBuffer: [], windowMs: 60_000, objectFilter: null });
      teardowns.push(() => {
        playbar.innerHTML = '';
      });
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
