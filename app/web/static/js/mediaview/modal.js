// ─── mediaview/modal.js ────────────────────────────────────────────────────
// Full-screen overlay host for MediaView modes that own their own
// modal (weather in G; H/I keep using the existing #lightboxModal
// chrome). Creates a backdrop + a single scroll container the shell
// root mounts into, locks body scroll, and wires Esc + backdrop-tap +
// swipe-down dismiss. iOS-safe: 100dvh, safe-area insets, ≥44 px close
// affordance lives in the shell title bar.
//
// close() is idempotent and fires the supplied onClose exactly once —
// callers route their teardown through it.

const _LS_NOP = () => {};

/**
 * Mount the overlay host.
 *
 * @param {Object} [opts]
 * @param {string} [opts.mode]  data-mode hook for per-mode accents.
 * @param {Function} [opts.onClose]  Fired once when the modal closes.
 * @returns {{ overlay, body, close(): void, closed: boolean }}
 */
export function mountMediaModal(opts = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'mv-modal';
  if (opts.mode) overlay.dataset.mode = opts.mode;
  overlay.innerHTML =
    `<div class="mv-modal-backdrop" data-close="1"></div>` +
    `<div class="mv-modal-scroll" data-slot="body"></div>`;
  document.body.appendChild(overlay);
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  const body = overlay.querySelector('[data-slot="body"]');

  const handle = { overlay, body, closed: false, close: _LS_NOP };

  const onKey = (ev) => {
    if (ev.key === 'Escape') handle.close();
  };
  const onClick = (ev) => {
    if (ev.target.closest && ev.target.closest('[data-close="1"]')) handle.close();
  };
  // Swipe-down to dismiss on touch — only when the gesture starts on
  // the backdrop / scroll surface, not on the video or a control.
  let touchY = null;
  const onTouchStart = (ev) => {
    const t = ev.target;
    if (t.closest && (t.closest('video') || t.closest('button') || t.closest('input'))) {
      touchY = null;
      return;
    }
    touchY = ev.touches && ev.touches[0] ? ev.touches[0].clientY : null;
  };
  const onTouchEnd = (ev) => {
    if (touchY === null) return;
    const endY = ev.changedTouches && ev.changedTouches[0] ? ev.changedTouches[0].clientY : touchY;
    if (endY - touchY > 90 && body.scrollTop <= 0) handle.close();
    touchY = null;
  };

  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', onClick);
  overlay.addEventListener('touchstart', onTouchStart, { passive: true });
  overlay.addEventListener('touchend', onTouchEnd, { passive: true });

  handle.close = () => {
    if (handle.closed) return;
    handle.closed = true;
    document.removeEventListener('keydown', onKey);
    overlay.removeEventListener('click', onClick);
    overlay.removeEventListener('touchstart', onTouchStart);
    overlay.removeEventListener('touchend', onTouchEnd);
    document.body.style.overflow = prevOverflow;
    overlay.remove();
    if (typeof opts.onClose === 'function') {
      try {
        opts.onClose();
      } catch {
        /* ignore */
      }
    }
  };

  return handle;
}
