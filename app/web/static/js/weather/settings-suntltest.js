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
}

async function _startTest(){
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
    _startPolling();
  } catch (e) {
    showToast('Netzwerkfehler beim Start: ' + e, 'error');
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
    const startBtn = byId('suntltestStart');
    if (startBtn) startBtn.disabled = false;
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
  const rejectedRows = Object.entries(rejected)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `
      <div class="suntltest-rej-row">
        <span class="suntltest-rej-key">${esc(k)}</span>
        <span class="suntltest-rej-val">${v}</span>
      </div>`).join('');
  const rejectedBlock = rejectedRows
    ? `<div class="suntltest-rej-list">${rejectedRows}</div>`
    : `<div class="suntltest-rej-empty">— keine Rejects bisher —</div>`;
  const logBlock = (d.last_log_lines || [])
    .slice(-60)
    .map(line => `<div class="suntltest-log-line">${esc(line)}</div>`)
    .join('');
  wrap.className = `suntltest-live ${stateClass}`;
  wrap.innerHTML = `
    <div class="suntltest-live-head">
      <div class="suntltest-live-title">${esc(camName)} · ${phaseLabel}</div>
      <div class="suntltest-live-status">${d.finished ? '✅ fertig' : (d.running ? '⏺ läuft' : '⏸ pausiert')}</div>
    </div>
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

function _renderResult(d){
  const wrap = byId('suntltestResult'); if (!wrap) return;
  if (!d || !d.finished) { wrap.hidden = true; wrap.innerHTML = ''; return; }
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
      if (d.running && !d.finished) _startPolling();
      else _renderResult(d);
    }
  }).catch(() => {});
}
