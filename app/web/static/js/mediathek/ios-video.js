// ─── mediathek/ios-video.js ────────────────────────────────────────────────
// Stage 22 of the legacy.js → ES modules refactor — iOS native video
// player handoff. For VIDEO items on iOS we skip the custom lightbox
// entirely and let Safari render its standalone fullscreen player. The
// shell would only stack on top of it (the previous "hide shell on
// webkitbeginfullscreen" attempt was unreliable across iOS versions).
// After the player closes the user returns to the grid; per-card ✓/✗
// affordances handle confirm/delete inline so the workflow doesn't lose
// those actions.
import { state } from '../core/state.js';
import { showToast } from '../core/toast.js';
import { lbState } from './state.js';

let _iosCurrentVideo = null;     // the transient <video> currently playing
let _iosCurrentItem = null;      // the media item bound to that video

export function _iosNativeVideoOpen(item){
  if (!item) return;
  // Tear down any previous transient first.
  _iosTeardownVideo();
  // Keep lbState.item / lbState.index in sync with state._allMedia for
  // the inline ✓/✗ buttons on each card to operate on the right entry.
  const globalList = state._allMedia || [];
  const idx = globalList.findIndex(x => x.event_id === item.event_id);
  lbState.index = idx >= 0 ? idx : 0;
  lbState.item = idx >= 0 ? globalList[idx] : item;
  _iosCurrentItem = lbState.item;
  const vidSrc = lbState.item.video_relpath
    ? `/media/${lbState.item.video_relpath}`
    : (lbState.item.video_url || '');
  if (!vidSrc){
    showToast('Video nicht verfügbar', 'error');
    return;
  }
  const v = document.createElement('video');
  v.src = vidSrc;
  v.controls = true;
  // CRITICAL: must be false on iOS so .play() can trigger native FS.
  v.playsInline = false;
  v.preload = 'metadata';
  // Off-screen but mounted so iOS keeps the element alive while playing.
  v.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1';
  document.body.appendChild(v);
  _iosCurrentVideo = v;
  const _onEnd = () => {
    // Closing the iOS native player returns the user to the grid. The
    // inline ✓/✗ on each card handle confirm/delete; the old floating
    // action sheet was a desktop-era leftover.
    _iosTeardownVideo();
  };
  v.addEventListener('webkitendfullscreen', _onEnd);
  v.addEventListener('ended', _onEnd);
  // Best-effort error fallback so a bad src doesn't strand the user.
  v.addEventListener('error', () => {
    _iosTeardownVideo();
    showToast('Video konnte nicht geladen werden', 'error');
  });
  // Try .play() first — on most iOS versions this triggers native FS.
  // If that's blocked, fall back to the explicit webkitEnterFullscreen
  // path which works under direct user-gesture context.
  const _attempt = () => {
    const p = v.play();
    if (p && p.catch){
      p.catch(() => {
        try {
          if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
          v.play().catch(() => {});
        } catch {}
      });
    }
  };
  _attempt();
}

function _iosTeardownVideo(){
  const v = _iosCurrentVideo;
  if (!v) return;
  try { v.pause(); v.removeAttribute('src'); v.load(); } catch {}
  if (v.parentNode) v.parentNode.removeChild(v);
  _iosCurrentVideo = null;
  _iosCurrentItem = null;
}
