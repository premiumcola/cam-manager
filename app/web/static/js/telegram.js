// ─── telegram.js ───────────────────────────────────────────────────────────
// Stage 12 of the legacy.js → ES modules refactor — Telegram tab
// hydrate + tab-bar wiring + format preview + form submit + test
// button. Push settings live in a sibling module (push.js); they
// share the settings.telegram subtree on the server.
import { byId, esc } from './core/dom.js';
import { state } from './core/state.js';
import { showToast } from './core/toast.js';

let _tgPollStatusTimer = null;

export function hydrateTelegram(){
  const tg = state.config?.telegram || {};
  const el = byId('tg_enabled');
  if (el) el.checked = !!tg.enabled;
  // Initial badge from config — immediately overwritten by the live
  // polling status fetch below, so the user sees the actual updater
  // state, not just the "enabled" flag.
  const tgBadge = byId('tgStatusBadge');
  if (tgBadge){
    tgBadge.textContent = tg.enabled ? 'aktiv' : 'aus';
    tgBadge.className = 'set-status-badge ' + (tg.enabled ? 'set-status-badge--on' : 'set-status-badge--off');
  }
  const tok = byId('tg_token');   if (tok) tok.value = tg.token   || '';
  const cid = byId('tg_chat_id'); if (cid) cid.value = tg.chat_id || '';
  const fmt = tg.format || 'photo';
  document.querySelectorAll('[name="tg_format"]').forEach(r => r.checked = r.value === fmt);
  renderTgFormatPreview(fmt);
  refreshTelegramPollingStatus();
}

async function refreshTelegramPollingStatus(){
  const badge = byId('tgStatusBadge');
  if (!badge) return;
  try {
    const r = await fetch('/api/telegram/status');
    const d = await r.json();
    const s = d.state || 'off';
    if (s === 'active'){
      const mins = Math.floor((d.since_seconds || 0) / 60);
      const lbl = mins > 0 ? `aktiv (seit ${mins} min)` : 'aktiv';
      badge.textContent = lbl;
      badge.className = 'set-status-badge set-status-badge--on';
    } else if (s === 'conflict'){
      badge.textContent = 'Conflict (Backoff)';
      badge.className = 'set-status-badge set-status-badge--warn';
    } else if (s === 'starting'){
      badge.textContent = 'startet…';
      badge.className = 'set-status-badge set-status-badge--warn';
    } else {
      badge.textContent = d.enabled ? 'aus' : 'aus';
      badge.className = 'set-status-badge set-status-badge--off';
    }
  } catch { /* leave the existing badge alone on transient fetch errors */ }
  clearTimeout(_tgPollStatusTimer);
  _tgPollStatusTimer = setTimeout(refreshTelegramPollingStatus, 10000);
}

export function initTelegramTabs(){
  const bar = document.querySelector('.tg-tab-bar');
  if (!bar) return;
  const allPanels = ['tg-panel-verbindung', 'tg-panel-wann', 'tg-panel-was', 'tg-panel-tree', 'tg-panel-presets'];
  bar.querySelectorAll('.set-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      bar.querySelectorAll('.set-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.tab;
      allPanels.forEach(id => {
        const p = byId(id);
        if (p) p.hidden = (id !== target);
      });
    });
  });
}

export function renderTgFormatPreview(fmt){
  const preview = byId('tgFormatPreview');
  if (!preview) return;
  const cam = state.cameras?.[0];
  const ts = new Date().toLocaleString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  let html = `<div class="tg-bubble">
    <div class="tg-bubble-meta">🚨 motion, person · 📷 ${esc(cam?.name || 'Kamera')} · 📍 Einfahrt · 🕒 ${ts}</div>`;
  if (fmt === 'photo' || fmt === 'video'){
    const snap = cam?.snapshot_url || '';
    html += `<div class="tg-bubble-img">${snap ? `<img src="${esc(snap)}" alt="snapshot"/>` : '<div class="tg-bubble-img-ph">📷 Snapshot</div>'}</div>`;
  }
  if (fmt === 'video') html += `<div class="tg-bubble-vid">🎬 Video-Clip angehängt (wenn verfügbar)</div>`;
  html += `<div class="tg-bubble-btns">[ 📷 Live ] [ 🎥 Clip ] [ 🖥 Dashboard ]</div></div>`;
  preview.innerHTML = html;
}

// One-time wiring for the Verbindung-tab form, the format-radio
// previews, the explicit save-format button, and the test-message
// button (was in its own section before this stage).
byId('telegramForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  const existingToken = state.config?.telegram?.token || '';
  const token = byId('tg_token')?.value || existingToken;
  const payload = { telegram: {
    enabled: !!byId('tg_enabled')?.checked,
    token,
    chat_id: byId('tg_chat_id')?.value || '',
    format: (state.config?.telegram || {}).format || 'photo',
  }};
  await fetch('/api/settings/app', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  showToast('Telegram-Verbindung gespeichert.', 'success');
  if (typeof window.loadAll === 'function') await window.loadAll();
});

document.querySelectorAll('[name="tg_format"]').forEach(r => {
  r.addEventListener('change', () => renderTgFormatPreview(r.value));
});

byId('saveTgFormatBtn')?.addEventListener('click', async () => {
  const fmt = [...document.querySelectorAll('[name="tg_format"]')].find(r => r.checked)?.value || 'photo';
  const existing = state.config?.telegram || {};
  const payload = { telegram: { ...existing, format: fmt } };
  await fetch('/api/settings/app', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  showToast('Format gespeichert.', 'success');
  if (typeof window.loadAll === 'function') await window.loadAll();
});

byId('telegramTestBtn')?.addEventListener('click', async () => {
  const btn = byId('telegramTestBtn');
  const res = byId('telegramTestResult');
  btn.disabled = true; btn.textContent = 'Sende …';
  if (res){ res.style.display = 'inline'; res.style.color = 'var(--muted)'; res.textContent = '...'; }
  try {
    const r = await fetch('/api/telegram/test', { method: 'POST' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || 'Fehler');
    if (res){ res.style.color = 'var(--good)'; res.textContent = '✓ Gesendet'; }
  } catch (e){
    let msg = 'Fehler';
    try { msg = JSON.parse(e.message)?.error || e.message; } catch {}
    if (res){ res.style.color = 'var(--danger)'; res.textContent = '✗ ' + msg; }
  } finally {
    btn.disabled = false; btn.textContent = '📨 Testnachricht senden';
    if (res) setTimeout(() => { res.style.display = 'none'; }, 6000);
  }
});
