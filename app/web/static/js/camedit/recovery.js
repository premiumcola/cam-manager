// ─── camedit/recovery.js ───────────────────────────────────────────────────
// Stage 7 of the legacy.js → ES modules refactor — the "Verbindung"
// tab "Wiederherstellen ↺" modal + connection-warn indicator + the
// camera-status diagnostics block.
//
// Two recovery paths, in priority order:
//   A) Sicherung — settings.json.bak / .bak2 + storage/backups/*.json.
//      Restores the four connection fields server-side and triggers an
//      immediate reconnect via /api/settings/cameras/<id>/restore-connection.
//   B) Auto-Erkennung — calls /api/discover and lets the user pick a
//      device; only IP + suggested RTSP path are written into the form.
//      User enters credentials and uses the normal Save button.
import { byId, esc } from '../core/dom.js';
import { j, apiGet, apiPost } from '../core/api.js';
import { showToast } from '../core/toast.js';
import { panelState, _closeEditPanel } from './panel.js';
import { _rtspEnc, parseRtspUrl } from './rtsp.js';

window.openCamRecoveryModal = function(){
  if (!panelState.camId) return;
  const m = byId('camRecoveryModal');
  if (!m) return;
  m.classList.remove('hidden');
  // Default to the Sicherung tab.
  _switchCamRecoveryTab('rec-backup');
  loadCamRecoveryBackups();
  // Wire tab clicks once.
  if (!m.dataset.wired){
    m.querySelectorAll('.cam-recovery-tab').forEach(b => {
      b.addEventListener('click', () => _switchCamRecoveryTab(b.dataset.tab));
    });
    m.dataset.wired = '1';
  }
};

window.closeCamRecoveryModal = function(){
  const m = byId('camRecoveryModal');
  if (!m) return;
  m.classList.add('hidden');
};

function _switchCamRecoveryTab(tabId){
  const m = byId('camRecoveryModal');
  if (!m) return;
  m.querySelectorAll('.cam-recovery-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tabId);
  });
  m.querySelectorAll('.cam-recovery-tab-content').forEach(c => {
    c.hidden = (c.id !== tabId);
  });
}

async function loadCamRecoveryBackups(){
  const wrap = byId('camRecoveryBackupList');
  if (!wrap) return;
  wrap.innerHTML = `<div class="muted small">Lade Sicherungen…</div>`;
  let items = [];
  try {
    const d = await apiGet(`/api/settings/backups?cam_id=${encodeURIComponent(panelState.camId)}`);
    items = d.items || [];
  } catch (e){
    wrap.innerHTML = `<div class="cam-recovery-empty">Sicherungen nicht abrufbar (${esc(String(e))}).</div>`;
    return;
  }
  if (!items.length){
    wrap.innerHTML = `<div class="cam-recovery-empty">Noch keine Sicherungen vorhanden. Sicherungen werden ab dem nächsten Speichern automatisch angelegt — solange ist nur die Auto-Erkennung verfügbar.</div>`;
    return;
  }
  wrap.innerHTML = items.map(it => {
    const dt = it.mtime_iso ? it.mtime_iso.replace('T', ' ').slice(0, 16) : '?';
    const sizeKb = (it.size / 1024).toFixed(1);
    let usable = '', btn = '';
    if (!it.has_cam){
      usable = `<span class="cam-recovery-tag cam-recovery-tag--off">Kamera nicht enthalten</span>`;
    } else if (!it.has_connection){
      usable = `<span class="cam-recovery-tag cam-recovery-tag--off">Verbindungsfelder leer</span>`;
    } else {
      usable = `<span class="cam-recovery-tag cam-recovery-tag--on">Verbindung gespeichert</span>`;
      btn = `<button type="button" class="btn-action" onclick="applyCamRecoveryBackup('${esc(it.filename)}')">Übernehmen</button>`;
    }
    return `<div class="cam-recovery-row">
      <div class="cam-recovery-row-meta">
        <div class="cam-recovery-row-title">${esc(it.filename)}</div>
        <div class="cam-recovery-row-sub">${dt} · ${it.n_cameras} Kameras · ${sizeKb} KB</div>
      </div>
      <div class="cam-recovery-row-actions">${usable}${btn}</div>
    </div>`;
  }).join('');
}

window.applyCamRecoveryBackup = async function(filename){
  const camId = panelState.camId;
  if (!camId) return;
  try {
    const d = await apiPost(`/api/settings/cameras/${encodeURIComponent(camId)}/restore-connection`, { filename });
    if (!d?.ok){
      showToast(`Wiederherstellen fehlgeschlagen: ${d?.error || 'Fehler'}`, 'error');
      return;
    }
    showToast(`Verbindung aus ${filename} wiederhergestellt — Kamera startet neu`, 'success');
    window.closeCamRecoveryModal();
    // Refresh state + re-open the edit panel so the user sees the restored fields.
    if (typeof window.loadAll === 'function') await window.loadAll();
    if (panelState.camId === camId) _closeEditPanel();
    // _whenFormReady polls until #rtspPathSelect appears (or gives up
    // after 1 s) so editCamera never races with the post-loadAll
    // render cycle. The previous setTimeout(...,250) was a guess that
    // sometimes triggered the lock cascade via initRtspBuilder's
    // TypeError path.
    _whenFormReady(() => {
      if (typeof window.editCamera === 'function') window.editCamera(camId);
    });
  } catch (e){
    showToast(`Wiederherstellen fehlgeschlagen: ${String(e)}`, 'error');
  }
};

// Defer a callback until the cam-edit form is rendered into the DOM —
// detected by the presence of #rtspPathSelect, which is the deepest
// element editCamera's hydration touches first. Caps at 20 attempts ×
// 50 ms = 1 s so a stuck render never leaves the recovery flow
// silently waiting forever; the next manual click retries.
function _whenFormReady(callback, attempts = 20){
  if (byId('rtspPathSelect')){
    callback();
    return;
  }
  if (attempts <= 0) return;
  requestAnimationFrame(() => {
    setTimeout(() => _whenFormReady(callback, attempts - 1), 50);
  });
}

window.loadCamRecoveryDiscovery = async function(){
  const wrap = byId('camRecoveryDiscoveryList');
  const status = byId('camRecoveryDiscoverStatus');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (status) status.textContent = 'Scanne Subnetz…';
  let items = [];
  try {
    const d = await apiGet('/api/discover');
    items = d.devices || [];
  } catch {
    if (status) status.textContent = 'Scan fehlgeschlagen';
    return;
  }
  if (status) status.textContent = `${items.length} Geräte gefunden`;
  if (!items.length){
    wrap.innerHTML = `<div class="cam-recovery-empty">Keine Geräte im Subnetz erkannt.</div>`;
    return;
  }
  wrap.innerHTML = items.map((d, idx) => {
    const guess = d.guess || 'Unknown';
    const host = d.hostname ? ` · ${esc(d.hostname)}` : '';
    const ports = (d.open_ports || []).join(', ') || '—';
    const path = d.reolink_hints?.suggested_path || '';
    const canApply = !!path;
    const btn = canApply
      ? `<button type="button" class="btn-action" onclick="applyCamRecoveryDiscovery(${idx})">In Formular übernehmen</button>`
      : `<span class="cam-recovery-tag cam-recovery-tag--off">Kein RTSP-Pfad erkannt</span>`;
    return `<div class="cam-recovery-row" data-idx="${idx}">
      <div class="cam-recovery-row-meta">
        <div class="cam-recovery-row-title">${esc(d.ip)} · ${esc(guess)}${host}</div>
        <div class="cam-recovery-row-sub">Ports ${esc(ports)}${path ? ` · Pfad ${esc(path)}` : ''}</div>
      </div>
      <div class="cam-recovery-row-actions">${btn}</div>
    </div>`;
  }).join('');
  // Cache the device list so the apply handler can find it without re-fetching.
  byId('camRecoveryModal').__discoveryCache = items;
};

window.applyCamRecoveryDiscovery = function(idx){
  const cache = (byId('camRecoveryModal') || {}).__discoveryCache || [];
  const d = cache[idx];
  if (!d) return;
  const f = byId('cameraForm').elements;
  if (f['rtsp_ip']) f['rtsp_ip'].value = d.ip || '';
  const path = d.reolink_hints?.suggested_path || '';
  if (path && f['rtsp_path']){
    // The select holds canonical Reolink paths; pick the option whose value
    // matches, otherwise leave the existing default alone.
    const opt = Array.from(f['rtsp_path'].options).find(o => o.value === path);
    if (opt) f['rtsp_path'].value = opt.value;
  }
  // Nudge the existing rtsp_url builder by dispatching an input event on
  // any of the fields it listens to — that rebuild closure is private to
  // initRtspBuilder so we trigger it via the DOM rather than calling it.
  if (f['rtsp_ip']) f['rtsp_ip'].dispatchEvent(new Event('input', { bubbles: true }));
  window.closeCamRecoveryModal();
  showToast(`IP ${d.ip} übernommen — bitte Benutzer & Passwort ergänzen, dann speichern`, 'success');
};

// Pulls /api/camera/:id/status and paints the diagnostics tile.
// Auto-opens the disclosure on problem signals; collapsed otherwise.
export async function _loadCamDiagnostics(camId){
  const panel = byId('camDiagnostics');
  if (!panel) return;
  panel.style.display = 'none';
  try {
    const s = await j(`/api/camera/${encodeURIComponent(camId)}/status`);
    if (!s || s.ok === false) return;
    const ageEl = byId('diagFrameAge');
    if (ageEl){
      const age = s.frame_age_s;
      if (age == null){ ageEl.textContent = '—'; ageEl.className = 'cam-diag-val'; }
      else if (age < 5){ ageEl.textContent = age.toFixed(1) + 's'; ageEl.className = 'cam-diag-val ok'; }
      else if (age < 30){ ageEl.textContent = age.toFixed(1) + 's'; ageEl.className = 'cam-diag-val warn'; }
      else { ageEl.textContent = age.toFixed(1) + 's'; ageEl.className = 'cam-diag-val bad'; }
    }
    const rcEl = byId('diagReconnects');
    if (rcEl){
      const rc = s.reconnect_count || 0;
      rcEl.textContent = rc;
      rcEl.className = 'cam-diag-val ' + (rc === 0 ? 'ok' : rc < 5 ? 'warn' : 'bad');
    }
    const stEl = byId('diagStale');
    if (stEl){
      const st = s.stale_incidents || 0;
      stEl.textContent = st;
      stEl.className = 'cam-diag-val ' + (st === 0 ? 'ok' : st < 10 ? 'warn' : 'bad');
    }
    const esEl = byId('diagErrorStreak');
    if (esEl){
      const es = s.error_streak || 0;
      esEl.textContent = es;
      esEl.className = 'cam-diag-val ' + (es === 0 ? 'ok' : es < 5 ? 'warn' : 'bad');
    }
    const ssEl = byId('diagStaleStreak');
    if (ssEl){
      const ss = s.stale_streak || 0;
      ssEl.textContent = ss;
      ssEl.className = 'cam-diag-val ' + (ss === 0 ? 'ok' : ss < 5 ? 'warn' : 'bad');
    }
    const fpsDiagEl = byId('diagPreviewFps');
    if (fpsDiagEl){
      const pfps = s.preview_fps || 0;
      fpsDiagEl.textContent = pfps > 0 ? pfps + ' fps' : '—';
      fpsDiagEl.className = 'cam-diag-val ' + (pfps >= 8 ? 'ok' : pfps >= 2 ? 'warn' : '');
    }
    const modeEl = byId('diagStreamMode');
    if (modeEl){
      const mode = s.stream_mode || 'baseline';
      modeEl.textContent = mode === 'live' ? 'Live' : 'Vorschau';
      modeEl.className = 'cam-diag-val ' + (mode === 'live' ? 'ok' : '');
    }
    const viewEl = byId('diagLiveViewers');
    if (viewEl){
      const v = s.live_viewers || 0;
      viewEl.textContent = v;
      viewEl.className = 'cam-diag-val ' + (v > 0 ? 'ok' : '');
    }
    const errEl = byId('diagLastError');
    if (errEl){
      if (s.last_error){ errEl.textContent = s.last_error; errEl.style.display = ''; }
      else errEl.style.display = 'none';
    }
    // Compute collapsible summary + auto-open on problems.
    const reconnects = s.reconnect_count || 0;
    const errStreak = s.error_streak || 0;
    const hasErr = !!s.last_error;
    const problem = errStreak > 0 || reconnects > 5 || hasErr;
    const sumEl = byId('camDiagSummary');
    if (sumEl){
      sumEl.textContent = problem
        ? `${reconnects} Reconnects · ${errStreak} Fehler${hasErr ? ' · Stream-Fehler' : ''}`
        : 'Verbindung stabil';
    }
    panel.dataset.problem = problem ? '1' : '0';
    panel.classList.toggle('open', problem);
    panel.style.display = '';
  } catch { /* no diagnostics available — stay hidden */ }
}

// Inline onclick="_toggleCamDiag()" in the cam-edit form's
// diagnostics disclosure header.
window._toggleCamDiag = function(){
  const panel = byId('camDiagnostics');
  if (!panel) return;
  panel.classList.toggle('open');
};

// Drives the Verbindungs-Warn-LED on the tab-bar button + the field-
// level highlights on the four connection inputs. Called from the
// rtsp builder's rebuild() closure on every input — keep it cheap.
export function _refreshConnectionWarn(){
  const indicator = byId('camTabRecoveryBtn');
  if (!indicator) return;
  const f = byId('cameraForm')?.elements;
  if (!f){
    indicator.classList.remove('is-warn', 'is-pulsing');
    return;
  }
  // Resolve the effective rtsp_url. Order:
  //   (a) the unmasked real value (set by initRtspBuilder.setMaskable),
  //   (b) the visible field value,
  //   (c) a synthesised URL built from the parts (mirrors rebuild()
  //       in initRtspBuilder so a half-typed form behaves consistently),
  //   (d) "".
  const rawReal = f['rtsp_url']?.dataset?.real;
  const rawVis = f['rtsp_url']?.value;
  const ip   = (f['rtsp_ip']?.value || '').trim();
  const user = (f['rtsp_user']?.value || '').trim();
  const pass = (f['rtsp_pass']?.value || '').trim();
  const port = (f['rtsp_port']?.value || '554').trim();
  const path = f['rtsp_path']?.value || '';
  let effective = '';
  if (rawReal && rawReal.trim()) effective = rawReal.trim();
  else if (rawVis && rawVis.trim()) effective = rawVis.trim();
  else if (ip){
    const auth = user ? (user + (pass ? ':' + _rtspEnc(pass) : '') + '@') : '';
    const portPart = (port && port !== '554') ? ':' + port : '';
    effective = `rtsp://${auth}${ip}${portPart}${path}`;
  }
  let parsed = {};
  if (effective){
    try { parsed = parseRtspUrl(effective) || {}; } catch { parsed = {}; }
  }
  const hasHost  = !!(parsed.host && parsed.host.trim()) || !!ip;
  const hasCreds = !!(parsed.user && parsed.user.trim()) || !!user;
  const warn = !hasHost || !hasCreds;
  if (warn){
    if (!indicator.classList.contains('is-warn')){
      indicator.classList.add('is-warn', 'is-pulsing');
      // Pulse runs 4 iterations (~5.6s) then stays solid; strip the
      // pulse class so the box-shadow animation doesn't loop forever.
      setTimeout(() => indicator.classList.remove('is-pulsing'), 5600);
    }
    indicator.setAttribute('title',
      'Verbindungsdaten unvollständig — klicken zum Wiederherstellen');
  } else {
    indicator.classList.remove('is-warn', 'is-pulsing');
    indicator.setAttribute('title', 'Verbindung wiederherstellen');
  }
  // Field-level highlights — only when the indicator is in WARN mode,
  // and only on the specific wraps that are missing input.
  const setWarn = (input, on) => {
    const wrap = input?.closest?.('.field-wrap');
    if (!wrap) return;
    wrap.classList.toggle('cam-field-warn', !!on);
  };
  setWarn(f['rtsp_ip'],   warn && !hasHost);
  setWarn(f['rtsp_user'], warn && !hasCreds);
  setWarn(f['rtsp_pass'], warn && !hasCreds);
}

// rtsp.js's rebuild() looks up _refreshConnectionWarn via window
// because the two files have a bidirectional reference (rtsp imports
// _rtspEnc + parseRtspUrl from this file, this file imports them too
// for the synthesised-URL fallback above). Bridging on window keeps
// the cycle tractable until both move to a shared root.
window._refreshConnectionWarn = _refreshConnectionWarn;
