// ─── camera-merge.js ───────────────────────────────────────────────────────
// Stage 6 of the legacy.js → ES modules refactor — the "Zusammenführen"
// modal that lives behind the Verbinden + offline-camera flow. Self-
// contained: opens a target-picker modal, lets the user pick an active
// camera to merge media into, fires the backend merge endpoint, closes.
import { state } from './core/state.js';
import { byId, esc } from './core/dom.js';
import { j } from './core/api.js';
import { getCameraIcon } from './core/icons.js';
import { showToast } from './core/toast.js';

let _mergeSource = null;
let _mergeTarget = null;

export function openMergeModal(sourceId, sourceName) {
  _mergeSource = { id: sourceId, name: sourceName };
  _mergeTarget = null;
  // Active cameras only — merging into an offline replacement makes no sense.
  const targets = (state.cameras || []).filter(c => c.id !== sourceId && c.status === 'active');
  byId('mergeIntro').innerHTML = `Medien von <strong>${esc(sourceName)}</strong> werden in die gewählte Ziel-Kamera verschoben. Der Eintrag <strong>${esc(sourceName)}</strong> wird danach gelöscht.`;
  const list = byId('mergeTargets');
  if (!targets.length) {
    list.innerHTML = '<div class="item muted" style="padding:12px">Keine aktive Ziel-Kamera verfügbar.</div>';
  } else {
    // Inline onclick="…('${esc(name)}')" breaks on names containing single
    // quotes (e.g. "Squirrel Town 'Nut Bar'"). Switched to data-attributes
    // + a delegated listener on #mergeTargets — safe for any character.
    list.innerHTML = targets.map(c => `
      <div class="item merge-target-item" data-tgt-id="${esc(c.id)}" data-tgt-name="${esc(c.name)}" style="cursor:pointer;display:flex;align-items:center;gap:10px;padding:10px 12px">
        <span style="font-size:18px">${getCameraIcon(c.name)}</span>
        <div style="flex:1">
          <div style="font-weight:600">${esc(c.name)}</div>
          <div class="small muted">${esc(c.id)}</div>
        </div>
        <span class="merge-target-radio" style="width:16px;height:16px;border-radius:50%;border:2px solid var(--muted);flex-shrink:0"></span>
      </div>`).join('');
  }
  byId('mergeWarning').style.display = 'none';
  const btn = byId('mergeConfirmBtn');
  btn.disabled = true; btn.style.opacity = '.5'; btn.textContent = 'Zusammenführen';
  byId('mergeModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

export function _selectMergeTarget(id, name) {
  _mergeTarget = { id, name };
  document.querySelectorAll('.merge-target-item').forEach(el => {
    const sel = el.dataset.tgtId === id;
    el.classList.toggle('selected', sel);
    const dot = el.querySelector('.merge-target-radio');
    if (dot) {
      dot.style.borderColor = sel ? 'var(--accent)' : 'var(--muted)';
      dot.style.background = sel ? 'var(--accent)' : 'transparent';
    }
    el.style.background = sel ? 'rgba(59,130,246,.08)' : '';
  });
  const w = byId('mergeWarning');
  w.style.display = 'block';
  w.innerHTML = `Die Aktion verschiebt alle Medien von <strong>${esc(_mergeSource.name)}</strong> nach <strong>${esc(name)}</strong> und entfernt anschließend den Eintrag <strong>${esc(_mergeSource.name)}</strong> aus der Konfiguration. Sie kann nicht rückgängig gemacht werden.`;
  const btn = byId('mergeConfirmBtn');
  btn.disabled = false; btn.style.opacity = '1';
}

export function closeMergeModal() {
  byId('mergeModal').classList.add('hidden');
  document.body.style.overflow = '';
  _mergeSource = null; _mergeTarget = null;
}

// One-time wiring for the modal — close button, cancel button,
// click-outside dismissal, delegated target picker, confirm with two-
// step arming. bindMergeModal() is called from main.js once at boot.
export function bindMergeModal() {
  byId('closeMergeBtn')?.addEventListener('click', closeMergeModal);
  byId('mergeCancelBtn')?.addEventListener('click', closeMergeModal);
  byId('mergeModal')?.addEventListener('click', e => { if (e.target === byId('mergeModal')) closeMergeModal(); });
  document.addEventListener('click', (ev) => {
    const trigger = ev.target.closest('[data-merge-action="open"]');
    if (!trigger) return;
    ev.stopPropagation();
    const id = trigger.dataset.mergeId;
    if (!id) return;
    openMergeModal(id, trigger.dataset.mergeName || id);
  });
  byId('mergeTargets')?.addEventListener('click', (ev) => {
    const item = ev.target.closest('.merge-target-item');
    if (!item) return;
    const id = item.dataset.tgtId;
    if (!id) return;
    _selectMergeTarget(id, item.dataset.tgtName || id);
  });
  byId('mergeConfirmBtn')?.addEventListener('click', async () => {
    if (!_mergeSource || !_mergeTarget) return;
    const btn = byId('mergeConfirmBtn');
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = 'Wirklich zusammenführen?';
      btn.style.background = '#ef4444';
      return;
    }
    btn.disabled = true; btn.textContent = 'Wird verschoben …';
    try {
      const r = await j(`/api/cameras/${encodeURIComponent(_mergeSource.id)}/merge-into/${encodeURIComponent(_mergeTarget.id)}`, { method: 'POST' });
      const tgtName = _mergeTarget.name;
      closeMergeModal();
      showToast(`${r.moved_files || 0} Datei(en) nach „${tgtName}“ verschoben (${r.moved_events || 0} Events, ${r.moved_timelapses || 0} Timelapse).`, 'success');
      if (typeof window.loadAll === 'function') await window.loadAll();
    } catch (e) {
      btn.disabled = false; btn.dataset.armed = '0';
      btn.textContent = 'Zusammenführen'; btn.style.background = '';
      showToast('Zusammenführen fehlgeschlagen: ' + (e.message || e), 'error');
    }
  });
}

// Inline onclick callsites (delegated trigger uses data attributes,
// but openMergeModal + _selectMergeTarget were also exposed on window
// before stage 6).
window.openMergeModal     = openMergeModal;
window._selectMergeTarget = _selectMergeTarget;
window.closeMergeModal    = closeMergeModal;
