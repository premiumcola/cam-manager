// ─── weather/settings-suntltest.js ─────────────────────────────────────────
// Sun-Timelapse TEST subtab. Fires an ad-hoc 60/120/300 s capture against
// the user-selected weather camera using the same backend code path the
// real sunrise/sunset schedule runs through, and surfaces every signal
// needed to diagnose why twilight captures come out monochrome with
// duplicate-frame stretches:
//
//   • daynight-override result (Color set / failed / skipped)
//   • elapsed / target seconds with a progress bar
//   • frame counters (captured / expected / retries / invalid)
//   • per-reason rejection breakdown — the smoking-gun for the
//     duplicate-frame bug (long blocks of frames rejected by
//     grey_uniform / too_dark / no_detail get padded by ffmpeg)
//   • scrolling tail of [sun-tl-test] / [weather] / [capture-stats]
//     log lines straight from the in-memory ring buffer the backend
//     keeps alongside the session
//
// Polls /api/weather/sun-tl/test/status every 2 s while a session is
// active; auto-stops on completion. Switching to another tab also
// stops the poller (settings.js calls stopSunTlTestPolling).

import { byId, esc } from "../core/dom.js";
import { state } from "../core/state.js";
import { showToast } from "../core/toast.js";

const _DURATIONS = [
  { s: 60,   label: "1 min" },
  { s: 120,  label: "2 min" },
  { s: 300,  label: "5 min" },
  { s: 1800, label: "30 min" },
  { s: 2400, label: "40 min" },
];

// Final MP4 length picker — mirrors the regular weather sun-timelapse
// length options so the test reproduces the same encode behaviour.
const _TARGET_LENGTHS = [
  { s: 10, label: "10 s" },
  { s: 15, label: "15 s" },
  { s: 20, label: "20 s" },
  { s: 30, label: "30 s" },
];

// Local UI state — survives re-renders within a single tab visit.
let _selCam = null;
let _selPhase = "sunset";
let _selDuration = 120;
let _selTargetLength = 20;
let _pollTimer = null;

function _weatherCams(){
  return (state.cameras || []).filter(c => c && (c.weather && c.weather.enabled));
}

function _renderHeader(cams){
  const camOpts = cams.map(c =>
    `<option value="${esc(c.id)}"${c.id === _selCam ? ' selected' : ''}>${esc(c.name || c.id)}</option>`
  ).join('');
  const durChips = _DURATIONS.map(d =>
    `<button type="button" class="suntltest-chip${d.s === _selDuration ? ' is-active' : ''}" data-suntltest-dur="${d.s}">${d.label}</button>`
  ).join('');
  const tgtChips = _TARGET_LENGTHS.map(d =>
    `<button type="button" class="suntltest-chip${d.s === _selTargetLength ? ' is-active' : ''}" data-suntltest-tgt="${d.s}">${d.label}</button>`
  ).join('');
  return `
    <div class="suntltest-form">
      <div class="suntltest-form-row">
        <label class="suntltest-lbl" for="suntltestCam">Kamera</label>
        <select id="suntltestCam" class="dark-select suntltest-sel">${camOpts}</select>
      </div>
      <div class="suntltest-form-row">
        <span class="suntltest-lbl">Phase</span>
        <div class="suntltest-phase-row" role="radiogroup" aria-label="Phase">
          <button type="button" class="suntltest-chip${_selPhase === 'sunrise' ? ' is-active' : ''}" data-suntltest-phase="sunrise">🌄 Sonnenaufgang</button>
          <button type="button" class="suntltest-chip${_selPhase === 'sunset'  ? ' is-active' : ''}" data-suntltest-phase="sunset">🌇 Sonnenuntergang</button>
        </div>
      </div>
      <div class="suntltest-form-row">
        <span class="suntltest-lbl">Aufnahme-Dauer</span>
        <div class="suntltest-dur-row" role="radiogroup" aria-label="Aufnahme-Dauer">${durChips}</div>
      </div>
      <div class="suntltest-form-row">
        <span class="suntltest-lbl">Video-Länge</span>
        <div class="suntltest-dur-row" role="radiogroup" aria-label="Video-Länge">${tgtChips}</div>
      </div>
      <div class="suntltest-form-row suntltest-form-row--start">
        <button type="button" id="suntltestStart" class="btn-action accent suntltest-start">▶ Jetzt starten</button>
        <button type="button" id="suntltestCancel" class="btn-action danger suntltest-cancel" hidden>⏹ Abbrechen</button>
      </div>
      <div class="field-help suntltest-hint">Test fährt die echte Capture-Pipeline an (gleicher Code, kürzeres Fenster). Ergebnis landet als <code>_test_HHMMSS_…</code> in den Sichtungen.</div>
    </div>
    <div id="suntltestLive" class="suntltest-live" hidden></div>
    <div id="suntltestResult" class="suntltest-result" hidden></div>
  `;
}

function _bindForm(root){
  byId('suntltestCam')?.addEventListener('change', (e) => {
    _selCam = e.target.value || null;
  });
  root.querySelectorAll('[data-suntltest-phase]').forEach(btn => {
    btn.addEventListener('click', () => {
      _selPhase = btn.dataset.suntltestPhase;
      root.querySelectorAll('[data-suntltest-phase]').forEach(b =>
        b.classList.toggle('is-active', b.dataset.suntltestPhase === _selPhase));
    });
  });
  root.querySelectorAll('[data-suntltest-dur]').forEach(btn => {
    btn.addEventListener('click', () => {
      _selDuration = parseInt(btn.dataset.suntltestDur, 10) || 120;
      root.querySelectorAll('[data-suntltest-dur]').forEach(b =>
        b.classList.toggle('is-active', parseInt(b.dataset.suntltestDur, 10) === _selDuration));
    });
  });
  root.querySelectorAll('[data-suntltest-tgt]').forEach(btn => {
    btn.addEventListener('click', () => {
      _selTargetLength = parseInt(btn.dataset.suntltestTgt, 10) || 20;
      root.querySelectorAll('[data-suntltest-tgt]').forEach(b =>
        b.classList.toggle('is-active', parseInt(b.dataset.suntltestTgt, 10) === _selTargetLength));
    });
  });
  byId('suntltestStart')?.addEventListener('click', _startTest);
  byId('suntltestCancel')?.addEventListener('click', _cancelTest);
}

// Centralised UI toggle — hide the start button while a test is in
// flight so a fast clicker can't fire a second start before the
// poller has reset state. The cancel button mirrors the inverse.
function _setRunningUi(isRunning){
  const start = byId('suntltestStart');
  const cancel = byId('suntltestCancel');
  if (start)  { start.hidden = !!isRunning;  start.disabled = !!isRunning; }
  if (cancel) { cancel.hidden = !isRunning; cancel.disabled = false; }
}

async function _startTest(){
  // Synchronous reset BEFORE the network round-trip so the user
  // never sees the previous run's MP4 card or live tile while the
  // new run is starting. Polling will repaint these from the live
  // status response within ~2 s.
  const wrap = byId('suntltestResult');
  if (wrap) { wrap.hidden = true; wrap.innerHTML = ''; }
  const live = byId('suntltestLive');
  if (live) { live.hidden = true; live.innerHTML = ''; }

  const btn = byId('suntltestStart');
  if (!_selCam) { showToast('Keine Wetter-Kamera ausgewählt.', 'error'); return; }
  if (btn) btn.disabled = true;
  try {
    const r = await fetch('/api/weather/sun-tl/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cam_id: _selCam, phase: _selPhase,
        duration_s: _selDuration,
        target_duration_s: _selTargetLength,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      showToast('Start fehlgeschlagen: ' + (j.error || r.statusText || ('HTTP ' + r.status)), 'error');
      if (btn) btn.disabled = false;
      return;
    }
    showToast('Test läuft …', 'success');
    _setRunningUi(true);
    _startPolling();
  } catch (e) {
    showToast('Netzwerkfehler beim Start: ' + e, 'error');
    if (btn) btn.disabled = false;
  }
}

async function _cancelTest(){
  const btn = byId('suntltestCancel');
  if (btn) btn.disabled = true;
  try {
    const r = await fetch('/api/weather/sun-tl/test/cancel', { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      showToast('Abbruch fehlgeschlagen: ' + (j.error || r.statusText), 'error');
      if (btn) btn.disabled = false;
      return;
    }
    showToast('Abbruch wird gesendet …', 'info');
    // Don't stop polling — let the status endpoint confirm the run
    // actually stopped, then _pollOnce will swap the UI back to the
    // start state and render the cancelled-state card.
  } catch (e) {
    showToast('Netzwerkfehler beim Abbruch: ' + e, 'error');
    if (btn) btn.disabled = false;
  }
}

function _startPolling(){
  stopSunTlTestPolling();
  _pollOnce();
  _pollTimer = setInterval(_pollOnce, 2000);
}

export function stopSunTlTestPolling(){
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

async function _pollOnce(){
  let d = null;
  try {
    const r = await fetch('/api/weather/sun-tl/test/status');
    d = await r.json();
  } catch (_err) {
    return;
  }
  _renderLive(d);
  if (d && (d.finished || !d.running)) {
    stopSunTlTestPolling();
    _setRunningUi(false);
    _renderResult(d);
  }
}

function _renderLive(d){
  const wrap = byId('suntltestLive'); if (!wrap) return;
  if (!d || !d.cam_id) { wrap.hidden = true; wrap.innerHTML = ''; return; }
  wrap.hidden = false;
  const elapsed = Math.max(0, parseInt(d.elapsed_s, 10) || 0);
  const target = Math.max(1, parseInt(d.target_s, 10) || 1);
  const pct = Math.min(100, Math.round((elapsed / target) * 100));
  const captured = parseInt(d.captured_frames, 10) || 0;
  const expected = parseInt(d.expected_frames, 10) || 0;
  const invalid = parseInt(d.invalid_frames, 10) || 0;
  const retries = parseInt(d.retry_recoveries, 10) || 0;
  const dnBadge = _dnBadge(d.daynight_color_set);
  const phaseLabel = d.phase === 'sunrise' ? '🌄 Sonnenaufgang' : '🌇 Sonnenuntergang';
  const camName = (state.cameras || []).find(c => c.id === d.cam_id)?.name || d.cam_id;
  const stateClass = d.finished ? 'is-done' : (d.running ? 'is-running' : 'is-idle');
  const rejected = d.rejected_by_reason || {};
  const examples = d.rejected_by_reason_examples || {};
  const rejectedRows = Object.entries(rejected)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => {
      const ex = examples[k] || '';
      // Detail tail = the part inside the FIRST observed reason's
      // parens, e.g. "40/40=100%" from "dead_area(40/40=100%)".
      let detail = '';
      if (ex && ex.includes('(') && ex.endsWith(')')){
        detail = ex.slice(ex.indexOf('(') + 1, -1);
      }
      const hint = _rejectHintDe(k);
      return `
      <div class="suntltest-rej-row">
        <div class="suntltest-rej-row-head">
          <span class="suntltest-rej-key">${esc(k)}</span>
          <span class="suntltest-rej-val">${v}</span>
        </div>
        ${detail ? `<div class="suntltest-rej-detail">${esc(detail)}</div>` : ''}
        ${hint ? `<div class="suntltest-rej-hint">${esc(hint)}</div>` : ''}
      </div>`;
    }).join('');
  const rejectedBlock = rejectedRows
    ? `<div class="suntltest-rej-list">${rejectedRows}</div>`
    : `<div class="suntltest-rej-empty">— keine Rejects bisher —</div>`;
  // Profile + drift pills above the existing tile grid.
  const profileBadge = _profileBadge(d.validator_profile, d.baseline_brightness);
  const driftBadge   = _driftBadge(d.phase_drift_warning, d.phase_drift_min);
  const pillRow = (profileBadge || driftBadge)
    ? `<div class="suntltest-pill-row">${profileBadge}${driftBadge}</div>`
    : '';
  const logBlock = (d.last_log_lines || [])
    .slice(-60)
    .map(line => `<div class="suntltest-log-line">${esc(line)}</div>`)
    .join('');
  // "How many slots in the resulting MP4 are real content?" — derived
  // counters answer the user's recurring question. fresh = brand-new
  // grabs, backfilled = invalid slots filled with the most-recent
  // valid frame for encoder continuity, skipped = scene-level rejects
  // we deliberately gave up on. backfill_cache_drops only renders
  // when > 0 to avoid clutter on healthy captures.
  const fresh = parseInt(d.fresh_captures, 10) || 0;
  const back  = parseInt(d.backfilled_slots, 10) || 0;
  const skip  = parseInt(d.skipped_slots, 10) || 0;
  const cacheDrops = parseInt(d.backfill_cache_drops, 10) || 0;
  const breakdownBlock = (fresh + back + skip > 0)
    ? `<div class="suntltest-breakdown">
        <div class="suntltest-bkd-row">
          <span class="suntltest-bkd-label">Frisch erfasst</span>
          <span class="suntltest-bkd-val suntltest-bkd-val--ok">${fresh}</span>
        </div>
        <div class="suntltest-bkd-row">
          <span class="suntltest-bkd-label">Aufgefüllt mit letztem gültigen Frame</span>
          <span class="suntltest-bkd-val suntltest-bkd-val--mute">${back}</span>
        </div>
        <div class="suntltest-bkd-row">
          <span class="suntltest-bkd-label">Übersprungen (Szene leer)</span>
          <span class="suntltest-bkd-val suntltest-bkd-val--mute">${skip}</span>
        </div>
        ${cacheDrops > 0 ? `
        <div class="suntltest-bkd-row" title="Backfill-Cache wurde verworfen, weil der zwischengespeicherte Frame nach mehrfacher Wiederverwendung von einer strikteren Validierung als korrupt erkannt wurde.">
          <span class="suntltest-bkd-label">Backfill-Cache verworfen</span>
          <span class="suntltest-bkd-val suntltest-bkd-val--warn">${cacheDrops}</span>
        </div>` : ''}
      </div>`
    : '';
  wrap.className = `suntltest-live ${stateClass}`;
  wrap.innerHTML = `
    <div class="suntltest-live-head">
      <div class="suntltest-live-title">${esc(camName)} · ${phaseLabel}</div>
      <div class="suntltest-live-status">${d.finished ? '✅ fertig' : (d.running ? '⏺ läuft' : '⏸ pausiert')}</div>
    </div>
    ${pillRow}
    <div class="suntltest-live-grid">
      <div class="suntltest-tile">
        <div class="suntltest-tile-label">Tag/Nacht-Override</div>
        <div class="suntltest-tile-val">${dnBadge}</div>
      </div>
      <div class="suntltest-tile">
        <div class="suntltest-tile-label">Zeit</div>
        <div class="suntltest-tile-val"><b>${elapsed}</b> / ${target} s</div>
        <div class="suntltest-progress"><span style="width:${pct}%"></span></div>
      </div>
      <div class="suntltest-tile">
        <div class="suntltest-tile-label">Frames</div>
        <div class="suntltest-tile-val"><b>${captured}</b> / ${expected}</div>
        <div class="suntltest-tile-sub">Retries ${retries} · Invalid ${invalid}</div>
      </div>
    </div>
    ${breakdownBlock}
    <div class="suntltest-section">
      <div class="suntltest-section-title">Verworfen wegen …</div>
      ${rejectedBlock}
    </div>
    <div class="suntltest-section">
      <div class="suntltest-section-title">Log-Tail</div>
      <div class="suntltest-log-box" id="suntltestLog">${logBlock || '<div class="suntltest-log-line muted">— kein Log —</div>'}</div>
    </div>
    ${d.raw_dir ? `
    <div class="suntltest-section suntltest-rawdir">
      <span class="suntltest-rawdir-label">Roh-Frames:</span>
      <code class="suntltest-rawdir-path">${esc(d.raw_dir)}</code>
      <button type="button" class="suntltest-rawdir-copy" data-suntltest-copy="${esc(d.raw_dir)}" title="Pfad kopieren" aria-label="Pfad kopieren">⧉ kopieren</button>
    </div>` : ''}
  `;
  // Auto-stick the log to the bottom while it grows.
  const logBox = byId('suntltestLog');
  if (logBox) logBox.scrollTop = logBox.scrollHeight;
  // Wire the copy button. Falls back to a transient text-selection
  // when navigator.clipboard is unavailable (older Safari, http
  // contexts) so the path is still selectable manually.
  const copyBtn = wrap.querySelector('[data-suntltest-copy]');
  if (copyBtn){
    copyBtn.addEventListener('click', async () => {
      const path = copyBtn.getAttribute('data-suntltest-copy') || '';
      try {
        if (navigator.clipboard && navigator.clipboard.writeText){
          await navigator.clipboard.writeText(path);
        } else {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(wrap.querySelector('.suntltest-rawdir-path'));
          sel?.removeAllRanges(); sel?.addRange(range);
        }
        copyBtn.textContent = '✓ kopiert';
        setTimeout(() => { copyBtn.textContent = '⧉ kopieren'; }, 1500);
      } catch (_e){ /* noop — selection fallback already ran */ }
    });
  }
}

function _dnBadge(v){
  if (v === true)  return '<span class="suntltest-badge suntltest-badge--ok">Color gesetzt</span>';
  if (v === false) return '<span class="suntltest-badge suntltest-badge--err">fehlgeschlagen</span>';
  return '<span class="suntltest-badge suntltest-badge--mute">übersprungen</span>';
}

// Profile pill — DAY (sun yellow) / TWILIGHT (horizon orange) / NIGHT
// (deep blue). Soft tinted background, rounded ≥ 8 px, no thin border
// per project rules.
function _profileBadge(profile, brightness){
  if (!profile) return '';
  const labels = { day: 'DAY', twilight: 'TWILIGHT', night: 'NIGHT' };
  const cls = `suntltest-pill suntltest-pill--${profile}`;
  const lbl = labels[profile] || profile.toUpperCase();
  const sub = (typeof brightness === 'number')
    ? ` <span class="suntltest-pill-sub">brightness ${brightness}</span>`
    : '';
  return `<span class="${cls}">${esc(lbl)}${sub}</span>`;
}

// Drift pill — only renders when the backend flagged a drift > limit.
// Amber tint. Reads e.g. "Sunset-Capture lief 312 min nach Sonnen-
// untergang — Frames sind reine Nacht".
function _driftBadge(warning, _drift_min){
  if (!warning) return '';
  return `<span class="suntltest-pill suntltest-pill--drift">⚠ ${esc(warning)}</span>`;
}

// One-liner German hints under each rejected_by_reason row. Frontend
// strings only — backend stays language-agnostic.
const _REJECT_HINT_DE = {
  dead_area: 'Wenig Textur — wahrscheinlich Nachthimmel oder leere Wand',
  grey_midband: 'IR-Cut-Filter-Transition oder gleichmäßig grauer Himmel',
  grey_uniform: 'IR-Cut-Filter-Transition oder gleichmäßig grauer Himmel',
  no_detail: 'Frame fast komplett uniform — Encoder-Hickup oder Kamera-Reset',
  pink_artifact: 'H.265-Decode-Fehler — typisch bei schwacher Verbindung',
  patterned_magenta: 'H.265-Decode-Fehler — typisch bei schwacher Verbindung',
  colorbar: 'Kamera hat ein Test-Pattern gesendet',
  too_dark: 'Belichtung außerhalb des gültigen Bereichs',
  too_bright: 'Belichtung außerhalb des gültigen Bereichs',
  bottom_strip_white: 'H.265-Decoder hat unteren Bildbereich mit weißem Füllmuster ersetzt — RTSP-Paketverlust oder defekter Slice',
  bottom_strip_bright: 'Unterer Bildbereich deutlich heller als Szene — wahrscheinlich Macroblock-Korruption',
  horizontal_anomaly_band: 'Horizontales Korruptions-Band im Bild — H.265-Decoder-Fehler, Slice unvollständig oder Macroblock-Verlust',
  flat_gray_full_frame: 'Vollbild flach-grau — H.265-Decoder-Ausgabe ohne Szeneninhalt',
};
function _rejectHintDe(key){
  if (!key) return '';
  // Normalise the key:
  //   • strip everything from the first '(' so a parameterised
  //     reason head ("horizontal_anomaly_band(y=55%,h=2%,score=3.6)")
  //     matches the bare "horizontal_anomaly_band" entry
  //   • strip the _yNN_hNN band-location suffix that the test-mode
  //     reject sink appends to the folder name
  //   • collapse split_*_dead → "split" so the four split variants
  //     share one hint
  let bare = key;
  const lp = bare.indexOf('(');
  if (lp >= 0) bare = bare.slice(0, lp);
  bare = bare.replace(/_y\d+_h\d+$/, '');
  if (bare.startsWith('split_')) bare = 'split';
  return _REJECT_HINT_DE[bare] || _REJECT_HINT_DE[key] || '';
}

function _renderResult(d){
  const wrap = byId('suntltestResult'); if (!wrap) return;
  if (!d || !d.finished) { wrap.hidden = true; wrap.innerHTML = ''; return; }
  // Cancelled-state card — distinct from a generic error so the user
  // recognises this as their own action, not a failure. Render BEFORE
  // the generic error branch so a session that ends with both
  // ``cancelled=true`` AND ``error="abgebrochen"`` set still gets the
  // mute card, not the red one.
  if (d.cancelled) {
    wrap.hidden = false;
    wrap.innerHTML = `
      <div class="suntltest-result-card suntltest-result-card--mute">
        <div class="suntltest-result-title">⏹ Test abgebrochen</div>
        <div class="suntltest-result-msg">Aufnahme wurde manuell abgebrochen — kein MP4 erzeugt.</div>
      </div>`;
    return;
  }
  if (d.error && !d.result_sighting_id) {
    wrap.hidden = false;
    wrap.innerHTML = `
      <div class="suntltest-result-card suntltest-result-card--err">
        <div class="suntltest-result-title">⚠ Test ohne Ergebnis</div>
        <div class="suntltest-result-msg">${esc(d.error)}</div>
      </div>`;
    return;
  }
  if (!d.result_sighting_id) { wrap.hidden = true; return; }
  wrap.hidden = false;
  // The Sichtungen tab handles the actual playback — link the user
  // there with the sighting id pre-filtered. Falls back to the raw
  // clip URL if something has stripped the deep-link handler.
  const id = d.result_sighting_id;
  wrap.innerHTML = `
    <div class="suntltest-result-card suntltest-result-card--ok">
      <div class="suntltest-result-title">🎬 Test-MP4 fertig</div>
      <div class="suntltest-result-msg">Sichtungs-ID <code>${esc(id)}</code></div>
      <div class="suntltest-result-actions">
        <a class="btn-action accent" href="/api/weather/sightings/${encodeURIComponent(id)}/clip" target="_blank" rel="noopener">▶ MP4 öffnen</a>
        <button type="button" class="btn-action ghost" data-suntltest-jump="${esc(id)}">In Sichtungen anzeigen</button>
      </div>
    </div>`;
  wrap.querySelector('[data-suntltest-jump]')?.addEventListener('click', () => {
    // Best-effort — the Sichtungen panel reads its filter from the
    // URL hash on activation, so a hash bump is enough.
    window.location.hash = `#sichtungen?sighting=${encodeURIComponent(id)}`;
  });
}

export function renderSunTlTestPanel(){
  const root = byId('sunTlTestPanel'); if (!root) return;
  const cams = _weatherCams();
  if (!cams.length) {
    root.innerHTML = `<div class="field-help">Keine Wetter-Kamera aktiv. Aktiviere eine Kamera unter "📷 Kameras".</div>`;
    return;
  }
  if (!cams.find(c => c.id === _selCam)) _selCam = cams[0].id;
  root.innerHTML = _renderHeader(cams);
  _bindForm(root);
  // Surface any prior session immediately on tab open so the user
  // doesn't lose state if they switch tabs mid-run.
  fetch('/api/weather/sun-tl/test/status').then(r => r.json()).then(d => {
    if (d && d.cam_id) {
      _renderLive(d);
      // Tab-open re-render: if a test is still in flight when the user
      // navigates back, surface the abort button immediately so they
      // can stop it without waiting for the next poll tick.
      _setRunningUi(d.running && !d.finished);
      if (d.running && !d.finished) _startPolling();
      else _renderResult(d);
    }
  }).catch(() => {});
}
