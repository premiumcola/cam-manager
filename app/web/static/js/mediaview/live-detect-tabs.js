// ─── mediaview/live-detect-tabs.js ─────────────────────────────────────────
// Tab-render bridges for the live-detect Detail zone: repaint the Debug tab on
// demand, the onTabChange hook (Debug/Trace lazy render + snapshot prefetch),
// and the SAHI diag-fold that feeds the Trace fold header. State via S.
import { esc } from '../core/dom.js';
import { S } from './live-detect-state.js';
import { getActiveTab, panelEl, onTabChange } from './live-detect-skeleton.js';
import { renderDebugPanel, startSnapshotPrefetch, stopSnapshotPrefetch } from './live-detect-debug/index.js';
import { _renderTraceTab } from './live-detect-panels.js';

export function _renderDebugTab(data) {
  S.lastFullDataForDebug = data;
  if (typeof getActiveTab === 'function' && getActiveTab() !== 'debug') return;
  const host = panelEl('debug');
  if (!host) return;
  renderDebugPanel(host, {
    tickState: S.tickState,
    session: S.session,
    holdMs: S.holdMsActive,
    cycleEmaMs: S.cycleEmaMs,
    fullData: data,
  });
}

// Bridge a tab change INTO the debug tab to an immediate render so
// the panel isn't blank on first show, AND start the snapshot
// pre-fetch loop (SIMU-FIX-05c). Pre-fetch stops when the user
// switches AWAY from Debug or when closeLiveDetect runs.
if (typeof onTabChange === 'function') {
  onTabChange((id) => {
    if (id === 'debug') {
      if (S.lastFullDataForDebug) _renderDebugTab(S.lastFullDataForDebug);
      if (S.session) startSnapshotPrefetch({ session: S.session });
    } else {
      stopSnapshotPrefetch();
    }
    // Q2-3 · repaint the Trace tab on switch-in so it shows the
    // buffered ticks immediately rather than waiting for the next tick.
    if (id === 'trace') _renderTraceTab();
  });
}

// C3 · in-modal diagnostic panel. Reads the structured ``diag`` block
// the test-detection endpoint now returns (see coral.py — diag.gates,
// diag.top_raw, diag.thresholds, …) and renders a compact key/value
// list inside the collapsible <details> mounted in _mountPanels. The
// summary line carries a one-glance pulse "raw=N · pass=N" so the
// operator can tell from the collapsed state whether Coral is firing
// at all without having to expand. Empty top_raw is rendered as a
// muted "Coral lieferte keine Detektion" so the absence is a positive
// signal, not a blank panel.
export function _renderDiagPanel(diag) {
  // D78 · the Diagnose accordion is gone — content now lives inside
  // the merged "Trace" fold. We push the structured HTML through
  // S.session.fold.setHeader() and update the summary suffix on
  // S.session.fold.setSummaryExtra() so the collapsed line carries
  // "raw=N · pass=N · <verdict>".
  const fold = S.session?.fold;
  if (!fold) return;
  if (!diag) {
    fold.setHeader?.('');
    fold.setSummaryExtra?.('');
    return;
  }
  const fs = diag.frame_size || { w: 0, h: 0 };
  const gates = diag.gates || {};
  const tops = Array.isArray(diag.top_raw) ? diag.top_raw : [];
  const thresholds = diag.thresholds || {};
  const perClass = thresholds.per_class || {};
  const perClassStr = Object.keys(perClass).length
    ? Object.entries(perClass)
        .map(([k, v]) => `${esc(k)}=${Number(v).toFixed(2)}`)
        .join(' · ')
    : '(keine Overrides)';
  const inferStr = Number(diag.inference_ms) > 0 ? ` · ${Math.round(diag.inference_ms)} ms` : '';
  const coralStr = diag.coral_available ? `verfügbar${inferStr}` : 'nicht verfügbar';
  const topRows = tops.length
    ? tops
        .map((t) => {
          const pct = Math.round((Number(t.score) || 0) * 100);
          return `<span class="mv-ld-diag-top-item">${esc(String(t.label))} ${pct}%</span>`;
        })
        .join('')
    : `<span class="mv-ld-diag-top-empty">Coral lieferte keine Detektion für diesen Frame</span>`;
  const objFilter = Array.isArray(diag.object_filter) ? diag.object_filter : [];
  const objFilterStr = objFilter.length
    ? objFilter.map((c) => esc(String(c))).join(' · ')
    : '(alle Klassen)';
  const profStr = diag.validator_profile ? esc(String(diag.validator_profile)) : '—';
  // SIMU-04c · PIPELINE-DURCHLAUF section. Two-column key/value grid
  // in matrix-mono palette: keys 10 px #82c79a, values 9 px #b6d4be.
  // GATES is special — three inline badges (raw/pass/u.S.) so the
  // primary signal reads at a glance. SCHWELLEN is split into a
  // global row + a per-class sub-row when per-class overrides exist.
  const sourceStr = `${esc(diag.frame_src || '?')} · ${fs.w}×${fs.h} · age ${Math.round(Number(diag.frame_age_ms) || 0)} ms`;
  const globalThresh = Number(thresholds.global || 0).toFixed(2);
  const headerHtml = `
    <div class="mv-ld-pipeline">
      <div class="mv-ld-pipeline-head">PIPELINE-DURCHLAUF (LIVE)</div>
      <div class="mv-ld-pipeline-grid">
        <div class="mv-ld-pipeline-k">QUELLE</div>
        <div class="mv-ld-pipeline-v">${sourceStr}</div>
        <div class="mv-ld-pipeline-k">CORAL</div>
        <div class="mv-ld-pipeline-v">${esc(coralStr)}</div>
        <div class="mv-ld-pipeline-k">GATES</div>
        <div class="mv-ld-pipeline-v mv-ld-pipeline-gates">
          <span class="mv-ld-gate mv-ld-gate-raw">raw=${Number(gates.raw || 0)}</span>
          <span class="mv-ld-gate mv-ld-gate-pass">pass=${Number(gates.pass || 0)}</span>
          <span class="mv-ld-gate mv-ld-gate-below">u.S.=${Number(gates.belowthresh || 0)}</span>
        </div>
        <div class="mv-ld-pipeline-k">PROFIL</div>
        <div class="mv-ld-pipeline-v">${profStr}</div>
        <div class="mv-ld-pipeline-k">FILTER</div>
        <div class="mv-ld-pipeline-v">${objFilterStr}</div>
        <div class="mv-ld-pipeline-k">SCHWELLEN</div>
        <div class="mv-ld-pipeline-v">global ${globalThresh}${Object.keys(perClass).length ? `<div class="mv-ld-pipeline-sub">${perClassStr}</div>` : ''}</div>
      </div>
    </div>
    <div class="mv-ld-diag-body mv-ld-diag-legacy" hidden>
      <div class="mv-ld-diag-row mv-ld-diag-top">
        <span class="mv-ld-diag-key">Top 3 raw</span>
        <div class="mv-ld-diag-top-list">${topRows}</div>
      </div>
      <div class="mv-ld-diag-row">
        <span class="mv-ld-diag-key">Profil</span>
        <span class="mv-ld-diag-val">${profStr}</span>
      </div>
      <div class="mv-ld-diag-row">
        <span class="mv-ld-diag-key">Schwellen</span>
        <span class="mv-ld-diag-val">global=${Number(thresholds.global || 0).toFixed(2)} · ${perClassStr}</span>
      </div>
    </div>`;
  fold.setHeader?.(headerHtml);
  // Compact verdict for the collapsed summary. Mirrors the existing
  // Diagnose-pulse semantics: alarm = at least one pass, below = no
  // pass but at least one belowthresh, filtered = only filtered,
  // — = nothing at all.
  const raw = Number(gates.raw || 0);
  const pass = Number(gates.pass || 0);
  const below = Number(gates.belowthresh || 0);
  const filtered = Number(gates.filtered || 0);
  let verdict;
  if (pass > 0) verdict = 'alarm';
  else if (below > 0) verdict = 'below';
  else if (filtered > 0) verdict = 'filtered';
  else verdict = '—';
  fold.setSummaryExtra?.(`raw=${raw} · pass=${pass} · ${verdict}`);
}

// A1 · in-modal debug strip — opt-in via the "Debug" pill in the
// toggle row, persisted in localStorage so it stays sticky across
// sessions. When OFF the strip is fully removed from the DOM
// (no hidden offscreen renders, no extra rAF work). When ON, every
// _renderBboxOverlay/_renderTrailsOverlay/_renderZoneMaskOverlay
// call piggybacks on the existing render path and writes its
// state into the strip — no new timers. Rich fields per row so
// the operator can screenshot the strip on iPhone and read the
// failure mode without DevTools (see A1 spec).
//
// Rows: bbox / trails / zonemask / media (always-on geometry dump)
// + position-fail (sticky when an SVG ends up 0×0)
// + paint-fail   (sticky when SVG sized but first child collapsed).

