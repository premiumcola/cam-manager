// ─── mediaview/live-detect-debug.js ───────────────────────────────────────
// SIMU-05 · Debug tab content renderer.
//
// The Debug tab is organised by USER PROBLEM, not by data theme:
//   - Live-Status header   (always-on compact metrics row)
//   - Cluster 1 · Track-continuity (sliders + evidence)
//   - Cluster 2 · Recognition (per-class sliders + filter pills)
//   - Cluster 3 · False positives (quick-filter pills + zone link)
//   - Cluster 4 · Performance (read-only with auto-diagnose)
//   - Cluster 5 · Tracker events (read-only log)
//
// renderDebugPanel(host, ctx) takes the tick context the caller
// already has on hand and rebuilds the panel. SIMU-05a · just the
// header is in here for now; clusters land in subsequent commits.

import { esc } from '../core/dom.js';
import { state } from '../core/state.js';

const _STUCK_MS = 5000;

// SIMU-05b · default + recommended tuning values for Cluster 1.
const _CLUSTER1_DEFAULTS = {
  track_iou_match_threshold: 0.2,
  track_miss_grace_seconds: 8.0,
  track_continue_min_score: 0.2,
};
const _CLUSTER1_RECOMMENDED = {
  track_iou_match_threshold: 0.1,
  track_miss_grace_seconds: 15.0,
  track_continue_min_score: 0.1,
};

// Debounced PATCH helper — shared across clusters. Each unique
// (camId, fieldKey) gets its own 600 ms timer so rapid drags on the
// same slider coalesce into one save, but two different sliders
// don't collide.
const _saveTimers = new Map();
const _SAVE_DEBOUNCE_MS = 600;
const _saveStatusEls = new Map();

function _scheduleSave(camId, patchObj, statusEl) {
  const key = `${camId}:${Object.keys(patchObj).sort().join(',')}`;
  if (_saveTimers.has(key)) clearTimeout(_saveTimers.get(key));
  if (statusEl) {
    _saveStatusEls.set(key, statusEl);
    statusEl.dataset.saveState = 'pending';
    statusEl.textContent = 'speichert …';
  }
  const timerId = setTimeout(() => {
    _saveTimers.delete(key);
    _flushSave(camId, patchObj, statusEl, key);
  }, _SAVE_DEBOUNCE_MS);
  _saveTimers.set(key, timerId);
}

function _flushSave(camId, patchObj, statusEl, key) {
  fetch(`/api/cameras/${encodeURIComponent(camId)}/detection-tuning`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patchObj),
  })
    .then((r) => {
      const el = statusEl || _saveStatusEls.get(key);
      if (!el) return r;
      if (r.ok) {
        el.dataset.saveState = 'ok';
        el.textContent = '✓ gespeichert';
        setTimeout(() => {
          if (el.dataset.saveState === 'ok') {
            el.textContent = '';
            el.dataset.saveState = 'idle';
          }
        }, 1000);
      } else {
        el.dataset.saveState = 'error';
        el.textContent = '⚠ Speichern fehlgeschlagen';
      }
      return r;
    })
    .catch(() => {
      const el = statusEl || _saveStatusEls.get(key);
      if (el) {
        el.dataset.saveState = 'error';
        el.textContent = '⚠ Speichern fehlgeschlagen';
      }
    });
}

export function renderDebugPanel(host, ctx = {}) {
  if (!host) return;
  // Idempotent rebuild: when the lane structure is unchanged from
  // last render, skip the full innerHTML refresh and just update the
  // dynamic cells (live-status + evidence boxes). This preserves the
  // in-progress slider drag state across ticks. Detection: the
  // structural fingerprint encodes the cam-id + filter membership.
  const session = ctx.session || {};
  const camId = session.camId || '';
  const cam = (state.cameras || []).find((c) => c.id === camId) || {};
  const filterArr = Array.isArray(cam.object_filter) ? cam.object_filter : [];
  const fp = `${camId}|${filterArr.join(',')}`;
  if (host.dataset.mvLdDebugFp === fp) {
    _refreshDynamic(host, ctx, cam);
    return;
  }
  host.innerHTML =
    '<div class="mv-ld-debug">' +
    _renderLiveStatusHeader(ctx) +
    _renderCluster1(ctx, cam) +
    _renderCluster2(ctx, cam) +
    _renderCluster3(ctx, cam) +
    _renderCluster4(ctx) +
    '</div>';
  host.dataset.mvLdDebugFp = fp;
  _wireCluster1(host, cam, ctx);
  _wireCluster2(host, cam, ctx);
  _wireCluster3(host, cam, ctx);
}

// Refresh the dynamic content (live-status + evidence boxes) without
// destroying the structural skeleton — slider drag state survives a
// tick refresh because the slider DOM persists.
function _refreshDynamic(host, ctx, cam) {
  const headerHost = host.querySelector('.mv-ld-debug-header');
  if (headerHost) {
    headerHost.outerHTML = _renderLiveStatusHeader(ctx);
  }
  const ev1 = host.querySelector('[data-cluster-evidence="1"]');
  if (ev1) ev1.outerHTML = _renderCluster1Evidence(ctx, cam);
  const ev2 = host.querySelector('[data-cluster-evidence="2"]');
  if (ev2) ev2.outerHTML = _renderCluster2Evidence(ctx, cam);
  const c4 = host.querySelector('[data-cluster-id="4"]');
  if (c4) c4.outerHTML = _renderCluster4(ctx);
}

// Per-class default thresholds — keep aligned with the project's
// shipped tuning. Used by Cluster 2's "Defaults" button.
const _CLASS_DEFAULT_THRESH = {
  person: 0.5,
  cat: 0.5,
  bird: 0.5,
  car: 0.5,
  dog: 0.5,
  squirrel: 0.5,
};
const _ALL_FILTER_CANDIDATES = ['person', 'cat', 'bird', 'car', 'dog', 'squirrel', 'motion'];

function _renderLiveStatusHeader(ctx) {
  const t = ctx.tickState || {};
  const session = ctx.session || {};
  const diag = ctx.fullData?.diag || {};
  const cam = (state.cameras || []).find((c) => c.id === session.camId) || {};
  const now = Date.now();
  const sinceTick = t.lastTickAt ? now - t.lastTickAt : Infinity;
  const sinceResp = t.lastRespAt ? now - t.lastRespAt : Infinity;
  const tickStatus = !t.lastTickAt
    ? 'idle'
    : Math.min(sinceTick, sinceResp) > _STUCK_MS
      ? 'stuck'
      : 'ok';
  const tickStuckClass =
    tickStatus === 'stuck' ? ' mv-ld-debug-warn' : '';
  const armed = cam.armed !== false;
  const armedClass = !armed ? ' mv-ld-debug-warn-red' : '';
  const cycleMs = Number.isFinite(t.lastCycleMs) ? Math.round(t.lastCycleMs) : '—';
  const delayMs = Number.isFinite(t.lastDelayMs) ? Math.round(t.lastDelayMs) : '—';
  const inferMs = Number(diag.inference_ms) > 0 ? Math.round(Number(diag.inference_ms)) : '—';
  const frameSrc = session.lastFrameSrc || diag.frame_src || '?';
  const sourceMode =
    frameSrc === 'sub' ? 'sub-fast' : frameSrc === 'main_fallback' ? 'main-slow' : frameSrc;
  const fs = session.lastFrameSize || diag.frame_size || { w: 0, h: 0 };
  const sourceDims = fs.w && fs.h ? `${fs.w}×${fs.h}` : '—';
  const avgCycle = Number.isFinite(ctx.cycleEmaMs) ? Math.round(ctx.cycleEmaMs) : '—';
  const holdMs = Number.isFinite(ctx.holdMs) ? Math.round(ctx.holdMs) : '—';
  const drops = Number(t.ticksDroppedLate || 0);
  const profil = diag.validator_profile || '—';
  return `
    <div class="mv-ld-debug-header" data-mv-ld-live-status="1">
      <div class="mv-ld-debug-mini-head">LIVE-STATUS</div>
      <div class="mv-ld-debug-row">
        <span class="mv-ld-debug-cell${tickStuckClass}">
          <span class="mv-ld-debug-k">TICK</span>
          <span class="mv-ld-debug-v mv-ld-debug-v-bright">${esc(tickStatus)}</span>
          <span class="mv-ld-debug-v">· ${esc(String(cycleMs))} ms · next ${esc(String(delayMs))} ms</span>
        </span>
        <span class="mv-ld-debug-cell">
          <span class="mv-ld-debug-k">QUELLE</span>
          <span class="mv-ld-debug-v mv-ld-debug-v-bright">${esc(sourceMode)}</span>
          <span class="mv-ld-debug-v">· ${esc(sourceDims)}</span>
        </span>
        <span class="mv-ld-debug-cell">
          <span class="mv-ld-debug-k">INFER</span>
          <span class="mv-ld-debug-v mv-ld-debug-v-bright">${esc(String(inferMs))} ms</span>
        </span>
      </div>
      <div class="mv-ld-debug-row">
        <span class="mv-ld-debug-cell">
          <span class="mv-ld-debug-k">CADENCE</span>
          <span class="mv-ld-debug-v">avg ${esc(String(avgCycle))} · hold ${esc(String(holdMs))} · drops ${esc(String(drops))}</span>
        </span>
        <span class="mv-ld-debug-cell">
          <span class="mv-ld-debug-k">PROFIL</span>
          <span class="mv-ld-debug-v">${esc(profil)}</span>
        </span>
        <span class="mv-ld-debug-cell${armedClass}">
          <span class="mv-ld-debug-k">ARMED</span>
          <span class="mv-ld-debug-v mv-ld-debug-v-bright">${armed ? 'true' : 'false'}</span>
        </span>
      </div>
    </div>`;
}

// SIMU-05b · Cluster 1 render. Three sliders (IoU / grace / floor)
// + evidence box + Speichern/Defaults/Empfohlene buttons. The slider
// component lives in this file (no separate module) since clusters
// 1/2 are the only callers; clusters 3+ use pill toggles instead.
function _renderCluster1(ctx, cam) {
  const iou = _readField(cam, 'track_iou_match_threshold', _CLUSTER1_DEFAULTS.track_iou_match_threshold);
  const grace = _readField(cam, 'track_miss_grace_seconds', _CLUSTER1_DEFAULTS.track_miss_grace_seconds);
  const floor = _readField(cam, 'track_continue_min_score', _CLUSTER1_DEFAULTS.track_continue_min_score);
  return `
    <div class="mv-ld-cluster mv-ld-cluster-warn" data-cluster-id="1">
      ${_renderClusterHeader(1, '▼ Cluster 1 · Person/Objekt reißt ab beim Bewegen',
        'Track stirbt obwohl Subjekt noch im Bild ist · neue Person-ID nach Drehung',
        _cluster1HeaderHint(ctx))}
      <div class="mv-ld-cluster-body">
        ${_renderSlider({
          field: 'track_iou_match_threshold',
          label: 'IoU-Match-Schwelle',
          value: iou,
          min: 0.0,
          max: 0.95,
          step: 0.01,
          desc: 'Wie groß muss die Überlappung zur Vorgängerbox sein, damit es derselbe Track bleibt',
          hint: '↓ Senken (0.10) = toleranter bei Drehungen / Sprüngen',
        })}
        ${_renderSlider({
          field: 'track_miss_grace_seconds',
          label: 'Miss-Grace (Sek.)',
          value: grace,
          min: 1.0,
          max: 30.0,
          step: 0.5,
          desc: 'Wie lange ein Track ohne neue Detection überleben darf (z.B. Verdeckung)',
          hint: '↑ Erhöhen (15 s) = überlebt längere Verdeckung / Drehung',
        })}
        ${_renderSlider({
          field: 'track_continue_min_score',
          label: 'Floor-Score (Weiterführung)',
          value: floor,
          min: 0.0,
          max: 0.95,
          step: 0.01,
          desc: 'Minimale Confidence, damit existierender Track weiterläuft (≠ Spawn-Score!)',
          hint: '↓ Senken (0.10) = Track überlebt schwache Frames (Drehung, dunkle Pose)',
        })}
        ${_renderCluster1Evidence(ctx, cam)}
        <div class="mv-ld-cluster-actions">
          <button type="button" class="mv-ld-action-btn mv-ld-action-save" data-action="save-cluster1">Speichern (Cam)</button>
          <button type="button" class="mv-ld-action-btn" data-action="defaults-cluster1">Defaults</button>
          <button type="button" class="mv-ld-action-btn mv-ld-action-recommend" data-action="recommend-cluster1">Empfohlene Werte testen</button>
          <span class="mv-ld-save-status" data-save-status data-save-state="idle"></span>
        </div>
      </div>
    </div>`;
}

function _renderClusterHeader(num, title, sub, hint) {
  return `
    <div class="mv-ld-cluster-head">
      <div class="mv-ld-cluster-head-text">
        <div class="mv-ld-cluster-head-title">${esc(title)}</div>
        <div class="mv-ld-cluster-head-sub">${esc(sub)}</div>
      </div>
      ${hint ? `<div class="mv-ld-cluster-head-hint" data-hint-tone="${hint.tone}">${esc(hint.text)}</div>` : ''}
    </div>`;
}

function _cluster1HeaderHint(ctx) {
  // For SIMU-05b the evidence ring-buffer (SIMU-05h) isn't wired yet;
  // surface a calm placeholder so the cluster reads stable instead
  // of empty. SIMU-05h replaces this with a real count.
  const evidence = ctx.fullData?.cluster_evidence?.cluster1;
  if (!evidence) return { tone: 'mute', text: '· Live-Daten in Vorbereitung' };
  const n = Number(evidence.deaths_60s || 0);
  return n > 0
    ? { tone: 'warn', text: `⚠ Letzte 60 s: ${n} DEATH` }
    : { tone: 'ok', text: '· Letzte 60 s: 0 DEATH' };
}

function _renderCluster1Evidence(ctx, cam) {
  const ev = ctx.fullData?.cluster_evidence?.cluster1;
  const clean = !ev || Number(ev.deaths_60s || 0) === 0;
  if (clean) {
    return `<div class="mv-ld-evidence mv-ld-evidence-ok" data-cluster-evidence="1">
      <div class="mv-ld-evidence-line">📊 Letzte 60 s an dieser Kamera:</div>
      <div class="mv-ld-evidence-mono">Aktuell stabil · keine Track-Abbrüche</div>
    </div>`;
  }
  const deaths = Number(ev.deaths_60s || 0);
  const spawns = Number(ev.spawns_60s || 0);
  const reids = Number(ev.reid_successes_60s || 0);
  const attempts = Array.isArray(ev.reid_attempts_60s) ? ev.reid_attempts_60s : [];
  // Diagnose: pick the worst failing IoU attempt and surface it.
  let diagnose = '';
  if (attempts.length) {
    const worst = attempts.reduce((a, b) => (Number(a.iou) < Number(b.iou) ? a : b));
    const iouCur = Number(cam.track_iou_match_threshold || 0.2).toFixed(2);
    diagnose = `Wahrscheinliche Ursache: IoU ${Number(worst.iou).toFixed(2)} unterschreitet Schwelle ${iouCur} beim Drehen`;
  }
  return `<div class="mv-ld-evidence mv-ld-evidence-warn" data-cluster-evidence="1">
    <div class="mv-ld-evidence-line">📊 Letzte 60 s an dieser Kamera:</div>
    <div class="mv-ld-evidence-mono">${deaths}× DEATH · ${spawns}× SPAWN · ${reids} erfolgreiche RE-ID</div>
    ${diagnose ? `<div class="mv-ld-evidence-diagnose">${esc(diagnose)}</div>` : ''}
  </div>`;
}

function _readField(cam, key, defaultVal) {
  const v = Number(cam[key]);
  return Number.isFinite(v) && v > 0 ? v : defaultVal;
}

function _renderSlider(cfg) {
  const valDisplay = _formatValue(cfg.value, cfg.step);
  const pct = _valToPct(cfg.value, cfg.min, cfg.max);
  return `
    <div class="mv-ld-slider" data-field="${esc(cfg.field)}" data-min="${cfg.min}" data-max="${cfg.max}" data-step="${cfg.step}" data-value="${cfg.value}">
      <div class="mv-ld-slider-top">
        <span class="mv-ld-slider-label">${esc(cfg.label)}</span>
        <span class="mv-ld-slider-value" data-slider-value>${esc(valDisplay)}</span>
      </div>
      <div class="mv-ld-slider-track" data-slider-track>
        <div class="mv-ld-slider-fill" data-slider-fill style="width:${pct.toFixed(2)}%"></div>
        <div class="mv-ld-slider-knob" data-slider-knob style="left:${pct.toFixed(2)}%"></div>
      </div>
      <div class="mv-ld-slider-bounds">
        <span>${esc(_formatValue(cfg.min, cfg.step))}</span>
        <span>${esc(_formatValue(cfg.max, cfg.step))}</span>
      </div>
      <div class="mv-ld-slider-desc">${esc(cfg.desc)}</div>
      <div class="mv-ld-slider-hint">${esc(cfg.hint)}</div>
    </div>`;
}

function _formatValue(v, step) {
  return step >= 0.5 ? `${Number(v).toFixed(1)}` : `${Number(v).toFixed(2)}`;
}

function _valToPct(v, min, max) {
  const range = Math.max(0.0001, max - min);
  return Math.min(100, Math.max(0, ((Number(v) - min) / range) * 100));
}

function _pctToVal(pct, min, max, step) {
  const range = max - min;
  const raw = min + (range * pct) / 100;
  const snapped = Math.round(raw / step) * step;
  return Math.min(max, Math.max(min, snapped));
}

// SIMU-05b · wire up sliders + action buttons inside Cluster 1.
function _wireCluster1(host, cam, ctx) {
  const camId = (ctx.session || {}).camId || cam.id;
  host.querySelectorAll('.mv-ld-slider').forEach((root) => {
    _wireSlider(root, camId);
  });
  host
    .querySelector('[data-action="save-cluster1"]')
    ?.addEventListener('click', () => _forceSave(camId, host));
  host
    .querySelector('[data-action="defaults-cluster1"]')
    ?.addEventListener('click', () => _applyClusterValues(host, camId, _CLUSTER1_DEFAULTS));
  host
    .querySelector('[data-action="recommend-cluster1"]')
    ?.addEventListener('click', () => _applyClusterValues(host, camId, _CLUSTER1_RECOMMENDED));
}

function _wireSlider(root, camId) {
  if (root.dataset.wired === '1') return;
  root.dataset.wired = '1';
  const track = root.querySelector('[data-slider-track]');
  const knob = root.querySelector('[data-slider-knob]');
  const fill = root.querySelector('[data-slider-fill]');
  const valEl = root.querySelector('[data-slider-value]');
  if (!track || !knob || !fill || !valEl) return;
  const min = Number(root.dataset.min);
  const max = Number(root.dataset.max);
  const step = Number(root.dataset.step);
  const field = root.dataset.field;
  let dragging = false;
  const setFromX = (clientX) => {
    const rect = track.getBoundingClientRect();
    const pct = Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100));
    const val = _pctToVal(pct, min, max, step);
    root.dataset.value = String(val);
    knob.style.left = `${pct.toFixed(2)}%`;
    fill.style.width = `${pct.toFixed(2)}%`;
    valEl.textContent = _formatValue(val, step);
    return val;
  };
  const onMove = (ev) => {
    if (!dragging) return;
    const val = setFromX(ev.clientX);
    const statusEl = root.closest('.mv-ld-cluster')?.querySelector('[data-save-status]');
    _scheduleSave(camId, { [field]: val }, statusEl);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
  };
  const onDown = (ev) => {
    dragging = true;
    setFromX(ev.clientX);
    const val = Number(root.dataset.value);
    const statusEl = root.closest('.mv-ld-cluster')?.querySelector('[data-save-status]');
    _scheduleSave(camId, { [field]: val }, statusEl);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    ev.preventDefault();
  };
  knob.addEventListener('pointerdown', onDown);
  track.addEventListener('pointerdown', onDown);
}

function _applyClusterValues(host, camId, values) {
  const patch = {};
  for (const [field, val] of Object.entries(values)) {
    const sliderRoot = host.querySelector(`.mv-ld-slider[data-field="${field}"]`);
    if (sliderRoot) {
      const min = Number(sliderRoot.dataset.min);
      const max = Number(sliderRoot.dataset.max);
      const step = Number(sliderRoot.dataset.step);
      const pct = _valToPct(val, min, max);
      sliderRoot.dataset.value = String(val);
      const knob = sliderRoot.querySelector('[data-slider-knob]');
      const fill = sliderRoot.querySelector('[data-slider-fill]');
      const valEl = sliderRoot.querySelector('[data-slider-value]');
      if (knob) knob.style.left = `${pct.toFixed(2)}%`;
      if (fill) fill.style.width = `${pct.toFixed(2)}%`;
      if (valEl) valEl.textContent = _formatValue(val, step);
    }
    patch[field] = val;
  }
  const statusEl = host.querySelector('[data-save-status]');
  _scheduleSave(camId, patch, statusEl);
}

function _forceSave(camId, host) {
  // Force-flush any pending debounced timers for this camera.
  for (const [key, timerId] of Array.from(_saveTimers.entries())) {
    if (!key.startsWith(`${camId}:`)) continue;
    clearTimeout(timerId);
    _saveTimers.delete(key);
  }
  // Collect current slider values and send them all at once. The
  // backend's PATCH endpoint accepts the merged payload happily.
  const patch = {};
  host.querySelectorAll('.mv-ld-slider').forEach((root) => {
    const field = root.dataset.field;
    const val = Number(root.dataset.value);
    if (field && Number.isFinite(val)) {
      if (field.startsWith('label_thresholds:')) {
        const lbl = field.split(':')[1];
        patch.label_thresholds = patch.label_thresholds || {};
        patch.label_thresholds[lbl] = val;
      } else {
        patch[field] = val;
      }
    }
  });
  if (!Object.keys(patch).length) return;
  const statusEl = host.querySelector('[data-save-status]');
  _flushSave(camId, patch, statusEl, `${camId}:force`);
}

// SIMU-05c · Cluster 2 · Recognition.
function _renderCluster2(ctx, cam) {
  const filterArr = Array.isArray(cam.object_filter) ? cam.object_filter : [];
  const thresholds = cam.label_thresholds || {};
  const globalThresh = Number(cam.detection_min_score) || 0.55;
  const sortedClasses = filterArr
    .slice()
    .sort((a, b) => Object.keys(_CLASS_DEFAULT_THRESH).indexOf(a) - Object.keys(_CLASS_DEFAULT_THRESH).indexOf(b));
  const classSlidersHtml = sortedClasses
    .map((lbl) => {
      const v = Number(thresholds[lbl]);
      const val = Number.isFinite(v) && v > 0 ? v : globalThresh;
      return _renderSlider({
        field: `label_thresholds:${lbl}`,
        label: lbl,
        value: val,
        min: 0.0,
        max: 0.95,
        step: 0.01,
        desc: `Min. Confidence damit "${lbl}" als gültige Detection passt`,
        hint: '↓ Senken = mehr Detections (aber mehr False Positives)',
      });
    })
    .join('');
  const filterPillsHtml = _ALL_FILTER_CANDIDATES.map((lbl) => {
    const on = filterArr.includes(lbl);
    return `<button type="button" class="mv-ld-filter-pill" data-filter-pill="${esc(lbl)}" data-on="${on ? '1' : '0'}">${esc(lbl)}${on ? ' ✓' : ''}</button>`;
  }).join('');
  const profil = ctx.fullData?.diag?.validator_profile || '—';
  return `
    <div class="mv-ld-cluster mv-ld-cluster-warn" data-cluster-id="2">
      ${_renderClusterHeader(2, '▼ Cluster 2 · Objekt wird gar nicht erkannt',
        'Coral findet die Klasse nicht · oder Score landet unter der Schwelle',
        _cluster2HeaderHint(ctx, sortedClasses))}
      <div class="mv-ld-cluster-body">
        ${sortedClasses.length
          ? `<div class="mv-ld-subsection-head">PER-KLASSE SCHWELLEN</div>${classSlidersHtml}`
          : '<div class="mv-ld-empty-row">Kein object_filter aktiv — alle Klassen werden akzeptiert</div>'}
        <div class="mv-ld-subsection-head">PROFIL-OVERRIDE</div>
        <div class="mv-ld-profil-line">
          <span>Profil <span class="mv-ld-profil-val">${esc(profil)}</span> (aktiv)</span>
          <button type="button" class="mv-ld-link-btn" data-action="open-profil-editor">Profil-Editor öffnen</button>
        </div>
        <div class="mv-ld-subsection-desc">Tag/Twilight/Nacht haben separate Schwellen-Sets · aktuell aktiv: ${esc(profil)}.</div>
        <div class="mv-ld-subsection-head">OBJEKT-FILTER</div>
        <div class="mv-ld-subsection-desc">Welche Klassen ÜBERHAUPT durchgelassen werden — alles andere wird sofort verworfen</div>
        <div class="mv-ld-filter-pills">${filterPillsHtml}</div>
        ${_renderCluster2Evidence(ctx, cam)}
        <div class="mv-ld-cluster-actions">
          <button type="button" class="mv-ld-action-btn mv-ld-action-save" data-action="save-cluster2">Speichern (Cam)</button>
          <button type="button" class="mv-ld-action-btn" data-action="defaults-cluster2">Defaults</button>
          <span class="mv-ld-save-status" data-save-status data-save-state="idle"></span>
        </div>
      </div>
    </div>`;
}

function _cluster2HeaderHint(ctx, filterClasses) {
  const ev = ctx.fullData?.cluster_evidence?.cluster2;
  if (!ev) return { tone: 'mute', text: '· Live-Daten in Vorbereitung' };
  const missing = Array.isArray(ev.missing_classes_60s) ? ev.missing_classes_60s : [];
  if (!missing.length && filterClasses.length) {
    return { tone: 'ok', text: '✓ Letzte 60 s: alle Klassen OK' };
  }
  if (missing.length) {
    return { tone: 'warn', text: `⚠ ${missing[0]} seit 60 s ohne Detection` };
  }
  return { tone: 'mute', text: '· kein Filter aktiv' };
}

function _renderCluster2Evidence(ctx, cam) {
  const ev = ctx.fullData?.cluster_evidence?.cluster2;
  const filterArr = Array.isArray(cam.object_filter) ? cam.object_filter : [];
  if (!ev) {
    return `<div class="mv-ld-evidence mv-ld-evidence-ok" data-cluster-evidence="2">
      <div class="mv-ld-evidence-line">📊 Letzte 60 s an dieser Kamera:</div>
      <div class="mv-ld-evidence-mono">Auf erstes Tick warten …</div>
    </div>`;
  }
  const perClass = ev.per_class_60s_counts || {};
  const missing = Array.isArray(ev.missing_classes_60s) ? ev.missing_classes_60s : [];
  const allHave = filterArr.length > 0 && missing.length === 0;
  const parts = filterArr.map((lbl) => {
    const c = perClass[lbl] || { raw: 0, pass: 0, below: 0 };
    return `${lbl}: ${c.raw || 0} raw · ${c.pass || 0} pass · ${c.below || 0} u.S.`;
  });
  const diagnose = allHave
    ? 'Alle aktivierten Klassen liefern Detections — keine fehlt komplett'
    : missing.length
      ? `${missing.join(', ')} seit 60 s ohne Detection — Schwelle prüfen oder Klasse aus Filter entfernen`
      : '';
  return `<div class="mv-ld-evidence ${allHave ? 'mv-ld-evidence-ok' : 'mv-ld-evidence-warn'}" data-cluster-evidence="2">
    <div class="mv-ld-evidence-line">📊 Letzte 60 s an dieser Kamera:</div>
    <div class="mv-ld-evidence-mono">${esc(parts.join(' · '))}</div>
    ${diagnose ? `<div class="mv-ld-evidence-diagnose">${esc(diagnose)}</div>` : ''}
  </div>`;
}

function _wireCluster2(host, cam, ctx) {
  const camId = (ctx.session || {}).camId || cam.id;
  host.querySelectorAll('.mv-ld-slider[data-field^="label_thresholds:"]').forEach((root) => {
    _wireSlider(root, camId);
  });
  host.querySelectorAll('[data-filter-pill]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const lbl = btn.dataset.filterPill;
      const isOn = btn.dataset.on === '1';
      const nextOn = !isOn;
      btn.dataset.on = nextOn ? '1' : '0';
      btn.textContent = nextOn ? `${lbl} ✓` : lbl;
      const allPills = Array.from(host.querySelectorAll('[data-filter-pill]'));
      const filter = allPills
        .filter((p) => p.dataset.on === '1')
        .map((p) => p.dataset.filterPill);
      const statusEl = btn.closest('.mv-ld-cluster')?.querySelector('[data-save-status]');
      _scheduleSave(camId, { object_filter: filter }, statusEl);
    });
  });
  host
    .querySelector('[data-action="save-cluster2"]')
    ?.addEventListener('click', () => _forceSave(camId, host));
  host
    .querySelector('[data-action="defaults-cluster2"]')
    ?.addEventListener('click', () => {
      const filterArr = Array.isArray(cam.object_filter) ? cam.object_filter : [];
      const lt = {};
      for (const lbl of filterArr) {
        lt[lbl] = _CLASS_DEFAULT_THRESH[lbl] || 0.5;
        const sliderRoot = host.querySelector(`.mv-ld-slider[data-field="label_thresholds:${lbl}"]`);
        if (sliderRoot) _setSliderValue(sliderRoot, lt[lbl]);
      }
      const statusEl = host.querySelector('[data-action="defaults-cluster2"]').closest('.mv-ld-cluster').querySelector('[data-save-status]');
      _scheduleSave(camId, { label_thresholds: lt }, statusEl);
    });
  host
    .querySelector('[data-action="open-profil-editor"]')
    ?.addEventListener('click', () => {
      const url = `/#cam-edit?cam=${encodeURIComponent(camId)}&tab=erkennung`;
      window.location.href = url;
    });
}

function _setSliderValue(root, val) {
  const min = Number(root.dataset.min);
  const max = Number(root.dataset.max);
  const step = Number(root.dataset.step);
  const pct = _valToPct(val, min, max);
  root.dataset.value = String(val);
  const knob = root.querySelector('[data-slider-knob]');
  const fill = root.querySelector('[data-slider-fill]');
  const valEl = root.querySelector('[data-slider-value]');
  if (knob) knob.style.left = `${pct.toFixed(2)}%`;
  if (fill) fill.style.width = `${pct.toFixed(2)}%`;
  if (valEl) valEl.textContent = _formatValue(val, step);
}

// SIMU-05d · Cluster 3 · False Positives. Pills only; one-tap adds
// an off-filter class to the excluded_classes list. Zonen-editor
// link surfaces the existing cam-edit zones view.
function _renderCluster3(ctx, cam) {
  const ev = ctx.fullData?.cluster_evidence?.cluster3;
  const offFilter = ev && ev.off_filter_60s_counts ? ev.off_filter_60s_counts : {};
  const topPills = Object.entries(offFilter)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(
      ([lbl, n]) =>
        `<button type="button" class="mv-ld-fp-pill" data-fp-pill="${esc(lbl)}">${esc(lbl)} <span class="mv-ld-fp-count">${n}</span> <span class="mv-ld-fp-x" aria-hidden="true">×</span></button>`,
    )
    .join('');
  const zoneCount = Array.isArray(cam.zones) ? cam.zones.length : 0;
  const maskCount = Array.isArray(cam.masks) ? cam.masks.length : 0;
  return `
    <div class="mv-ld-cluster mv-ld-cluster-warn" data-cluster-id="3">
      ${_renderClusterHeader(3, '▼ Cluster 3 · Falsche Klasse / False Positives',
        'Andere Klassen werden fälschlicherweise erkannt · z.B. „couch" oder „tv"',
        _cluster3HeaderHint(ev))}
      <div class="mv-ld-cluster-body">
        <div class="mv-ld-subsection-head">SCHNELLFILTER (TOP FALSE POSITIVES)</div>
        <div class="mv-ld-subsection-desc">Direkt aus den Top-False-Positives der letzten 60 s · ein Tap entfernt sie aus der Detection-Pipeline</div>
        <div class="mv-ld-fp-pills" data-cluster-evidence="3">
          ${topPills || '<div class="mv-ld-empty-row">Keine False Positives in den letzten 60 s</div>'}
        </div>
        <div class="mv-ld-subsection-head">ZONEN / MASKEN</div>
        <div class="mv-ld-profil-line">
          <span>Aktiv: <span class="mv-ld-profil-val">${zoneCount} Zone(n) · ${maskCount} Maske(n)</span></span>
          <button type="button" class="mv-ld-link-btn" data-action="open-zone-editor">Zonen-Editor öffnen</button>
        </div>
        <div class="mv-ld-cluster-actions">
          <button type="button" class="mv-ld-action-btn" data-action="defaults-cluster3">Defaults</button>
          <span class="mv-ld-save-status" data-save-status data-save-state="idle"></span>
        </div>
      </div>
    </div>`;
}

function _cluster3HeaderHint(ev) {
  if (!ev) return { tone: 'mute', text: '· Live-Daten in Vorbereitung' };
  const offFilter = ev.off_filter_60s_counts || {};
  const entries = Object.entries(offFilter)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  if (!entries.length) return { tone: 'ok', text: '✓ Letzte 60 s: keine False Positives' };
  const summary = entries.map(([k, v]) => `${k} (${v})`).join(', ');
  return { tone: 'warn', text: `⚠ Letzte 60 s: ${summary}` };
}

function _wireCluster3(host, cam, ctx) {
  const camId = (ctx.session || {}).camId || cam.id;
  host.querySelectorAll('[data-fp-pill]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const lbl = btn.dataset.fpPill;
      const existing = Array.isArray(cam.excluded_classes) ? cam.excluded_classes.slice() : [];
      if (!existing.includes(lbl)) existing.push(lbl);
      const statusEl = btn.closest('.mv-ld-cluster')?.querySelector('[data-save-status]');
      _scheduleSave(camId, { excluded_classes: existing }, statusEl);
      btn.remove();
    });
  });
  host
    .querySelector('[data-action="defaults-cluster3"]')
    ?.addEventListener('click', () => {
      const statusEl = host
        .querySelector('[data-action="defaults-cluster3"]')
        .closest('.mv-ld-cluster')
        .querySelector('[data-save-status]');
      _scheduleSave(camId, { excluded_classes: [] }, statusEl);
    });
  host
    .querySelector('[data-action="open-zone-editor"]')
    ?.addEventListener('click', () => {
      const url = `/#cam-edit?cam=${encodeURIComponent(camId)}&tab=zonen`;
      window.location.href = url;
    });
}

// SIMU-05e · Cluster 4 · Performance. Read-only metrics block; the
// header tints green when all values are in target, amber/red when
// any threshold is crossed. Auto-diagnose surfaces specific repair
// hints below the metrics when something is off.
const _PERF_TARGETS = {
  tickCycle: 500,
  inference: 200,
  frameAge: 100,
  subFps: 5,
};

function _renderCluster4(ctx) {
  const t = ctx.tickState || {};
  const diag = ctx.fullData?.diag || {};
  const ev = ctx.fullData?.cluster_evidence?.cluster4 || {};
  const tickCycle = Number.isFinite(ctx.cycleEmaMs)
    ? Math.round(ctx.cycleEmaMs)
    : Number.isFinite(t.lastCycleMs)
      ? Math.round(t.lastCycleMs)
      : null;
  const inference = Number(diag.inference_ms) > 0 ? Math.round(Number(diag.inference_ms)) : null;
  const frameAge = Number(diag.frame_age_ms) >= 0 ? Math.round(Number(diag.frame_age_ms)) : null;
  const drops = Number(t.ticksDroppedLate || 0);
  const subFps = Number(ev.sub_fps) >= 0 ? Number(ev.sub_fps).toFixed(0) : '—';
  const mainFps = Number(ev.main_fps) >= 0 ? Number(ev.main_fps).toFixed(0) : '—';
  const frameSrc = ctx.session?.lastFrameSrc || diag.frame_src;
  const issues = [];
  const okTick = tickCycle == null || tickCycle <= _PERF_TARGETS.tickCycle;
  if (!okTick) issues.push('tick');
  const okInfer = inference == null || inference <= _PERF_TARGETS.inference;
  if (!okInfer) issues.push('inference');
  const okFrame = frameAge == null || frameAge <= _PERF_TARGETS.frameAge;
  if (!okFrame) issues.push('frame');
  const okDrops = drops === 0;
  if (!okDrops) issues.push('drops');
  const okSub = Number(ev.sub_fps || 0) >= _PERF_TARGETS.subFps || !ev.sub_fps;
  if (!okSub) issues.push('sub');
  const healthy = issues.length === 0;
  const hint = healthy
    ? { tone: 'ok', text: '✓ Alle Werte im grünen Bereich' }
    : { tone: 'warn', text: `⚠ ${issues.length} Werte über Schwelle` };
  const diagnoseLines = [];
  if (!okTick && frameSrc === 'main_fallback') {
    diagnoseLines.push('Sub-Stream wieder herstellen — main-fallback ist aktiv');
  }
  if (!okInfer && frameSrc === 'sub') {
    diagnoseLines.push('TPU prüfen — Inference auf sub sollte unter 150 ms liegen');
  }
  if (!okDrops) {
    diagnoseLines.push(`Tick-Loop hat ${drops} Ticks während laufender Fetch verworfen — Backend-Last prüfen`);
  }
  if (!okSub) {
    diagnoseLines.push('Sub-Stream liefert sehr wenig — Reolink Sub-Stream-Konfiguration prüfen');
  }
  const diagnoseHtml = diagnoseLines.length
    ? `<div class="mv-ld-perf-diagnose">${diagnoseLines.map((l) => `<div>${esc(l)}</div>`).join('')}</div>`
    : '';
  return `
    <div class="mv-ld-cluster ${healthy ? 'mv-ld-cluster-ok' : 'mv-ld-cluster-warn'}" data-cluster-id="4">
      <div class="mv-ld-cluster-head mv-ld-cluster-head-${healthy ? 'ok' : 'warn'}">
        <div class="mv-ld-cluster-head-text">
          <div class="mv-ld-cluster-head-title">▼ Cluster 4 · Performance / Hänger</div>
          <div class="mv-ld-cluster-head-sub">${healthy ? 'aktuell unauffällig · Detection läuft flüssig' : '⚠ Tick-Cycle oder Inference über Schwelle'}</div>
        </div>
        <div class="mv-ld-cluster-head-hint" data-hint-tone="${hint.tone}">${esc(hint.text)}</div>
      </div>
      <div class="mv-ld-cluster-body">
        <div class="mv-ld-perf-grid">
          ${_perfRow('Tick-Cycle', tickCycle == null ? '—' : `${tickCycle} ms`, `Ziel < ${_PERF_TARGETS.tickCycle} ms`, okTick)}
          ${_perfRow('Inference', inference == null ? '—' : `${inference} ms`, `Ziel < ${_PERF_TARGETS.inference} ms`, okInfer)}
          ${_perfRow('Frame-Age', frameAge == null ? '—' : `${frameAge} ms`, `Ziel < ${_PERF_TARGETS.frameAge} ms`, okFrame)}
          ${_perfRow('Dropped Ticks', String(drops), 'Ziel = 0', okDrops)}
          ${_perfRow('Sub-Stream', `${subFps} fps`, 'verfügbar', okSub)}
          ${_perfRow('Main-Stream', `${mainFps} fps`, 'parallel · ungenutzt für Detection', true)}
        </div>
        ${diagnoseHtml}
      </div>
    </div>`;
}

function _perfRow(label, value, target, ok) {
  const cls = ok ? 'mv-ld-perf-ok' : 'mv-ld-perf-bad';
  const mark = ok ? '✓' : '✗';
  return `
    <div class="mv-ld-perf-row ${cls}">
      <span class="mv-ld-perf-label">${esc(label)}</span>
      <span class="mv-ld-perf-value">${esc(value)}</span>
      <span class="mv-ld-perf-target">(${esc(target)} ${mark})</span>
    </div>`;
}
