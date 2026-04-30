// ─── core/toast.js ─────────────────────────────────────────────────────────
// Toast notifications + the styled confirm modal used by every domain
// module instead of native window.confirm() (per CLAUDE.md). Both are
// exported AND attached to window so inline onclick handlers in
// dynamically-rendered template strings can still find them.
import { byId, esc } from './dom.js';

export function showToast(msg, type = 'info') {
  const c = byId('toastContainer');
  if (!c) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  const icons = { warn: '⚠️', error: '✕', success: '✓', info: 'ℹ' };
  t.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span>`
    + `<span class="toast-msg">${esc(msg)}</span>`
    + `<button class="toast-close" onclick="this.closest('.toast').remove()">✕</button>`;
  c.appendChild(t);
  // Toast lifetime by severity — errors linger longest because the
  // user usually wants time to read what failed before reaching for
  // a retry.
  const lifetime = type === 'error' ? 8000
                 : (type === 'warn' || type === 'info') ? 6000
                 : 4000;
  const dismiss = () => {
    t.classList.add('toast-out');
    t.addEventListener('animationend', () => t.remove(), { once: true });
  };
  setTimeout(dismiss, lifetime);
}

let _confirmResolve = null;
export function showConfirm(msg) {
  return new Promise((resolve) => {
    _confirmResolve = resolve;
    const modal = byId('confirmModal');
    const msgEl = byId('confirmMsg');
    if (!modal || !msgEl) { resolve(false); return; }
    msgEl.textContent = msg;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  });
}

export function _resolveConfirm(val) {
  const modal = byId('confirmModal');
  if (modal) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }
  if (_confirmResolve) {
    _confirmResolve(val);
    _confirmResolve = null;
  }
}

// Wire confirm-modal buttons (idempotent — guarded against the modal
// being rendered before the DOM is ready or against repeated init).
export function bindConfirmModal() {
  const okBtn = byId('confirmOk');
  const cancelBtn = byId('confirmCancel');
  const modal = byId('confirmModal');
  if (okBtn && !okBtn.dataset.wired) {
    okBtn.dataset.wired = '1';
    okBtn.addEventListener('click', () => _resolveConfirm(true));
  }
  if (cancelBtn && !cancelBtn.dataset.wired) {
    cancelBtn.dataset.wired = '1';
    cancelBtn.addEventListener('click', () => _resolveConfirm(false));
  }
  if (modal && !modal.dataset.wired) {
    modal.dataset.wired = '1';
    modal.addEventListener('click', (e) => {
      if (e.target === modal) _resolveConfirm(false);
    });
  }
}

// Legacy global bridge — inline handler attributes in the template
// (e.g. confirmOk's onclick fallback if someone wires it inline)
// look these up on window. Domain modules import the named exports
// directly; only the inline-handler path needs window.
window.showToast = showToast;
window.showConfirm = showConfirm;
