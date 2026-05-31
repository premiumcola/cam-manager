// ─── mediaview/recorded-mode.js ────────────────────────────────────────────
// H · The recorded (Mediathek) player, lifted out of lightbox.js'
// _lbLegacyRender into the mediaview tree. openMediaView(mode:'recorded')
// calls openRecorded() directly — no more window._lbLegacyRender
// indirection.
//
// The body is the verbatim recorded composition: it drives the existing
// #lightboxModal chrome through the shared helpers that still live in
// lightbox.js (_setupVideoChrome mounts the grey panel tabs, the
// playbar/swimlane, the overlay-toggle row + unified legend + "Neu
// erkennen" button, and the zone overlay). Those helpers are the single
// owners of that DOM; recorded-mode orchestrates the open per item.
//
// Circular import note: this module imports call-time helpers from
// ../lightbox.js, and lightbox.js imports openMediaView from
// ./index.js, which imports this module. The cycle is SAFE because
// every imported binding here is a hoisted function declaration used
// only inside openRecorded() (call time), never at module-eval time.

import { byId, esc } from '../core/dom.js';
import { state } from '../core/state.js';
import { lbState } from '../mediathek/state.js';
import { lbLoadTracksForItem } from '../mediathek/bbox-overlay/index.js';
import {
  calcItemsPerPage,
  renderMediaGrid,
  renderMediaPagination,
} from '../mediathek/orchestration.js';
import {
  _isFullscreenVideoItem,
  _setupVideoChrome,
  _teardownVideoChrome,
  _lbShowError,
  resetLightboxToErrorState,
  _renderLbLabels,
} from '../lightbox.js';
import { _LB_TRASH_HTML, _updateLbConfirmBtn, _lbResetToPhoto } from './panels/lb-helpers.js';

// Render a recorded motion-clip / photo event into the lightbox modal.
// Photo path: centred-modal layout (chrome torn down, labels bubble row).
// Video path: full-screen chrome (top bar, playbar, panel tabs, fold).
export function openRecorded(item) {
  // L1 · the shared #lightboxModal may have been left in weather mode
  // (one container for all modes). Tear that down + drop its class so
  // the recorded chrome shows instead of staying hidden under lb-weather.
  try {
    window.closeWeatherMode?.();
  } catch {
    /* ignore */
  }
  byId('lightboxModal').classList.remove('lb-weather');
  // Index into the GLOBAL list (state._allMedia) so prev/next can cross
  // pagination boundaries — the page-slice (state.media) is a render
  // optimisation, not a navigation boundary.
  const globalList = state._allMedia || [];
  lbState.index = globalList.findIndex((x) => x.event_id === item.event_id);
  if (lbState.index === -1) {
    // Fallback: item came from somewhere outside the cached merged list
    // (rare). Open it anyway with single-item nav so the lightbox still
    // works — just no prev/next.
    lbState.index = 0;
    lbState.item = item;
  } else {
    lbState.item = globalList[lbState.index];
  }
  // If the navigated item lives outside the current page window, jump
  // the grid's page so the thumbnails behind the lightbox match what
  // the user sees on the lightbox itself. Re-rendering keeps current
  // scroll because the user is still inside the lightbox modal.
  const ps = window._cachedPageSize || calcItemsPerPage();
  if (window._cachedPageSize && globalList.length > 0) {
    const targetPage = Math.floor(lbState.index / ps);
    if (targetPage !== state.mediaPage) {
      state.mediaPage = targetPage;
      const offset = targetPage * ps;
      state.media = globalList.slice(offset, offset + ps);
      try {
        renderMediaGrid();
        renderMediaPagination();
      } catch (_) {}
    }
  }
  lbState.deletePending = false;
  _lbResetToPhoto();
  const delBtn = byId('lightboxDelete');
  if (delBtn) {
    delBtn.classList.remove('confirm-delete');
    delBtn.innerHTML = _LB_TRASH_HTML;
    delBtn.title = lbState.item.confirmed ? 'Bestätigt — trotzdem löschen?' : 'Löschen';
  }
  _updateLbConfirmBtn(lbState.item.confirmed);
  // Show video player for motion clips, image for snapshots
  const vidSrc = lbState.item.video_relpath
    ? `/media/${lbState.item.video_relpath}`
    : lbState.item.video_url || '';
  const imgSrc = lbState.item.snapshot_relpath
    ? `/media/${lbState.item.snapshot_relpath}`
    : lbState.item.snapshot_url || '';
  const hasVideoLabel = (lbState.item.labels || []).some((l) =>
    ['motion', 'car', 'person', 'cat', 'bird', 'dog', 'squirrel'].includes(l),
  );
  const pendingMsg =
    lbState.item.status === 'recording'
      ? 'Video wird aufgenommen…'
      : lbState.item.status === 'processing'
        ? 'Video wird verarbeitet…'
        : null;
  // Apply the per-item chrome BEFORE setting the video src so the
  // top bar / scrubber are present when the first timeupdate fires.
  // Photo branch tears the chrome back down so the centred-modal
  // layout returns intact.
  if (_isFullscreenVideoItem(lbState.item)) {
    _setupVideoChrome(lbState.item);
  } else {
    _teardownVideoChrome();
  }
  if (pendingMsg) {
    _lbShowError(pendingMsg);
  } else if (vidSrc) {
    const imgEl = byId('lightboxImg');
    imgEl.style.display = 'none';
    const videoEl = byId('lightboxVideo');
    videoEl.style.display = 'block';
    videoEl.src = vidSrc;
    videoEl.muted = true;
    videoEl.loop = true;
    // One-shot error listener: when the video src 404s (missing
    // .mp4 on disk) the browser fires `error` on the element.
    // resetLightboxToErrorState clears the previous clip's playbar
    // chrome, hides Nach-Erkennung, and surfaces a clean centred
    // "→ Nächste anzeigen / ✕ Schließen" card so the user isn't
    // stranded with stale UI from a clip that's no longer there.
    // Listener is one-shot — the next openLightbox re-binds it
    // freshly via this same code path.
    const _onVideoError = () => {
      if (videoEl._lbErrorBound !== _onVideoError) return;
      videoEl.removeEventListener('error', _onVideoError);
      videoEl._lbErrorBound = null;
      resetLightboxToErrorState('Video-Datei ist nicht mehr verfügbar.');
    };
    videoEl._lbErrorBound = _onVideoError;
    videoEl.addEventListener('error', _onVideoError);
    videoEl.load();
    videoEl.play().catch(() => {});
    // Fire-and-forget: fetch the tracks.json sidecar in parallel with
    // the first paint. The track timeline panel + per-class toggles
    // light up as soon as the JSON resolves; any 404 or malformed
    // payload silently falls through to the auto-reindex flow.
    lbLoadTracksForItem(lbState.item);
  } else if (!imgSrc && (hasVideoLabel || lbState.item.encode_error)) {
    _lbShowError('Video nicht verfügbar');
  } else {
    byId('lightboxImg').src = imgSrc;
  }
  const confirmedBadge = lbState.item.confirmed
    ? `<span style="background:#166534;color:#4ade80;border-radius:999px;padding:3px 10px;font-size:11px;font-weight:700">✓ Behalten</span>`
    : '';
  byId('lightboxMeta').innerHTML = `
    <span class="badge">${esc(lbState.item.camera_id || '')}</span>
    <span class="badge">${esc(lbState.item.time || '')}</span>
    ${vidSrc ? '<span class="badge">🎬 Video</span>' : ''}
    ${confirmedBadge}`;
  // Bubble-row tagging UI — kept for photo events (no tracks UI),
  // hidden in video full-screen mode where the timeline rows replace
  // the per-class affordance. The CSS rule on .lb-fs-video already
  // hides #lightboxLabels at the layout layer, but we still skip the
  // expensive _renderLbLabels DOM build to save work.
  if (!_isFullscreenVideoItem(lbState.item)) _renderLbLabels();
  else byId('lightboxLabels').innerHTML = '';
  // Edge dim only at the GLOBAL boundaries — page edges navigate through.
  byId('lightboxPrev').style.opacity = lbState.index > 0 ? '1' : '0.2';
  byId('lightboxNext').style.opacity =
    lbState.index < (state._allMedia || []).length - 1 ? '1' : '0.2';
  byId('lightboxModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
