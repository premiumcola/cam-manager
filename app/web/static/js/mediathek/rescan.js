// ─── mediathek/rescan.js ───────────────────────────────────────────────────
// Stage 13 of the legacy.js → ES modules refactor — the
// "Mediathek erneut scannen" button + the longer-running
// "Thumbnails neu erzeugen" pipeline with its progress bar. Both fire
// /api/media/* endpoints; the thumbnail flow polls a status endpoint
// at 1.5 s tick and renders a sticky bottom bar with done/total + a
// per-file detail log.
import { byId } from '../core/dom.js';
import { j, apiGet, apiPost } from '../core/api.js';
import { showToast } from '../core/toast.js';
import { loadMediaStorageStats } from '../chrome/storage-stats.js';
import { state } from '../core/state.js';

byId('rescanMediaBtn')?.addEventListener('click', async () => {
  const btn = byId('rescanMediaBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('scanning');
  try {
    const r = await j('/api/media/rescan', { method: 'POST' });
    showToast(`Scan abgeschlossen: ${r.registered || 0} neue Medien registriert.`, 'success');
    if (typeof window.loadAll === 'function') await window.loadAll();
  } catch (e){
    showToast('Fehler beim Scan: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.classList.remove('scanning');
  }
});

let _fixThumbsPoll = null;
let _fixThumbsLastDone = -1;
let _shownThumbFiles = new Set();

function _showFixThumbsBar(done, total, finalMsg){
  let bar = byId('fixThumbsBar');
  if (!bar){
    bar = document.createElement('div');
    bar.id = 'fixThumbsBar';
    bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:500;background:var(--panel);border-top:1px solid rgba(255,255,255,.08);font-size:13px;color:var(--text)';
    bar.innerHTML = `
      <div id="ftp-prog-line" style="height:3px;background:var(--accent);width:0%;transition:width .3s ease"></div>
      <div style="display:flex;align-items:center;gap:10px;padding:10px 16px">
        <span id="ftp-icon" style="font-size:16px;animation:spin 1.2s linear infinite;display:inline-block">⚙</span>
        <span id="ftp-label" style="flex:1">Thumbnails werden erzeugt…</span>
        <button onclick="(function(){const d=byId('ftp-details');if(d)d.style.display=d.style.display==='none'?'block':'none';})()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:12px;padding:4px 8px;border-radius:6px">▲ Details</button>
        <button onclick="document.getElementById('fixThumbsBar').remove()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;line-height:1;padding:4px 8px">✕</button>
      </div>
      <div id="ftp-details" style="display:none;padding:0 16px 10px;max-height:260px;overflow-y:auto;font-family:monospace;font-size:11px;color:var(--muted)"></div>`;
    document.body.appendChild(bar);
  }
  const pct = total > 0 ? (done / total) * 100 : 0;
  const prog = byId('ftp-prog-line');
  const lbl = byId('ftp-label');
  const icon = byId('ftp-icon');
  if (prog) prog.style.width = pct + '%';
  if (finalMsg){
    if (lbl) lbl.textContent = finalMsg;
    if (icon){ icon.textContent = '✓'; icon.style.animation = 'none'; icon.style.color = 'var(--good)'; }
    if (prog) prog.style.background = 'var(--good)';
    return;
  }
  if (lbl) lbl.textContent = `Thumbnails werden erzeugt: ${done} / ${total}`;
}

function _hideFixThumbsBar(){
  const bar = byId('fixThumbsBar');
  if (bar) bar.remove();
}

function _startFixThumbsPoll(){
  if (_fixThumbsPoll) clearInterval(_fixThumbsPoll);
  _fixThumbsLastDone = -1;
  _fixThumbsPoll = setInterval(async () => {
    try {
      const s = await j('/api/media/fix-thumbnails/status');
      _showFixThumbsBar(s.done || 0, s.total || 0);
      // Append per-filename log lines for any newly completed files.
      const det = byId('ftp-details');
      if (det && Array.isArray(s.recent)){
        s.recent.forEach(fname => {
          if (_shownThumbFiles.has(fname)) return;
          _shownThumbFiles.add(fname);
          const line = document.createElement('div');
          line.style.cssText = 'padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04);white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
          line.textContent = '✓ ' + fname;
          det.appendChild(line);
          det.scrollTop = det.scrollHeight;
        });
      }
      _fixThumbsLastDone = s.done || 0;
      if (!s.running){
        clearInterval(_fixThumbsPoll);
        _fixThumbsPoll = null;
        const done = s.done || 0, errs = s.errors || 0;
        const msg = errs > 0 ? `✓ ${done - errs} Thumbnails erzeugt, ${errs} Fehler` : `✓ ${done} Thumbnails erzeugt`;
        _showFixThumbsBar(done, s.total || 0, msg);
        setTimeout(_hideFixThumbsBar, 12000);
        try {
          if (typeof window.renderMediaGrid === 'function') window.renderMediaGrid();
        } catch {}
        // Newly-generated thumbnails may also have surfaced previously
        // unscanned media — refresh overview chips + size badges.
        loadMediaStorageStats();
      }
    } catch { /* transient — keep polling */ }
  }, 1500);
}

byId('fixThumbsBtn')?.addEventListener('click', async () => {
  const btn = byId('fixThumbsBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('scanning');
  _shownThumbFiles = new Set();
  try {
    const r = await j('/api/media/fix-thumbnails', { method: 'POST' });
    if (!r.ok){
      showToast('Thumbnail-Erzeugung: ' + (r.error || 'Fehler'), 'error');
      return;
    }
    if ((r.total || 0) === 0 && !r.already_running){
      _showFixThumbsBar(0, 0, '✓ Alle Thumbnails vorhanden');
      setTimeout(_hideFixThumbsBar, 12000);
    } else {
      _showFixThumbsBar(r.done || 0, r.total || 0);
      _startFixThumbsPoll();
    }
  } catch (e){
    showToast('Fehler: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.classList.remove('scanning');
  }
});

// ── Bulk track-reindex ─────────────────────────────────────────────────────
// Posts to /api/tracking/reindex-all (?camera_id=… when a single-camera
// drilldown is open), then polls /api/tracking/status until queued reaches
// 0 or 60 s elapse. Mirrors the worker stance: live progress visible, never
// blocks the UI, and reports "worker not alive" cleanly when the singleton
// hasn't booted (e.g. detection mode = none).
function _camDisplayName(camId){
  const c = (state.cameras || []).find(x => (x.id || '') === camId);
  return c?.name || camId;
}

byId('reindexTrackingBtn')?.addEventListener('click', async () => {
  const btn = byId('reindexTrackingBtn');
  if (btn.disabled) return;
  const camId = state.mediaCamera || null;
  const scopeLabel = camId ? _camDisplayName(camId) : 'alle Kameras';
  btn.disabled = true;
  btn.classList.add('scanning');
  try {
    const url = '/api/tracking/reindex-all'
      + (camId ? `?camera_id=${encodeURIComponent(camId)}` : '');
    let d;
    try {
      d = await apiPost(url);
    } catch (e) {
      showToast('Tracking-Re-Index: ' + (e.message || 'Fehler'), 'error');
      return;
    }
    if (!d?.ok) {
      showToast('Tracking-Re-Index: ' + (d?.error || 'Fehler'), 'error');
      return;
    }
    const queued = d.queued || 0;
    if (queued === 0){
      showToast(`Tracking aktuell — ${scopeLabel} schon indiziert`, 'success');
      return;
    }
    showToast(`${queued} Clip${queued === 1 ? '' : 's'} werden indiziert (${scopeLabel}) …`, 'info');
    // Poll /api/tracking/status every 3 s up to 60 s, edging the toast
    // text down toward 0. Stop on first zero or on worker-down.
    const t0 = Date.now();
    const tick = async () => {
      if (Date.now() - t0 > 60_000) return;  // hand off to background
      let s;
      try { s = await apiGet('/api/tracking/status'); }
      catch { s = null; }
      if (!s || !s.alive){
        showToast('Tracking-Worker nicht erreichbar', 'error');
        return;
      }
      const q = s.queued || 0;
      if (q <= 0){
        showToast(`Tracking abgeschlossen — ${scopeLabel}`, 'success');
        return;
      }
      showToast(`Tracking läuft … noch ${q} in der Queue`, 'info');
      setTimeout(tick, 3000);
    };
    setTimeout(tick, 3000);
  } catch (e){
    showToast('Tracking-Re-Index fehlgeschlagen: ' + (e.message || e), 'error');
  } finally {
    btn.disabled = false;
    btn.classList.remove('scanning');
  }
});
