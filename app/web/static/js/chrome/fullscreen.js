// ─── chrome/fullscreen.js ──────────────────────────────────────────────────
// Stage 11 of the legacy.js → ES modules refactor — generic fullscreen
// wiring used by the live-view modal and the lightbox. Tries the
// Fullscreen API first; falls back to a CSS .fake-fullscreen class on
// browsers that block it (iOS Safari) so the wrap still expands.
import { byId } from '../core/dom.js';

function _fsToggle(wrapEl, targetEl){
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl){
    if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  } else {
    const req = targetEl.requestFullscreen || targetEl.webkitRequestFullscreen || targetEl.mozRequestFullScreen;
    if (req) req.call(targetEl).catch(() => {
      wrapEl.classList.add('fake-fullscreen');
      wrapEl.classList.add('is-fs');
    });
    else {
      wrapEl.classList.add('fake-fullscreen');
      wrapEl.classList.add('is-fs');
    }
  }
}

// mx918 — the FS button now ships BOTH icons inline (template-side
// for the modal in partials/modals.html, JS render-side for dashboard
// tiles in dashboard.js); CSS toggles them based on .is-fs on the
// wrap. _initFsBtn keeps wiring the click + the wrap's class state
// across both the native fullscreenchange event and the iOS
// fake-fullscreen fallback.
export function _initFsBtn(btnId, wrapEl, getTarget){
  const btn = byId(btnId);
  if (!btn || !wrapEl) return;
  btn.addEventListener('click', e => { e.stopPropagation(); _fsToggle(wrapEl, getTarget()); });
  const update = () => {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    const nativeFs = !!(fsEl && (fsEl === wrapEl || wrapEl.contains(fsEl)));
    const fakeFs = wrapEl.classList.contains('fake-fullscreen');
    wrapEl.classList.toggle('is-fs', nativeFs || fakeFs);
    if (!fsEl){
      wrapEl.classList.remove('fake-fullscreen');
      if (!fakeFs) wrapEl.classList.remove('is-fs');
    }
  };
  document.addEventListener('fullscreenchange', update);
  document.addEventListener('webkitfullscreenchange', update);
}
