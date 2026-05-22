// ─── mediathek/trash-modal.js ──────────────────────────────────────────────
// Papierkorb UI — modal listing /api/trash entries with restore +
// hard-delete + empty-all actions. Backend (routes/trash.py) was
// already in place; this module is pure frontend wiring.
//
// Opened by clicking the trash button in the Mediathek header
// (mediathek.html: button#mediathekTrashBtn with
// data-action="open-trash"). The router/main wiring delegates that
// click to openTrashModal() exported below.
//
// The modal builds itself lazily on first open. Subsequent opens
// reuse the same DOM tree and just re-fetch + re-render the body.
import { byId, esc } from '../core/dom.js';
import { j } from '../core/api.js';
import { showToast, showConfirm } from '../core/toast.js';
import { refreshTimelineAndStats } from '../chrome/storage-stats.js';

const _TRASH_ICON_SVG = `<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3,6 5,6 21,6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;

function _fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('de-DE', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

function _expiryLabel(days) {
  if (days == null) return '';
  if (days === 0) return 'Läuft heute ab';
  if (days === 1) return 'Läuft morgen ab';
  return `Noch ${days} Tage`;
}

function _ensureModal() {
  let modal = byId('trashModal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'trashModal';
  modal.className = 'trash-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'trashModalTitle');
  modal.innerHTML = `
    <div class="trash-modal__backdrop" data-action="close"></div>
    <div class="trash-modal__shell">
      <div class="trash-modal__head">
        <div class="trash-modal__title" id="trashModalTitle">Papierkorb</div>
        <button type="button" class="trash-modal__close" data-action="close" aria-label="Schließen">✕</button>
      </div>
      <div class="trash-modal__body" id="trashModalBody"></div>
      <div class="trash-modal__foot" id="trashModalFoot"></div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'close') closeTrashModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) closeTrashModal();
  });
  return modal;
}

function _renderEmpty(body, foot) {
  body.innerHTML = `
    <div class="trash-modal__empty">
      ${_TRASH_ICON_SVG}
      <div>Papierkorb ist leer</div>
    </div>`;
  foot.innerHTML = '';
}

function _renderRows(body, foot, items) {
  body.innerHTML = items
    .map(
      (it) => `
    <div class="trash-row" data-event-id="${esc(it.event_id || '')}">
      <div class="trash-row__info">
        <div class="trash-row__name">${esc(it.event_id || '?')}</div>
        <div class="trash-row__meta">${esc(it.cam_id || '—')} · gelöscht ${_fmtDate(it.trashed_at)}</div>
        <div class="trash-row__expiry">${esc(_expiryLabel(it.days_left))}</div>
      </div>
      <div class="trash-row__actions">
        <button type="button" class="trash-row__btn trash-row__btn--restore" data-action="restore">Wiederherstellen</button>
        <button type="button" class="trash-row__btn trash-row__btn--delete" data-action="delete-now">Endgültig löschen</button>
      </div>
    </div>`,
    )
    .join('');
  foot.innerHTML = `
    <button type="button" class="trash-modal__empty-all" data-action="empty-all">
      Papierkorb leeren (${items.length})
    </button>`;
}

async function _refresh() {
  const body = byId('trashModalBody');
  const foot = byId('trashModalFoot');
  if (!body || !foot) return;
  body.innerHTML = '<div class="trash-modal__empty">Lade …</div>';
  foot.innerHTML = '';
  try {
    const r = await j('/api/trash');
    const items = r.items || [];
    if (items.length === 0) {
      _renderEmpty(body, foot);
      return;
    }
    _renderRows(body, foot, items);
  } catch (e) {
    body.innerHTML = `<div class="trash-modal__empty">Fehler: ${esc(e.message)}</div>`;
  }
}

async function _onRowAction(action, eventId) {
  if (action === 'restore') {
    try {
      await j(`/api/trash/${encodeURIComponent(eventId)}/restore`, { method: 'POST' });
      showToast('Wiederhergestellt', 'success');
      await Promise.all([_refresh(), refreshTimelineAndStats()]);
    } catch (e) {
      showToast('Wiederherstellen fehlgeschlagen: ' + e.message, 'error');
    }
    return;
  }
  if (action === 'delete-now') {
    if (
      !(await showConfirm(
        'Eintrag endgültig löschen? Diese Aktion kann nicht rückgängig gemacht werden.',
      ))
    ) {
      return;
    }
    try {
      await j(`/api/trash/${encodeURIComponent(eventId)}/delete-now`, { method: 'POST' });
      showToast('Endgültig gelöscht', 'success');
      await _refresh();
    } catch (e) {
      showToast('Löschen fehlgeschlagen: ' + e.message, 'error');
    }
    return;
  }
}

async function _onEmptyAll() {
  const body = byId('trashModalBody');
  const rows = body ? body.querySelectorAll('.trash-row').length : 0;
  if (!rows) return;
  if (
    !(await showConfirm(
      `Papierkorb endgültig leeren? ${rows} Einträge werden gelöscht. ` +
        `Aktion kann nicht rückgängig gemacht werden.`,
    ))
  ) {
    return;
  }
  try {
    const r = await j('/api/trash/empty', { method: 'POST' });
    showToast(`${r.removed || 0} Einträge entfernt`, 'success');
    await _refresh();
  } catch (e) {
    showToast('Leeren fehlgeschlagen: ' + e.message, 'error');
  }
}

export async function openTrashModal() {
  const modal = _ensureModal();
  // Bind row + foot action handlers ONCE per modal lifetime; the
  // body re-renders frequently but the wrapping shell stays.
  if (!modal._trashWired) {
    const body = modal.querySelector('.trash-modal__body');
    const foot = modal.querySelector('.trash-modal__foot');
    body.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const row = btn.closest('.trash-row');
      const eventId = row?.dataset.eventId;
      if (!eventId) return;
      _onRowAction(btn.dataset.action, eventId);
    });
    foot.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'empty-all') _onEmptyAll();
    });
    modal._trashWired = true;
  }
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  await _refresh();
}

export function closeTrashModal() {
  const modal = byId('trashModal');
  if (!modal) return;
  modal.classList.remove('open');
  document.body.style.overflow = '';
}

// Wire the Mediathek-header trash button. Delegated via data-action
// so the click survives any future template re-render.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action="open-trash"]');
  if (btn) {
    e.preventDefault();
    openTrashModal();
  }
});

window.openTrashModal = openTrashModal;
window.closeTrashModal = closeTrashModal;
