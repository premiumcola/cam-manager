// ─── camedit/erk-sim/thresholds.js ─────────────────────────────────────────
// K13 · info strip showing the four track_* form limits side-by-side
// with the simulator's live "Ist-Werte". Goal: let the user dial in
// good values empirically by watching how today's tracks compare
// against the configured thresholds in real time.
//
// Renders inside the simulator result panel; visible only while
// live-detect is running. Pulls limits from the form inputs on every
// tick so a slider edit shows up in the strip on the next frame.
//
// "Aktuell" semantics:
//   Spawn-Schwelle      → highest best_score across active tracks
//                         (would they spawn under the current limit?)
//   Fortsetzungs-Floor  → lowest last_score across active tracks
//                         (any track currently at risk of dropping?)
//   Gnadenfrist         → longest current miss-time (now − last_seen_ms)
//   IoU-Schwelle        → highest matched IoU on the most recent tick
import { byId } from '../../core/dom.js';

const _LIMIT_LABELS = {
  spawn: 'Spawn-Schwelle',
  cont:  'Fortsetzungs-Floor',
  grace: 'Gnadenfrist',
  iou:   'IoU-Schwelle',
};

// Module defaults — mirror tracker_core.py constants so the displayed
// "Limit" matches what the production tracker would actually use when
// the per-camera input is 0.0 ("System-Default verwenden").
const _MODULE_DEFAULTS = {
  spawn: 0.50,
  cont:  0.20,
  grace: 8.0,
  iou:   0.20,
};

// Read the four form inputs, fall back to module defaults when the
// user input is 0 / empty / NaN (the schema's "use system default"
// sentinel). Returns numeric values for the four rows + a boolean
// flag per row that tells the renderer whether the limit is custom
// or defaulted (used to dim the value cell).
function _readLimits(formEl){
  const f = formEl?.elements;
  const _read = (name, fallback) => {
    const raw = parseFloat(f?.[name]?.value);
    return Number.isFinite(raw) && raw > 0
      ? { v: raw, defaulted: false }
      : { v: fallback, defaulted: true };
  };
  return {
    spawn: _read('track_spawn_min_score', _MODULE_DEFAULTS.spawn),
    cont:  _read('track_continue_min_score', _MODULE_DEFAULTS.cont),
    grace: _read('track_miss_grace_seconds', _MODULE_DEFAULTS.grace),
    iou:   _read('track_iou_match_threshold', _MODULE_DEFAULTS.iou),
  };
}

// Pull the live "Ist-Werte" from a tracker snapshot + the last-match
// list. Returns null entries when there's no signal yet (no active
// tracks, no last-tick matches) so the renderer can show "—" instead
// of misleading zeros.
function _readActual(tracks, lastMatches, now_ms){
  let spawnHi = null, spawnHiTrack = null;
  let contLo = null, contLoTrack = null;
  let graceMax = null, graceMaxTrack = null;
  for (const t of tracks){
    if (!Number.isFinite(t.best_score)) continue;
    if (spawnHi === null || t.best_score > spawnHi){
      spawnHi = t.best_score; spawnHiTrack = t.id;
    }
    if (Number.isFinite(t.last_score)){
      if (contLo === null || t.last_score < contLo){
        contLo = t.last_score; contLoTrack = t.id;
      }
    }
    const missMs = now_ms - t.last_seen_ms;
    if (Number.isFinite(missMs)){
      if (graceMax === null || missMs > graceMax){
        graceMax = missMs; graceMaxTrack = t.id;
      }
    }
  }
  let iouHi = null, iouHiTrack = null;
  for (const m of lastMatches){
    if (iouHi === null || m.iou > iouHi){
      iouHi = m.iou; iouHiTrack = m.trackId;
    }
  }
  return {
    spawn: spawnHi !== null ? { v: spawnHi, track: spawnHiTrack } : null,
    cont:  contLo  !== null ? { v: contLo,  track: contLoTrack  } : null,
    grace: graceMax !== null ? { v: graceMax / 1000, track: graceMaxTrack } : null,
    iou:   iouHi   !== null ? { v: iouHi,   track: iouHiTrack   } : null,
  };
}

const _fmt = (n, digits = 2) => {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

// Build one row's HTML. `status` is 'ok' / 'warn' / 'idle' (no signal).
// Track suffix (`#N`) appears only when the row has a backing track id.
function _row(key, limit, actual){
  const lbl = _LIMIT_LABELS[key];
  const isGrace = key === 'grace';
  const limitDigits = isGrace ? 1 : 2;
  const limitUnit = isGrace ? ' s' : '';
  const limitTxt = _fmt(limit.v, limitDigits) + limitUnit;
  let actualTxt = '—';
  let status = 'idle';
  let trackTxt = '';
  let actualLbl;
  if (key === 'spawn') actualLbl = 'aktuell höchste';
  else if (key === 'cont') actualLbl = 'aktuell niedrigste';
  else if (key === 'grace') actualLbl = 'aktuell ohne Treffer';
  else actualLbl = 'letzter Match';
  if (actual !== null){
    actualTxt = _fmt(actual.v, limitDigits) + limitUnit;
    // OK semantics differ per row:
    //   spawn  → highest current score ≥ limit  → at least one track
    //            would spawn under this config (good signal).
    //   cont   → lowest current score ≥ limit   → all current tracks
    //            stay alive (good signal).
    //   grace  → max current miss-time < limit  → no track at risk.
    //   iou    → last match IoU ≥ limit         → matches accepted.
    let ok;
    if (key === 'grace') ok = actual.v < limit.v;
    else                  ok = actual.v >= limit.v;
    status = ok ? 'ok' : 'warn';
    if (actual.track != null){
      trackTxt = `<span class="erk-thr-tag">Track #${actual.track}</span>`;
    }
  }
  const icon = status === 'ok'
    ? '<span class="erk-thr-mark erk-thr-mark--ok" aria-hidden="true">✓</span>'
    : status === 'warn'
      ? '<span class="erk-thr-mark erk-thr-mark--warn" aria-hidden="true">↓</span>'
      : '<span class="erk-thr-mark erk-thr-mark--idle" aria-hidden="true">·</span>';
  const limitClass = limit.defaulted ? 'erk-thr-limit erk-thr-limit--default' : 'erk-thr-limit';
  return `
    <div class="erk-thr-row erk-thr-row--${status}">
      <span class="erk-thr-lbl">${lbl}</span>
      <span class="${limitClass}">${limitTxt}</span>
      <span class="erk-thr-sep">·</span>
      <span class="erk-thr-actual-lbl">${actualLbl}</span>
      <span class="erk-thr-actual">${actualTxt}</span>
      ${icon}
      ${trackTxt}
    </div>`;
}

// Public — called per simulator tick by live.js right after the
// IoUTracker.tick(). Renders the four-row strip into #erkSimThresholds.
// The host element is created lazily on first render and slotted
// between the live timeline and the detection list.
export function renderThresholdStrip(formEl, tracker, now_ms){
  const host = _ensureHost();
  if (!host) return;
  const limits = _readLimits(formEl);
  const actual = _readActual(
    tracker.activeTracks(),
    tracker.lastMatches(),
    now_ms,
  );
  host.innerHTML = [
    _row('spawn', limits.spawn, actual.spawn),
    _row('cont',  limits.cont,  actual.cont),
    _row('grace', limits.grace, actual.grace),
    _row('iou',   limits.iou,   actual.iou),
  ].join('');
  host.hidden = false;
}

// Hide the strip when live mode stops so the frozen frame doesn't
// show stale "Ist-Werte" implying the loop is still running.
export function hideThresholdStrip(){
  const host = byId('erkSimThresholds');
  if (host) host.hidden = true;
}

function _ensureHost(){
  let host = byId('erkSimThresholds');
  if (host) return host;
  const body = byId('erkSimLiveBody');
  if (!body) return null;
  host = document.createElement('div');
  host.id = 'erkSimThresholds';
  host.className = 'erk-thr-strip';
  host.hidden = true;
  // Slot right after the timeline so the strip sits visually below
  // the per-class presence bars and above the detection list. If the
  // timeline isn't in the DOM (legacy layouts) we still find a sane
  // anchor via the detection list.
  const tl = byId('erkSimTimeline');
  const list = byId('erkSimList');
  if (tl && tl.parentNode === body){
    body.insertBefore(host, tl.nextSibling);
  } else if (list && list.parentNode === body){
    body.insertBefore(host, list);
  } else {
    body.appendChild(host);
  }
  return host;
}
