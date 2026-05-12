// ─── dashboard.js ──────────────────────────────────────────────────────────
// Stage 3a of the legacy.js → ES modules refactor — pure dashboard
// helpers that have no external behavioural dependency on the rest of
// the legacy file. Each function is referenced only by other dashboard
// code (renderDashboard, showCameraReloadAnimation, the live-update
// poll) which still lives in legacy.js for now; once those move out
// in stage 3b, this module becomes the single home for the camera-tile
// feature surface.
//
// Nothing in here mutates state.cameras or other global stores —
// they're all stateless rendering helpers, the dead-id snapshot poll
// suppression Map, and the surveil-mode classification. The legacy
// bridge for window._camImgRetry stays so inline onclick handlers in
// renderDashboard's template strings (onerror="_camImgRetry(this)")
// keep resolving.
import { state } from './core/state.js';
import { byId, esc } from './core/dom.js';
import { j } from './core/api.js';
import { getCameraIcon, OBJ_LABEL, objIconSvg } from './core/icons.js';

// ── Dead-camera-id snapshot poll suppression ───────────────────────────────
// After a camera rename (manuf/model edit triggers storage_migration to
// compute a new canonical id), the old <img src="/api/camera/<old-id>/
// snapshot.jpg"> elements stay in the DOM until the next renderDashboard.
// The 5 fps preview refresh keeps bumping their timestamps, producing a
// 404 storm in the console. _failedSnapshotIds tracks ids whose snapshot
// endpoint has 404'd two times in a row; _camImgRetry stops retrying
// once that threshold is hit, and the preview-refresh loop in legacy.js
// skips them. loadAll() resets the map (via _resetFailedSnapshotIds)
// since the next dashboard re-render will use the fresh ids.
export const _failedSnapshotIds = new Map();
export function _resetFailedSnapshotIds(){ _failedSnapshotIds.clear(); }
export function _isSnapshotIdDead(camId){
  return camId ? (_failedSnapshotIds.get(camId) || 0) >= 2 : false;
}
export function _camIdFromImg(img){
  return img?.closest?.('[data-camid]')?.dataset?.camid || null;
}

// ── Camera snapshot retry (handles 503 on initial load before stream is ready) ─
export function _camImgRetry(img){
  const camId = _camIdFromImg(img);
  // Two consecutive failures is the threshold for marking the id dead —
  // catches a real rename (the new img element will carry the fresh id)
  // while tolerating one transient 503 during cam restart.
  if (camId) {
    const n = (_failedSnapshotIds.get(camId) || 0) + 1;
    _failedSnapshotIds.set(camId, n);
    if (n >= 2) {
      img.style.display = 'none';
      return;
    }
  }
  const retries = parseInt(img.dataset.snapRetry || '0');
  if (retries >= 12) { img.style.display = 'none'; return; }
  img.dataset.snapRetry = retries + 1;
  // Exponential backoff: 500ms, 1s, 1.5s … capped at 3s
  const delay = Math.min(500 * (retries + 1), 3000);
  setTimeout(() => {
    if (!img.isConnected) return; // card removed from DOM
    const base = img.src.split('?')[0];
    img.src = base + '?t=' + Date.now();
  }, delay);
}
window._camImgRetry = _camImgRetry;

// Snapshot loaded — fade in, hide the placeholder, and apply the
// stream's actual aspect ratio to the parent .cv-frame so the
// container matches the camera (4:3, 16:9, 16:10 …) instead of
// being locked to a single 16:9 default. Combined with the
// `object-fit:contain` rule on .cv-img this means the full sensor
// frame is always visible — no cropping, no squashing. The frame
// resizes once when the first snapshot decodes (the placeholder
// hides at the same moment, so the resize is hidden behind that
// transition and reads as the layout settling, not a snap).
export function _cvImgLoaded(img){
  img.classList.add('loaded');
  const placeholder = img.previousElementSibling;
  if (placeholder) placeholder.style.display = 'none';
  const w = img.naturalWidth, h = img.naturalHeight;
  if (w > 0 && h > 0) {
    const frame = img.closest('.cv-frame');
    if (frame) frame.style.setProperty('--cv-aspect', `${w} / ${h}`);
  }
}
window._cvImgLoaded = _cvImgLoaded;

// ── Camera-grid column class — picks the right cam-grid-N class so CSS
//     can size tiles based on count without JS math. -n = generic flow. ─
export function _camGridCols(n){
  if (n <= 1) return 'cam-grid-1';
  if (n <= 2) return 'cam-grid-2';
  if (n <= 4) return 'cam-grid-4';
  return 'cam-grid-n';
}

// ── Surveillance-mode classification ───────────────────────────────────────
// Drives the colour + label + animation of the .cv-surveil bottom-overlay
// on each camera tile. Four states:
//   off     cam disarmed                         → grey, eye crossed-out
//   watch   armed, no Telegram, no active window → storm-blue, passive
//   notify  armed + Telegram on                  → amber, eye blinks
//   alarm   armed + currently inside a schedule
//           window with telegram or hard action  → red, head pulses
export const SURVEIL_ACC = {
  off:    '80,80,90',
  watch:  '127,174,201',
  notify: '251,146,60',
  alarm:  '220,38,38',
};
export const SURVEIL_LABEL = {
  off:    'Stumm',
  watch:  'Beobachtung',
  notify: 'Benachrichtigung',
  alarm:  'Wachmodus',
};
export function _isInScheduleWindow(from, to){
  if (!from || !to) return false;
  const now = new Date();
  const m = now.getHours() * 60 + now.getMinutes();
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  const f = fh * 60 + fm, t = th * 60 + tm;
  return f <= t ? (m >= f && m < t) : (m >= f || m < t);
}
export function _surveilMode(c){
  if (!c.armed) return 'off';
  const sch = c.schedule || {};
  if (sch.enabled && _isInScheduleWindow(sch.from, sch.to)){
    const acts = sch.actions || {};
    if (acts.telegram !== false || acts.hard !== false) return 'alarm';
  }
  return c.telegram_enabled ? 'notify' : 'watch';
}
export function _surveilEyeSvg(mode){
  if (mode === 'off') {
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';
  }
  return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/></svg>';
}

// ── Camera-tile placeholders ───────────────────────────────────────────────
// Two states (red = offline, blue = connecting) share the same shell:
// asymmetric viewfinder brackets in the four corners with a centered
// stage that hosts whichever animation matches the state. The shell
// lives at the placeholder's full frame so it never doubles up with
// the cv-card chrome.
function _placeholderShell(accent, centerHtml, bracketKeyframe){
  return `<div class="cv-ph cv-ph--${accent}">
    <div class="cv-ph-grid"></div>
    <svg class="cv-ph-brackets" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <g fill="none" style="animation:${bracketKeyframe} 2s ease-in-out infinite">
        <polyline points="0,30 0,0 30,0"  stroke-width="2.5" class="cv-ph-br cv-ph-br--tl"/>
        <polyline points="70,0 100,0 100,30" stroke-width="2"   class="cv-ph-br cv-ph-br--tr" style="animation-delay:.5s"/>
        <polyline points="100,70 100,100 70,100" stroke-width="2.5" class="cv-ph-br cv-ph-br--br" style="animation-delay:1s"/>
        <polyline points="30,100 0,100 0,70"    stroke-width="2"   class="cv-ph-br cv-ph-br--bl" style="animation-delay:1.5s"/>
      </g>
    </svg>
    <div class="cv-ph-center">${centerHtml}</div>
  </div>`;
}

// Structured camera SVGs — separate strokes/opacities per layer so the
// icon doesn't fall apart visually at small sizes.
const _CAM_OFF_SVG = `<svg viewBox="0 0 48 48" width="72" height="72" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block">
  <rect x="8" y="14" width="24" height="20" rx="2.5" stroke="rgba(255,255,255,0.35)" stroke-width="2"/>
  <path d="M32 20 L40 14 V34 L32 28 Z" stroke="rgba(255,255,255,0.35)" stroke-width="2"/>
  <circle cx="20" cy="24" r="4.5" stroke="rgba(255,255,255,0.25)" stroke-width="1.5"/>
  <line x1="4" y1="4" x2="44" y2="44" stroke="rgba(239,68,68,0.55)" stroke-width="2.5"/>
</svg>`;
const _CAM_SM_SVG = `<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="rgba(59,130,246,0.5)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block">
  <rect x="8" y="14" width="24" height="20" rx="2.5"/>
  <path d="M32 20 L40 14 V34 L32 28 Z"/>
  <circle cx="20" cy="24" r="5"/>
</svg>`;

export function _makeOfflinePlaceholder(){
  // Red: four expanding rings + crosshair + struck-through camera icon.
  const rings = [0, 1, 2, 3].map(i =>
    `<span class="cv-ph-ring" style="animation-delay:${i}s"></span>`
  ).join('');
  const center = `
    <div class="cv-ph-stage">
      <div class="cv-ph-crosshair"></div>
      ${rings}
      <div class="cv-ph-icon cv-ph-icon--glitch cv-ph-icon--red">${_CAM_OFF_SVG}</div>
    </div>
    <div class="cv-ph-label cv-ph-label--flicker cv-ph-label--red">KEIN SIGNAL</div>
  `;
  return _placeholderShell('red', center, 'bracketPulseRed');
}

export function _makeConnectingPlaceholder(){
  // Blue: rotating radar cone + orbiting dots + small camera icon, all
  // inside the same stage so they share one center.
  const center = `
    <div class="cv-ph-stage">
      <svg class="cv-ph-guides" viewBox="-100 -100 200 200" aria-hidden="true">
        <circle cx="0" cy="0" r="30" fill="none" stroke="rgba(59,130,246,0.1)" stroke-width="1"/>
        <circle cx="0" cy="0" r="55" fill="none" stroke="rgba(59,130,246,0.1)" stroke-width="1"/>
        <circle cx="0" cy="0" r="80" fill="none" stroke="rgba(59,130,246,0.1)" stroke-width="1"/>
      </svg>
      <svg class="cv-ph-radar" viewBox="-100 -100 200 200" aria-hidden="true">
        <path d="M0,0 L85,-49 A98,98 0 0 1 85,49 Z" fill="rgba(59,130,246,0.12)"/>
        <line x1="0" y1="0" x2="85" y2="49" stroke="rgba(59,130,246,0.5)" stroke-width="1.5"/>
        <circle cx="85" cy="49" r="3" fill="rgba(59,130,246,0.9)"/>
      </svg>
      <span class="cv-ph-orbit cv-ph-orbit--1"></span>
      <span class="cv-ph-orbit cv-ph-orbit--2"></span>
      <span class="cv-ph-orbit cv-ph-orbit--3"></span>
      <div class="cv-ph-icon">${_CAM_SM_SVG}</div>
    </div>
    <div class="cv-ph-label cv-ph-label--blue">VERBINDE…</div>
  `;
  return _placeholderShell('blue', center, 'bracketPulseBlue');
}

// Restore the offline placeholder + bump the snapshot src after a
// reload-animation give-up. Used by showCameraReloadAnimation when its
// poll hits the 15-attempt ceiling without seeing the camera return to
// active.
export function _restorePlaceholder(card){
  const placeholder = card.querySelector('.cv-loading-placeholder');
  if (placeholder) placeholder.innerHTML = _makeOfflinePlaceholder();
  const img = card.querySelector('.cv-img');
  if (img) {
    const base = img.src.split('?')[0];
    img.src = base + '?t=' + Date.now();
  }
}

// ── Stage 3b — dashboard rendering + live state ────────────────────────────
// HD-stream toggle state. _hdCards holds camera ids whose tile is
// currently showing the high-bitrate stream_hd.mjpg endpoint instead of
// the 5 fps snapshot.jpg cycle. Lives at module scope so the live-pill
// refresh and the preview-refresh loop see the same set.
export const _hdCards = new Set();
let _previewRefreshInterval = null;

// 5 fps preview-refresh interval. While the tab is foreground, every
// 200 ms each visible non-HD .cv-img gets its src timestamp bumped so
// the browser fetches a fresh snapshot.jpg. HD tiles refresh themselves
// via the MJPEG stream and are skipped. Dead post-rename ids
// (_isSnapshotIdDead) are skipped too, suppressing the post-rename
// 404 storm we saw earlier in the session.
export function startPreviewRefresh(){
  if (_previewRefreshInterval) clearInterval(_previewRefreshInterval);
  _previewRefreshInterval = setInterval(() => {
    if (document.hidden) return;
    const grid = byId('cameraCards');
    if (!grid) return;
    grid.querySelectorAll('.cv-img.loaded').forEach(img => {
      if (img.dataset.hdMode === '1') return;
      const camId = _camIdFromImg(img);
      if (_isSnapshotIdDead(camId)) return;
      const base = img.src.split('?')[0];
      img.src = base + '?t=' + Date.now();
    });
  }, 200);
}

// HD-stream toggle on the cv-cog area's HD button. Flips the cv-img
// element between snapshot.jpg cache-busted polling and the live
// stream_hd.mjpg endpoint, then asks the live-pill to repaint so the
// "Stream-Modus" line reflects the new state without waiting for the
// next 3 s status poll.
//
// Also arms (or clears) the 10-min idle timer for that camera —
// cm-52 task #5c keeps HD from running indefinitely when the user
// walks away from the tab. Toggling OFF clears the timer; toggling
// ON arms a fresh 10-min countdown. Manual interaction with the tile
// (click on any of HD/FS/SIM/cog, hover on desktop) resets the
// countdown via the grid-level pointerdown listener installed below.
export function toggleCardHd(camId, btn){
  const card = btn.closest('.cv-card');
  const img = card?.querySelector('.cv-img');
  if (!img) return;
  if (_hdCards.has(camId)) {
    _hdCards.delete(camId);
    btn.classList.remove('active');
    img.dataset.hdMode = '0';
    img.src = `/api/camera/${encodeURIComponent(camId)}/snapshot.jpg?t=${Date.now()}`;
    _clearHdIdleTimer(camId);
  } else {
    _hdCards.add(camId);
    btn.classList.add('active');
    img.dataset.hdMode = '1';
    img.src = `/api/camera/${encodeURIComponent(camId)}/stream_hd.mjpg`;
    _armHdIdleTimer(camId);
  }
  _refreshLivePillForCard(camId);
}

// ── HD idle timeout (cm-52 task #5c) ────────────────────────────────────
// Per-tile setTimeout that flips HD → SD after _HD_IDLE_TIMEOUT_MS of
// no interaction. Quiet — just the stream switches and the HD button
// visual de-activates. Tab-visibility suspends/resumes the countdown
// so a backgrounded tab doesn't burn through the timer in silence.
const _HD_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const _hdIdleTimers = new Map();  // camId → { handle, deadline, paused, remaining }

function _armHdIdleTimer(camId){
  _clearHdIdleTimer(camId);
  if (document.hidden){
    // Tab not in focus — track the deadline but don't burn the
    // timeout while hidden. visibilitychange will resume.
    _hdIdleTimers.set(camId, {
      handle: 0, deadline: 0,
      paused: true, remaining: _HD_IDLE_TIMEOUT_MS,
    });
    return;
  }
  const deadline = Date.now() + _HD_IDLE_TIMEOUT_MS;
  const handle = setTimeout(() => _onHdIdleTimeout(camId), _HD_IDLE_TIMEOUT_MS);
  _hdIdleTimers.set(camId, {
    handle, deadline,
    paused: false, remaining: _HD_IDLE_TIMEOUT_MS,
  });
}

function _clearHdIdleTimer(camId){
  const entry = _hdIdleTimers.get(camId);
  if (!entry) return;
  if (entry.handle) clearTimeout(entry.handle);
  _hdIdleTimers.delete(camId);
}

function _onHdIdleTimeout(camId){
  _hdIdleTimers.delete(camId);
  if (!_hdCards.has(camId)) return;
  const card = byId('cameraCards')?.querySelector(`[data-camid="${CSS.escape(camId)}"]`);
  const hdBtn = card?.querySelector('.cv-hd-badge');
  if (hdBtn) toggleCardHd(camId, hdBtn);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden){
    _hdIdleTimers.forEach((entry) => {
      if (!entry.paused && entry.handle){
        clearTimeout(entry.handle);
        entry.remaining = Math.max(0, entry.deadline - Date.now());
        entry.paused = true;
        entry.handle = 0;
      }
    });
  } else {
    _hdIdleTimers.forEach((entry, camId) => {
      if (!entry.paused) return;
      entry.deadline = Date.now() + entry.remaining;
      entry.handle = setTimeout(() => _onHdIdleTimeout(camId), entry.remaining);
      entry.paused = false;
    });
  }
});

// Grid-level pointerdown listener — installed once. Resets the HD idle
// timer on any user-initiated press inside an HD-active tile (HD/FS/
// SIM/cog buttons, or even a tap on the inert tile body). Re-armed
// listener survives renderDashboard's innerHTML rebuilds because it's
// bound to the parent #cameraCards element.
let _hdIdleWired = false;
function _wireHdIdleReset(){
  if (_hdIdleWired) return;
  const grid = byId('cameraCards');
  if (!grid) return;
  const reset = (e) => {
    const card = e.target.closest('.cv-card[data-camid]');
    if (!card) return;
    const camId = card.dataset.camid;
    if (_hdCards.has(camId)) _armHdIdleTimer(camId);
  };
  grid.addEventListener('pointerdown', reset, { passive: true });
  if (window.matchMedia && window.matchMedia('(hover:hover)').matches){
    // Desktop hover resets too — match the prompt's "any interaction"
    // intent. Touch devices skip this so a stray hover-emulation
    // event on iOS doesn't fight with the pointerdown reset.
    grid.addEventListener('pointerenter', reset, { passive: true, capture: true });
  }
  _hdIdleWired = true;
}

// Re-paint the expanded LivePill row values for one card based on
// current HD state. Used by both toggleCardHd() and the 3 s polling
// loop in legacy.js so the pill never shows sub-stream values while
// HD-Stream is active.
export function _refreshLivePillForCard(camId){
  const card = byId('cameraCards')?.querySelector(`[data-camid="${CSS.escape(camId)}"]`);
  if (!card) return;
  const livePill = card.querySelector('.cv-pill-live-wrap');
  if (!livePill) return;
  const c = (state.cameras || []).find(x => x.id === camId) || {};
  const hdOn = _hdCards.has(camId);
  const modeEl = livePill.querySelector('.cv-stream-mode');
  if (modeEl) {
    if (hdOn) {
      modeEl.textContent = '● HD-Stream';
      modeEl.className = 'cv-stream-mode cv-mode-hd';
    } else {
      const mode = c.stream_mode || 'baseline';
      modeEl.textContent = mode === 'live' ? '● Live' : '○ Vorschau';
      modeEl.className = 'cv-stream-mode ' + (mode === 'live' ? 'cv-mode-live' : 'cv-mode-base');
    }
  }
  const fpsEl = livePill.querySelector('.cv-lp-fps-val');
  if (fpsEl) fpsEl.textContent = hdOn ? '—' : ((c.preview_fps || 0) > 0 ? (c.preview_fps + ' fps') : '—');
  const fpsSubEl = livePill.querySelector('.cv-lp-fps-sub');
  if (fpsSubEl) fpsSubEl.textContent = hdOn ? 'Main-Stream aktiv' : 'Gemessen (Sub-Stream)';
  const resEl = livePill.querySelector('.cv-lp-res-val');
  if (resEl) resEl.textContent = hdOn ? 'Main-Stream' : (c.preview_resolution || c.resolution || '—');
}

// cm-52: the tile body is inert — the article-level onclick was
// dropped (task 2 of the dashboard restructure). Each tile carries
// three explicit buttons: HD (inline with title), FS (top-right),
// SIM (bottom-right). The legacy openLiveView modal stays available
// as window.openLiveView for any external caller; the dashboard
// itself no longer reaches for it.
//
// ── FS button — native fullscreen on the tile's .cv-img-wrap ────────────
// Reuses the requestFullscreen + .fake-fullscreen pattern that
// chrome/fullscreen.js + chrome/live-view.js already exercise for
// the legacy modal, retargeted at the per-tile media wrap.
//
// _hdAtFsEntry snapshots which cameras had HD on at FS-enter so the
// fullscreenchange exit handler can tell "user turned HD on inside
// FS" (drop back to SD) from "HD was on before FS started" (leave it).
const _hdAtFsEntry = new Set();

export function _cvEnterFullscreen(camId){
  const card = byId('cameraCards')?.querySelector(`[data-camid="${CSS.escape(camId)}"]`);
  const wrap = card?.querySelector('.cv-img-wrap');
  if (!wrap) return;
  // Snapshot HD state at FS-enter — drives the auto-drop rule below.
  if (_hdCards.has(camId)) _hdAtFsEntry.add(camId);
  else _hdAtFsEntry.delete(camId);
  const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen || wrap.mozRequestFullScreen;
  if (req){
    req.call(wrap).catch(() => {
      wrap.classList.add('fake-fullscreen');
      wrap.classList.add('is-fs');
    });
  } else {
    wrap.classList.add('fake-fullscreen');
    wrap.classList.add('is-fs');
  }
  // .fake-fullscreen has its own dismiss path — tap-outside the
  // wrap returns to normal. The native API exits via Esc / browser
  // controls / iOS swipe.
  if (wrap.classList.contains('fake-fullscreen')){
    const dismiss = (ev) => {
      if (!wrap.contains(ev.target)){
        wrap.classList.remove('fake-fullscreen');
        wrap.classList.remove('is-fs');
        document.removeEventListener('keydown', escDismiss);
        document.removeEventListener('click', dismiss, true);
        _runHdDropOnFsExit();
      }
    };
    const escDismiss = (ev) => {
      if (ev.key === 'Escape'){
        wrap.classList.remove('fake-fullscreen');
        wrap.classList.remove('is-fs');
        document.removeEventListener('keydown', escDismiss);
        document.removeEventListener('click', dismiss, true);
        _runHdDropOnFsExit();
      }
    };
    setTimeout(() => {
      document.addEventListener('click', dismiss, true);
      document.addEventListener('keydown', escDismiss);
    }, 0);
  }
}

// Drop HD on tiles whose FS session involved a user-initiated HD
// toggle. Walks every visible cv-card so the rule applies whether
// FS ended via the native API, the .fake-fullscreen dismiss path, or
// a user navigation. Quiet — no toast, just the stream and the HD
// button visual flip back. Used by both fullscreenchange + the
// fake-fullscreen click/Esc handlers above.
function _runHdDropOnFsExit(){
  const grid = byId('cameraCards');
  if (!grid) return;
  grid.querySelectorAll('.cv-card[data-camid]').forEach(card => {
    const camId = card.dataset.camid;
    const hasHdNow = _hdCards.has(camId);
    const hadHdAtEntry = _hdAtFsEntry.has(camId);
    if (hasHdNow && !hadHdAtEntry){
      const hdBtn = card.querySelector('.cv-hd-badge');
      if (hdBtn) toggleCardHd(camId, hdBtn);
    }
  });
  _hdAtFsEntry.clear();
}

function _onFullscreenChange(){
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  // .is-fs drives the FS-button icon swap (task mx918) and any other
  // chrome that needs to know "this wrap is the FS target right now".
  // Walk every wrap on the page so stale .is-fs from a previous exit
  // can't linger after a navigation.
  document.querySelectorAll('.cv-img-wrap').forEach(w => {
    w.classList.toggle('is-fs', w === fsEl || w.classList.contains('fake-fullscreen'));
  });
  if (fsEl) return;       // entered (or transitioning into) FS — wait for exit.
  // Exited fullscreen — defensive cleanup + auto-drop HD per cm-52 task #5b.
  document.querySelectorAll('.cv-img-wrap.fake-fullscreen').forEach(w => {
    w.classList.remove('fake-fullscreen');
    w.classList.remove('is-fs');
  });
  _runHdDropOnFsExit();
}
document.addEventListener('fullscreenchange', _onFullscreenChange);
document.addEventListener('webkitfullscreenchange', _onFullscreenChange);

window._cvEnterFullscreen = _cvEnterFullscreen;

// ── SIM button — open MediaView in live-detect mode for this camera ─────
// Routes to the unified MediaView shell so the user sees the SAME
// chrome as a recorded clip (lb-fs-video top bar, 16:9 wrap, panel-
// tabs strip, fine-analysis fold OPEN by default), driven by the
// 1 Hz test-detection polling implemented in mediaview/live-detect.js.
// Prev/next nav + confirm/delete/download actions are nulled — live
// mode has no recorded-item navigation surface.
import { openMediaView } from './mediaview/index.js';

export function _cvOpenSim(camId){
  const cam = (state.cameras || []).find(c => c.id === camId);
  if (!cam) return;
  try {
    openMediaView({
      mode: 'live-detect',
      source: {
        type: 'mjpeg',
        url: `/api/camera/${encodeURIComponent(camId)}/stream_hd.mjpg`,
        frameSize: (cam.main_w && cam.main_h)
          ? { w: cam.main_w, h: cam.main_h }
          : { w: 1920, h: 1080 },
      },
      item: {
        camera_id: camId,
        camera_name: cam.name || camId,
      },
      actions: {
        onClose:    () => {},   // shell handles its own teardown via closeLightbox
        onPrev:     null,
        onNext:     null,
        onConfirm:  null,
        onDelete:   null,
        onDownload: null,
      },
    });
  } catch (err){
    // Diagnostic only — surface a quiet toast via the window bridge
    // so a missing showToast import (the module-level binding isn't
    // pulled in here) doesn't ReferenceError the SIM button.
    window.showToast?.(`Live-Erkennung fehlgeschlagen: ${err?.message || err}`, 'error');
  }
}
window._cvOpenSim = _cvOpenSim;

// Camera-tile grid renderer. Builds every visible cv-card from
// state.cameras. The template string carries inline onclick handlers
// (_cvCardClick / toggleCardHd / editCamera / _camImgRetry); each name
// is reachable on window via the bridge block at the bottom of this
// module + the window.editCamera bridge that still lives in legacy.js.
export function renderDashboard(){
  const cams = state.cameras;
  const gridCls = _camGridCols(cams.length);
  byId('cameraCards').className = `camera-grid ${gridCls}`;
  byId('cameraCards').innerHTML = cams.map(c => {
    const hdOn = _hdCards.has(c.id);
    const snapUrl = hdOn
      ? `/api/camera/${esc(c.id)}/stream_hd.mjpg`
      : `/api/camera/${esc(c.id)}/snapshot.jpg?t=${Date.now()}`;
    const isActive = c.status === 'active';
    const tlOn = !!(c.timelapse && c.timelapse.enabled);
    const fps = c.frame_interval_ms ? Math.round(1000 / c.frame_interval_ms) : null;
    const previewFps = (c.preview_fps || 0) > 0 ? c.preview_fps : null;
    const streamMode = c.stream_mode || 'baseline';
    return `<article class="cv-card${c.armed ? '' : ' cv-card--muted'}" data-camid="${esc(c.id)}" data-cam-name="${esc(c.name || c.id)}">
  <div class="cv-frame">
    <div class="cv-img-wrap">
      <div class="cv-loading-placeholder">${isActive ? _makeConnectingPlaceholder() : _makeOfflinePlaceholder()}</div>
      <img class="cv-img cam-snap" src="${snapUrl}" alt="${esc(c.name)}" data-hd-mode="${hdOn ? '1' : '0'}"
        onload="_cvImgLoaded(this)"
        onerror="_camImgRetry(this)" />
      <div class="cv-grad-top"></div>
      <div class="cv-grad-bot"></div>
      <div class="cv-chrome-top-left">
        <div class="cv-name-row">
          <span class="cv-title-icon" aria-hidden="true">${getCameraIcon(c.name)}</span>
          <div class="cv-name">${esc(c.name)}</div>
        </div>
        ${c.location ? `<div class="cv-loc">${esc(c.location)}</div>` : ''}
${isActive ? `
        <div class="cv-pill-live-wrap cv-live-active">
          <span class="cv-pdot"></span>
          <span class="cv-live-label">Live</span>
          ${previewFps ? `<span class="cv-live-fps">${previewFps} fps</span>` : ''}
          <svg class="cv-live-arrow" width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="rgba(200,245,224,.85)" stroke-width="1.8" stroke-linecap="round"><path d="M3 4.5l3 3 3-3"/></svg>
          <div class="cv-live-detail">
            <div class="cv-live-detail-header">
              <span class="cv-pdot"></span>
              <span>Livestream aktiv</span>
            </div>
            <div class="cv-lp-row"><span>Stream-Modus</span><strong class="cv-stream-mode ${hdOn ? 'cv-mode-hd' : (streamMode === 'live' ? 'cv-mode-live' : 'cv-mode-base')}">${hdOn ? '● HD-Stream' : (streamMode === 'live' ? '● Live' : '○ Vorschau')}</strong></div>
            <div class="cv-lp-row"><span>Preview-FPS</span><strong class="cv-lp-fps-val">${previewFps != null ? previewFps + ' fps' : '—'}</strong></div>
            <div class="cv-lp-row"><span>Auflösung</span><strong class="cv-lp-res-val">${hdOn ? esc(c.main_resolution || c.preview_resolution || c.resolution || '—') : esc(c.preview_resolution || c.resolution || '—')}</strong></div>
            <div class="cv-lp-row"><span>Analyse-Framerate</span><strong>${fps != null ? fps + ' fps' : '—'}</strong></div>
          </div>
        </div>
` : ''}
      </div>
${isActive ? `
      <div class="cv-chrome-top-right">
        <div class="cv-tr-row">
          ${c.rtsp_url ? `<button class="cv-hd-badge${hdOn ? ' active' : ''}" type="button" data-cam="${esc(c.id)}" onclick="event.stopPropagation();toggleCardHd('${esc(c.id)}',this)" title="HD-Vorschau" aria-label="HD-Vorschau ein/aus">HD</button>` : ''}
          ${c.rtsp_url ? `<button class="cv-fs-btn" type="button" data-cam="${esc(c.id)}" onclick="event.stopPropagation();window._cvEnterFullscreen && window._cvEnterFullscreen('${esc(c.id)}')" title="Vollbild" aria-label="Vollbild">
            <svg class="fs-icon-expand" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 14v7h7"/><path d="M21 10V3h-7"/>
              <path d="M3 21l8-8"/><path d="M21 3l-8 8"/>
            </svg>
            <svg class="fs-icon-minimize" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M10 3v7H3"/><path d="M14 21v-7h7"/>
              <path d="M10 10L3 3"/><path d="M14 14l7 7"/>
            </svg>
          </button>` : ''}
        </div>
        ${tlOn ? `<div class="cv-pill cv-pill-tl" title="Timelapse aktiv">${objIconSvg('timelapse', 14)}Timelapse</div>` : ''}
      </div>
` : ''}
      <div class="cv-chrome-bottom-left"></div>
      <div class="cv-chrome-bottom-right">
        ${c.rtsp_url && isActive ? `<button class="cv-sim-btn" type="button" data-cam="${esc(c.id)}" onclick="event.stopPropagation();window._cvOpenSim && window._cvOpenSim('${esc(c.id)}')" title="Erkennung jetzt simulieren" aria-label="Simulieren">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
          <span>Simulieren</span>
        </button>` : ''}
        <button class="cv-cog" type="button" onclick="event.stopPropagation();editCamera('${esc(c.id)}')" title="Einstellungen" aria-label="Einstellungen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
</article>`;
  }).join('');
  // Wire the live-pill hover/touch open/close per card (one set of
  // listeners per render; innerHTML wipes prior listeners). The
  // touch-outside handler closes any open pill when the user taps
  // somewhere else on the page.
  // One-shot wiring of the HD idle-timer reset listener (cm-52
  // task #5c). The listener attaches to the parent grid element so
  // it survives the innerHTML rebuild above; the wired-flag inside
  // the helper prevents double-binding across re-renders.
  _wireHdIdleReset();
  byId('cameraCards').querySelectorAll('.cv-pill-live-wrap').forEach(el => {
    // Open/close on hover (desktop) and tap (mobile). The pill flips
    // between collapsed (display:flex row) and expanded (the detail
    // panel inside) via the .cv-lp-open class — see 03-dashboard.css.
    // No JS-measured CSS variables: the rewrite drops --lp-collapsed-w
    // because the CSS no longer references it, and the JS-injected
    // width was contributing to the prior iOS stretch bug.
    let _t = null;
    el.addEventListener('mouseenter', () => { clearTimeout(_t); el.classList.add('cv-lp-open'); });
    el.addEventListener('mouseleave', () => { _t = setTimeout(() => el.classList.remove('cv-lp-open'), 120); });
    el.addEventListener('touchstart', e => { e.stopPropagation(); clearTimeout(_t); const open = el.classList.toggle('cv-lp-open'); if (!open) clearTimeout(_t); }, { passive: true });
    document.addEventListener('touchstart', e => { if (!el.contains(e.target)) { clearTimeout(_t); el.classList.remove('cv-lp-open'); } }, { passive: true });
  });
}

// Reload-state animation. Either targets a single camera by id (after
// a "Verbinden" click on a row, after a save that triggered a runtime
// rebuild) or every visible tile (after a global reload). Polls
// /api/cameras every 2 s up to 15 attempts, swapping the placeholder
// to the blue VERBINDE… while waiting and re-rendering on the first
// status==='active' return.
export function showCameraReloadAnimation(camId){
  const cameraCards = byId('cameraCards');
  const cards = camId
    ? [cameraCards?.querySelector(`[data-camid="${CSS.escape(camId)}"]`)]
    : [...(cameraCards?.querySelectorAll('[data-camid]') || [])];
  cards.filter(Boolean).forEach(card => {
    const placeholder = card.querySelector('.cv-loading-placeholder');
    const img = card.querySelector('.cv-img');
    if (placeholder && !placeholder.querySelector('.cv-ph--blue'))
      placeholder.innerHTML = _makeConnectingPlaceholder();
    if (img) { img.classList.remove('loaded'); img.style.opacity = '0'; }
    const targetCamId = card.dataset.camid;
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      if (attempts > 15) { clearInterval(poll); _restorePlaceholder(card); return; }
      try {
        const r = await j('/api/cameras');
        const cam = (r.cameras || []).find(c => c.id === targetCamId);
        if (cam?.status === 'active') {
          clearInterval(poll);
          state.cameras = r.cameras || state.cameras;
          renderDashboard();
        }
      } catch {}
    }, 2000);
  });
}

export async function reloadCamera(camId){
  showCameraReloadAnimation(camId);
  await fetch(`/api/camera/${encodeURIComponent(camId)}/reload`, { method: 'POST' }).catch(() => {});
}

// ── Legacy global bridges ──────────────────────────────────────────────────
// Inline onclick handlers inside renderDashboard's template strings
// reach these via window. `_cvCardClick` was retired in cm-52 (tile
// body became inert); the FS + SIM handlers attach lazily from
// dedicated modules.
window.toggleCardHd           = toggleCardHd;
window._refreshLivePillForCard = _refreshLivePillForCard;
window.reloadCamera           = reloadCamera;
