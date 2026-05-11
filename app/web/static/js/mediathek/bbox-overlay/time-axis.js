// ─── mediathek/bbox-overlay/time-axis.js ───────────────────────────────────
// Single CSS variable on .lb-time-stack drives THREE readers in
// lockstep: the scrubber bar's fill width, the scrubber thumb's left,
// and the play cursor's left. One rAF write paints all three so the
// scrubber thumb and the vertical cursor can never drift apart.
import { byId } from '../../core/dom.js';
import { _state } from './_state.js';

export function _updatePlayPct(){
  const stack = document.querySelector('.lb-time-stack');
  if (!stack) return;
  const v = byId('lightboxVideo');
  if (!v) return;
  const dur = Number.isFinite(v.duration) && v.duration > 0
    ? v.duration : 0;
  if (dur <= 0){
    stack.style.setProperty('--play-pct', '0');
    return;
  }
  const cur = Number.isFinite(v.currentTime) ? v.currentTime : 0;
  const pct = Math.min(1, Math.max(0, cur / dur));
  stack.style.setProperty('--play-pct', pct.toFixed(5));
}

// Translate a viewport clientX into a video currentTime via the time
// column's bounding rect — used by both the scrubber-bar drag and the
// play-line drag so they share a single time mapping. Returns null
// when the column isn't laid out (e.g. modal hidden, no duration).
function _clientXToTime(clientX){
  const col = document.querySelector('.lb-time-col');
  const v = byId('lightboxVideo');
  if (!col || !v) return null;
  const dur = Number.isFinite(v.duration) && v.duration > 0
    ? v.duration : 0;
  if (dur <= 0) return null;
  const r = col.getBoundingClientRect();
  if (r.width <= 0) return null;
  const pct = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  return pct * dur;
}

// Shared drag-to-scrub handler attached to either the scrubber bar's
// hit area or the play cursor's hit area. Pointer capture keeps the
// drag alive when the user's pointer leaves the original element.
function _attachDragHandlers(hit){
  if (!hit || hit.dataset.dragWired === '1') return;
  hit.dataset.dragWired = '1';
  hit.addEventListener('pointerdown', (ev) => {
    const v = byId('lightboxVideo');
    if (!v || !v.src) return;
    ev.preventDefault();
    try { hit.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    _state.dragWasPlaying = !v.paused && !v.ended;
    if (_state.dragWasPlaying) v.pause();
    const t = _clientXToTime(ev.clientX);
    if (t != null){ v.currentTime = t; _updatePlayPct(); }
  });
  hit.addEventListener('pointermove', (ev) => {
    if (!hit.hasPointerCapture(ev.pointerId)) return;
    const v = byId('lightboxVideo');
    if (!v) return;
    const t = _clientXToTime(ev.clientX);
    if (t != null){ v.currentTime = t; _updatePlayPct(); }
  });
  const _release = (ev) => {
    if (hit.hasPointerCapture(ev.pointerId)){
      try { hit.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
    }
    if (_state.dragWasPlaying){
      const v = byId('lightboxVideo');
      v?.play().catch(() => {});
    }
    _state.dragWasPlaying = false;
  };
  hit.addEventListener('pointerup', _release);
  hit.addEventListener('pointercancel', _release);
}

export function _wirePlayButton(){
  const btn = byId('lbScrubPlay');
  if (!btn || btn.dataset.playWired === '1') return;
  btn.dataset.playWired = '1';
  btn.addEventListener('click', () => {
    const v = byId('lightboxVideo');
    if (!v || !v.src) return;
    if (v.paused || v.ended) v.play().catch(() => {});
    else v.pause();
  });
}

export function _wireScrubBar(){
  const hit = document.querySelector('#lbScrubBar .lb-scrub-hit');
  _attachDragHandlers(hit);
}

export function _wirePlayCursorDrag(){
  const hit = document.querySelector('.lb-play-cursor .lb-play-hit');
  _attachDragHandlers(hit);
}

// Sync the play button's glyph with the video's play state. The
// button is freshly rendered on every lbRenderTrackTimeline() call,
// so we re-paint when the video transitions between play/pause.
export function _refreshPlayButtonGlyph(){
  const btn = byId('lbScrubPlay');
  const v = byId('lightboxVideo');
  if (!btn || !v) return;
  const playing = !v.paused && !v.ended;
  btn.innerHTML = playing
    ? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5l13 7-13 7z"/></svg>';
  btn.title = playing ? 'Pause' : 'Play';
}
