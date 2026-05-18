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
import { getCameraIcon, getCameraColor, OBJ_LABEL } from './core/icons.js';
import { isIOS } from './core/ios-video.js';
import { openLiveViewIosNative } from './chrome/live-view.js';

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

// Flat-design camera SVGs — filled silhouettes with tonal-shift depth.
// No hairline strokes (would alias under transform:scale at small
// tiles); each layer is a filled shape so the icon stays crisp at
// 52–72 px renders. Lens uses dark-mass + light-iris for "flat depth"
// instead of a stroked outline. The red slash is a 6 px-wide
// parallelogram, not a stroke, so it doesn't thin under animation.
const _CAM_OFF_SVG = `<svg viewBox="0 0 48 48" width="72" height="72" aria-hidden="true" style="display:block">
  <rect x="8" y="14" width="24" height="20" rx="3" fill="rgba(255,255,255,0.32)"/>
  <path d="M32 20 L40 14 V34 L32 28 Z" fill="rgba(255,255,255,0.22)"/>
  <circle cx="20" cy="24" r="5" fill="rgba(0,0,0,0.5)"/>
  <circle cx="20" cy="24" r="2" fill="rgba(255,255,255,0.55)"/>
  <polygon points="7,3 3,7 41,45 45,41" fill="rgba(239,68,68,0.95)"/>
</svg>`;
const _CAM_SM_SVG = `<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true" style="display:block">
  <rect x="8" y="14" width="24" height="20" rx="3" fill="rgba(59,130,246,0.42)"/>
  <path d="M32 20 L40 14 V34 L32 28 Z" fill="rgba(59,130,246,0.28)"/>
  <circle cx="20" cy="24" r="5" fill="rgba(8,17,38,0.85)"/>
  <circle cx="20" cy="24" r="2" fill="rgba(147,197,253,0.95)"/>
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
        <circle cx="0" cy="0" r="85" fill="rgba(59,130,246,0.05)"/>
        <circle cx="0" cy="0" r="45" fill="rgba(59,130,246,0.07)"/>
      </svg>
      <svg class="cv-ph-radar" viewBox="-100 -100 200 200" aria-hidden="true">
        <path d="M0,0 L85,-49 A98,98 0 0 1 85,49 Z" fill="rgba(59,130,246,0.2)"/>
        <circle class="cv-ph-radar-dot" cx="85" cy="49" r="5" fill="rgba(59,130,246,0.95)"/>
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

// ── E2 · adaptive overlay palette via per-region luminance sampling ────
// Every ~2 s each visible tile's snapshot is sub-sampled at three
// distinct regions — identity (top-left), telegram (mid-bottom-left),
// classicons (bottom-strip) — and each region's mean Rec.709 luminance
// is fed through a hysteresis filter (5 % min gap) that flips
// data-bg="light" / "dark" on the corresponding .cv-overlay-region
// element. CSS variables scoped to each region then flip text/icon
// palette + halo direction so overlays stay legible even when the
// snapshot has strong vertical luminance gradients (bright sky over
// dark interior, etc.). Buttons stay dark in both modes — they live
// outside the regions and read a static drop-shadow filter.
const _BG_LUM_LIGHT_ENTER = 0.55;   // dark → light if Y above
const _BG_LUM_DARK_ENTER  = 0.50;   // light → dark if Y below
const _OVERLAY_REGIONS = [
  // top-left identity (icon · name · live-pill)
  { region: 'identity',   x: 0.00, y: 0.00, w: 0.40, h: 0.22 },
  // mid-bottom-left telegram/MQTT cluster row
  { region: 'telegram',   x: 0.00, y: 0.62, w: 0.38, h: 0.26 },
  // bottom-strip class-icon row
  { region: 'classicons', x: 0.00, y: 0.86, w: 0.38, h: 0.14 },
];
let _bgLumCanvas = null;
let _bgLumCtx = null;
let _bgLumInterval = null;

function _ensureBgLumCanvas(){
  if (_bgLumCanvas) return;
  // 8×8 destination is plenty for an averaging sampler — each region
  // gets the same small target so the four bytes per pixel stay
  // dominated by the source-region's content, not by canvas resize
  // artefacts.
  _bgLumCanvas = document.createElement('canvas');
  _bgLumCanvas.width = 8;
  _bgLumCanvas.height = 8;
  _bgLumCtx = _bgLumCanvas.getContext('2d', { willReadFrequently: true });
}

function _sampleTileOverlayLuminance(card){
  const img = card.querySelector('.cv-img');
  if (!img || !img.classList.contains('loaded')) return;
  const W = img.naturalWidth, H = img.naturalHeight;
  if (!W || !H) return;
  _ensureBgLumCanvas();
  for (const spec of _OVERLAY_REGIONS){
    const target = card.querySelector(
      `.cv-overlay-region[data-region="${spec.region}"]`,
    );
    if (!target) continue;
    const sx = Math.floor(W * spec.x);
    const sy = Math.floor(H * spec.y);
    const sw = Math.max(1, Math.floor(W * spec.w));
    const sh = Math.max(1, Math.floor(H * spec.h));
    try {
      _bgLumCtx.clearRect(0, 0, 8, 8);
      _bgLumCtx.drawImage(img, sx, sy, sw, sh, 0, 0, 8, 8);
      const data = _bgLumCtx.getImageData(0, 0, 8, 8).data;
      let sum = 0, n = 0;
      for (let i = 0; i < data.length; i += 4){
        const r = data[i], g = data[i + 1], b = data[i + 2];
        sum += (0.2126 * r + 0.7152 * g + 0.0722 * b);
        n++;
      }
      if (!n) continue;
      const Y = sum / (n * 255);
      const current = target.dataset.bg || 'dark';
      let next = current;
      if (current === 'dark'  && Y > _BG_LUM_LIGHT_ENTER) next = 'light';
      else if (current === 'light' && Y < _BG_LUM_DARK_ENTER) next = 'dark';
      if (next !== current) target.dataset.bg = next;
    } catch {
      // Canvas can taint on cross-origin pixels — same-origin
      // snapshots shouldn't trigger this in practice. Swallow so a
      // single bad frame on one region doesn't kill the loop for
      // the rest of the tile.
    }
  }
}

export function startBgLuminanceMonitor(){
  if (_bgLumInterval) clearInterval(_bgLumInterval);
  _bgLumInterval = setInterval(() => {
    if (document.hidden) return;
    const grid = byId('cameraCards');
    if (!grid) return;
    grid.querySelectorAll('.cv-card[data-camid]').forEach(card => {
      _sampleTileOverlayLuminance(card);
    });
  }, 2000);
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
// jt719 — HD auto-revert. The previous 10-min timer was effectively
// "never" for the kind of peek-at-HD-and-walk-away pattern users
// actually hit. 120 s is the new default: long enough for an active
// inspection, short enough that a forgotten HD stream stops eating
// CPU + bandwidth quickly. Any interaction with the tile resets the
// countdown; the visual ring under the badge shrinks from full to
// zero over the same duration so the user sees the timer instead of
// being surprised when HD flips back to SD.
const _HD_IDLE_TIMEOUT_MS = 120 * 1000;
const _hdIdleTimers = new Map();  // camId → { handle, deadline, paused, remaining }

function _refreshHdRing(_camId){
  // J1 · the visual countdown bar (jt719) was removed because it
  // read as a rendering artefact on iPhone. The 120 s auto-revert
  // timer still fires via _armHdIdleTimer below; this function is
  // kept as a no-op so existing call sites stay valid without
  // pulling apart the timer-arm flow. _hdDur + data-hd-running
  // stamps are gone too — the DOM no longer carries inert state.
}

function _armHdIdleTimer(camId){
  _clearHdIdleTimer(camId);
  _refreshHdRing(camId);
  if (document.hidden){
    // jt719 — was "pause until tab visible". New spec: revert
    // immediately. Backgrounding the tab is a strong "I'm done
    // looking at this" signal; carrying HD across an unbounded
    // hidden period wastes bandwidth for no user benefit.
    _onHdIdleTimeout(camId);
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
  if (!document.hidden) return;
  // jt719 — backgrounded tab → revert every active HD session.
  // Spec: "When the tab becomes visible again, resume on sub
  // unless the user explicitly re-clicks HD." Auto-revert handles
  // the "resume on sub" part by switching the stream now; the
  // re-click requirement falls out for free because nothing
  // re-arms automatically.
  for (const camId of Array.from(_hdCards)){
    _onHdIdleTimeout(camId);
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
  // P1 · iOS-only path. openLiveViewIosNative keeps the app's live
  // modal entirely hidden — only a minimal Matrix-mono loading
  // overlay shows while HLS warms up, then the native iOS system
  // player takes over via webkitEnterFullscreen. Dismissing the
  // native player returns straight to the all-cams home (no app
  // modal chrome is rendered at any point on iOS). Desktop falls
  // through to the wrap-level requestFullscreen + .fake-fullscreen
  // fallback below.
  if (isIOS){
    openLiveViewIosNative(camId);
    return;
  }
  // Snapshot HD state at FS-enter — drives the auto-drop rule below.
  if (_hdCards.has(camId)) _hdAtFsEntry.add(camId);
  else _hdAtFsEntry.delete(camId);
  const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen || wrap.mozRequestFullScreen;
  if (req){
    // J3.a · stamp `is-fs` IMMEDIATELY on the success path instead
    // of waiting for the fullscreenchange event to fire. On Chrome
    // / Safari Desktop the event can land late (or, on some Edge
    // builds, after a higher-specificity :fullscreen UA rule has
    // already painted the wrong icon). The fullscreenchange handler
    // below is idempotent — toggling here just makes the swap fire
    // at the same instant the browser enters FS rather than one
    // event-loop turn later. The CSS in 03-dashboard.css also
    // mirrors via the :fullscreen pseudo-class so this is belt +
    // suspenders.
    req.call(wrap)
      .then(() => wrap.classList.add('is-fs'))
      .catch(() => {
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
  // jt719 — was "drop HD only if the user turned it on DURING
  // fullscreen". New spec: always drop HD on FS exit. Leaving FS
  // is a strong "done with this view" signal; the user can re-
  // click HD if they really want it back on the dashboard tile.
  const grid = byId('cameraCards');
  if (!grid) return;
  grid.querySelectorAll('.cv-card[data-camid]').forEach(card => {
    const camId = card.dataset.camid;
    if (!_hdCards.has(camId)) return;
    const hdBtn = card.querySelector('.cv-hd-badge');
    if (hdBtn) toggleCardHd(camId, hdBtn);
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

// jh742 — second click on the FS button must exit FS. The previous
// wiring only ever called _cvEnterFullscreen, so the icon flipped to
// the minimize-pattern (driven by .is-fs on the wrap) but clicking
// it did nothing. _cvToggleFullscreen branches: if the wrap is in
// real or fake fullscreen, exit; otherwise enter via the existing
// helper. The fake-fullscreen exit path mirrors the dismiss/escape
// handlers that _cvEnterFullscreen installs on iOS so HD drops and
// classes are cleaned up the same way.
function _cvToggleFullscreen(camId){
  const card = byId('cameraCards')?.querySelector(`[data-camid="${CSS.escape(camId)}"]`);
  const wrap = card?.querySelector('.cv-img-wrap');
  if (!wrap) return;
  const inFs = wrap.classList.contains('is-fs')
            || document.fullscreenElement === wrap
            || document.webkitFullscreenElement === wrap;
  if (inFs){
    if (wrap.classList.contains('fake-fullscreen')){
      wrap.classList.remove('fake-fullscreen');
      wrap.classList.remove('is-fs');
      _runHdDropOnFsExit();
    } else if (document.exitFullscreen){
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitExitFullscreen){
      document.webkitExitFullscreen();
    }
    return;
  }
  _cvEnterFullscreen(camId);
}
window._cvToggleFullscreen = _cvToggleFullscreen;

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

// zg531 — currentColor SVG glyphs for the bottom-left class pills.
// Separate from core/icons.js OBJ_SVG (which carries hard-coded hexes
// for the lightbox / mediathek bbox legend) so the chrome pills can
// inherit colour from the parent's ``color: var(--class-X)``. Each
// glyph is a 24-vb / 16-render Tabler-ish silhouette so it reads at
// a glance even on a 30 px pill.
const _CHROME_CLASS_SVG = {
  person:   `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/></svg>`,
  cat:      `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4l2 5"/><path d="M19 4l-2 5"/><circle cx="12" cy="14" r="7"/><circle cx="9.5" cy="13.2" r=".8" fill="currentColor"/><circle cx="14.5" cy="13.2" r=".8" fill="currentColor"/><path d="M10 17q2 1.5 4 0"/></svg>`,
  dog:      `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4l2.5 4"/><path d="M17 4l-2.5 4"/><circle cx="12" cy="14" r="6.5"/><circle cx="12" cy="13.5" r=".9" fill="currentColor"/><path d="M10 17q2 1.5 4 0"/></svg>`,
  bird:     `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6c-3.5-1-7 1-8 5l-2 7l5-3c3 2 7 0 8-4"/><circle cx="15.5" cy="6" r=".9" fill="currentColor"/></svg>`,
  squirrel: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="17" rx="3.5" ry="2.6"/><circle cx="8" cy="10" r="1.6"/><circle cx="12" cy="8.5" r="1.6"/><circle cx="16" cy="10" r="1.6"/><circle cx="6.4" cy="13" r="1.3"/></svg>`,
  fox:      `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="17" rx="3.5" ry="2.6"/><circle cx="8" cy="10" r="1.6"/><circle cx="12" cy="8.5" r="1.6"/><circle cx="16" cy="10" r="1.6"/><circle cx="6.4" cy="13" r="1.3"/></svg>`,
  hedgehog: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="17" rx="3.5" ry="2.6"/><circle cx="8" cy="10" r="1.6"/><circle cx="12" cy="8.5" r="1.6"/><circle cx="16" cy="10" r="1.6"/><circle cx="6.4" cy="13" r="1.3"/></svg>`,
  car:      `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 16h14v-3l-2-4h-10l-2 4v3z"/><circle cx="8" cy="16" r="1.5"/><circle cx="16" cy="16" r="1.5"/><path d="M5 13h14"/></svg>`,
};

function _chromeClassSvg(cls){
  return _CHROME_CLASS_SVG[cls] || _CHROME_CLASS_SVG.person;
}


// tw284 — currentColor chrome icons for the bottom-right cluster.
// Settings cog glyph for the bottom-right cluster. Uses
// stroke="currentColor" so the parent .cv-chrome-btn's color tints it
// (white in default chrome state). Telegram + MQTT now render as
// dot-and-label pills (see _channelPill) so their dedicated SVGs were
// retired in B2.
const _CHROME_COG_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
// E5 · Simulation glyph — dashed circle + filled play triangle reads
// as a test/run loop, replacing the earlier eye glyph that conflated
// with surveillance/monitoring iconography.
const _CHROME_SIM_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="7.5" stroke-dasharray="2.5 2.5"/><path d="M 10 8 L 16 12 L 10 16 Z" fill="currentColor" stroke="none"/></svg>`;
// Expand icon — two diagonal arrows ↗ + ↙ pointing AWAY from centre.
// Path template (origin-centred, see E1 spec) translated into a
// 0 0 24 24 viewBox by adding 12 to every coord.
const _CHROME_EXPAND_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4 L20 4 L20 9"/><path d="M20 4 L12 12"/><path d="M9 20 L4 20 L4 15"/><path d="M4 20 L12 12"/></svg>`;
// Minimize icon — mirror of expand. Arrows ↘ + ↖ point TOWARD the
// centre with their arrowheads near (12,12) instead of at the
// outer corners.
const _CHROME_MINIMIZE_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 12 L20 12 L20 17"/><path d="M20 12 L12 4"/><path d="M9 12 L4 12 L4 7"/><path d="M4 12 L12 20"/></svg>`;
// E3 · Paper-plane glyph for the Telegram cluster — currentColor so
// the .cv-tg-cluster's `color: var(--tg-fg)` tints it through.
// Stroke-only so the data-bg palette flip carries the colour into
// both light + dark snapshot modes.
const _CHROME_TG_SVG = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 L11 13"/><path d="M22 2 L15 22 L11 13 L2 9 Z"/></svg>`;
// E3 · Antenna-broadcast glyph for the MQTT cluster — five concentric
// arcs emanating from a centre dot. Reads distinctly from the
// Telegram paper-plane at the same 22 × 22 chrome size.
const _CHROME_MQTT_SVG = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><path d="M8.5 8.5 a 5 5 0 0 0 0 7"/><path d="M15.5 8.5 a 5 5 0 0 1 0 7"/><path d="M5.6 5.6 a 9 9 0 0 0 0 12.8"/><path d="M18.4 5.6 a 9 9 0 0 1 0 12.8"/></svg>`;

// Derive the state-dot colour for a notification channel pill.
//   "on"    → currently armed AND in schedule window         → green dot
//   "muted" → enabled but camera is NOT armed (user toggled) → amber dot
//   "idle"  → enabled + armed + outside schedule window       → no dot
function _channelState(c){
  if (!c.armed) return 'muted';
  const sch = (c.schedule_notify && c.schedule_notify.enabled)
    ? c.schedule_notify
    : ((c.schedule && c.schedule.enabled) ? c.schedule : null);
  if (sch && sch.from && sch.to){
    return _isInScheduleWindow(sch.from, sch.to) ? 'on' : 'idle';
  }
  return 'on';  // no schedule defined → always on
}

// B3 · Channel cluster label resolver. Returns the single line shown
// inside the TG/MQTT badge — the two-row "sched · status" composition
// is gone, the schedule window is implied by the wording instead.
//   always-on (no schedule or 00:00↔00:00)        → "aktiv"
//   schedule active, state === 'on'               → "aktiv bis HH:MM"
//   schedule armed but outside window, 'idle'     → "aktiv ab HH:MM"
//   camera disarmed (state === 'muted')           → "Kamera nicht scharf"
// schedule_notify takes precedence over the legacy plain schedule.
function _channelClusterLabel(c, state){
  if (state === 'muted') return 'Kamera nicht scharf';
  const sch = (c.schedule_notify && c.schedule_notify.enabled)
    ? c.schedule_notify
    : ((c.schedule && c.schedule.enabled) ? c.schedule : null);
  // No schedule, or the always-on sentinel: a single word carries
  // the whole meaning. Idle should never reach this branch (no
  // schedule = no idle state) but defaulting to "aktiv" is the
  // benign choice if it does.
  if (!sch || !sch.from || !sch.to || sch.from === sch.to) return 'aktiv';
  if (state === 'on')   return `aktiv bis ${sch.to}`;
  if (state === 'idle') return `aktiv ab ${sch.from}`;
  return 'aktiv';
}

// E3 · Channel cluster — horizontal 3-column unit. Column 1: paper-
// plane / antenna icon (currentColor). Column 2: single-line label
// (B3 — was a 2-row "sched · status" stack before; the new wording
// folds schedule + state into one phrase, so the pill height halves).
// Column 3: active-dot SVG with a pulsing ring while state === 'on'.
// The cluster is NOT clickable. State-driven visibility comes from
// the data-state attribute consumed by the CSS in 03-dashboard.css.
function _channelCluster(c, kind, state){
  const headerLabel = kind === 'mqtt' ? 'MQTT-Kanal' : 'Telegram-Kanal';
  const icon = kind === 'mqtt' ? _CHROME_MQTT_SVG : _CHROME_TG_SVG;
  const label = _channelClusterLabel(c, state);
  return `<div class="cv-channel-cluster cv-${kind}-cluster" data-state="${state}" aria-label="${esc(headerLabel)}">
    <span class="cv-channel-icon" aria-hidden="true">${icon}</span>
    <span class="cv-channel-label">${esc(label)}</span>
    <span class="cv-channel-dot" aria-hidden="true">
      <span class="cv-channel-dot-fill"></span>
      <span class="cv-channel-dot-ring"></span>
    </span>
  </div>`;
}


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
    const fps = c.frame_interval_ms ? Math.round(1000 / c.frame_interval_ms) : null;
    const previewFps = (c.preview_fps || 0) > 0 ? c.preview_fps : null;
    const streamMode = c.stream_mode || 'baseline';
    // Class-filter pills (object_filter list). class_severity === "off"
    // renders the pill muted (opacity .38, no tint). After B3, these
    // sit in the bottom-right cluster alongside the new Telegram /
    // MQTT pills and the Simulieren / cog buttons.
    const _clsSev = c.class_severity || {};
    const _classPills = (c.object_filter || []).map(cls => {
      const muted = _clsSev[cls] === 'off';
      const lbl = OBJ_LABEL[cls] || cls;
      return `<span class="cv-class-pill" data-cls="${esc(cls)}"`
        + (muted ? ' data-state="muted"' : '')
        + ` style="color:var(--class-${esc(cls)})"`
        + ` title="${esc(lbl)}${muted ? ' — stumm' : ''}">`
        + `${_chromeClassSvg(cls)}</span>`;
    }).join('');
    // Telegram + MQTT channel pills. Both render as expandable
    // Live-pill clones (see _channelPill) — pulsing dot + label +
    // chevron, click to expand. The schedule window that used to
    // float above as a separate label now lives inside the pill's
    // detail panel (B3 — see Alarmfenster row in _channelPill).
    const _chanState = _channelState(c);
    const _tgBadge = c.telegram_enabled ? _channelCluster(c, 'tg', _chanState) : '';
    const _mqttBadge = c.mqtt_enabled ? _channelCluster(c, 'mqtt', _chanState) : '';
    // Live-pill collapsed body — extracted as a local so the v17
    // top-left zone can stack it under the camera name without
    // duplicating the detail-panel template. Hidden entirely while
    // the camera isn't active (E1 spec: only icon + name remain).
    const _livePill = isActive ? `<div class="cv-pill-live-wrap cv-live-active">
            <span class="cv-pdot"></span>
            <span class="cv-live-label">Live</span>
            ${previewFps ? `<span class="cv-live-fps">${previewFps} fps</span>` : ''}
            <svg class="cv-live-arrow" width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 4.5l3 3 3-3"/></svg>
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
          </div>` : '';
    return `<article class="cv-card${c.armed ? '' : ' cv-card--muted'}" data-camid="${esc(c.id)}" data-cam-name="${esc(c.name || c.id)}">
  <div class="cv-frame">
    <div class="cv-img-wrap">
      <div class="cv-loading-placeholder">${isActive ? _makeConnectingPlaceholder() : _makeOfflinePlaceholder()}</div>
      <img class="cv-img cam-snap" src="${snapUrl}" alt="${esc(c.name)}" data-hd-mode="${hdOn ? '1' : '0'}"
        onload="_cvImgLoaded(this)"
        onerror="_camImgRetry(this)" />
      <div class="cv-grad-bot"></div>
      <div class="cv-chrome-top-left cv-overlay-region" data-region="identity" data-bg="dark">
        <span class="cv-cam-title-icon" aria-hidden="true" style="--cam-color:${getCameraColor(c)}">${getCameraIcon(c.name)}</span>
        <div class="cv-tl-stack">
          <div class="cv-name">${esc(c.name)}</div>
          ${_livePill}
        </div>
      </div>
${isActive ? `
      <div class="cv-chrome-top-right">
        ${c.rtsp_url ? `<button class="cv-chrome-btn cv-hd-badge has-text${hdOn ? ' active' : ''}" type="button" data-cam="${esc(c.id)}" onclick="event.stopPropagation();toggleCardHd('${esc(c.id)}',this)" title="HD-Vorschau" aria-label="HD-Vorschau ein/aus">HD</button>` : ''}
        ${c.rtsp_url ? `<button class="cv-chrome-btn cv-fs-btn" type="button" data-cam="${esc(c.id)}" onclick="event.stopPropagation();window._cvToggleFullscreen && window._cvToggleFullscreen('${esc(c.id)}')" title="Vollbild" aria-label="Vollbild"><span class="fs-icon-expand">${_CHROME_EXPAND_SVG}</span><span class="fs-icon-minimize">${_CHROME_MINIMIZE_SVG}</span></button>` : ''}
      </div>
      <div class="cv-chrome-bottom-left">
        ${(_tgBadge || _mqttBadge) ? `<div class="cv-channel-row cv-overlay-region" data-region="telegram" data-bg="dark">${_tgBadge}${_mqttBadge}</div>` : ''}
        ${_classPills ? `<div class="cv-class-cluster cv-overlay-region" data-region="classicons" data-bg="dark">${_classPills}</div>` : ''}
      </div>
      <div class="cv-chrome-bottom-right">
        ${c.rtsp_url ? `<button class="cv-chrome-btn cv-sim-btn has-text" type="button" data-cam="${esc(c.id)}" onclick="event.stopPropagation();window._cvOpenSim && window._cvOpenSim('${esc(c.id)}')" title="Erkennung jetzt simulieren" aria-label="Simulieren">${_CHROME_SIM_SVG}<span>Simulieren</span></button>` : ''}
        <button class="cv-chrome-btn cv-cog" type="button" onclick="event.stopPropagation();editCamera('${esc(c.id)}')" title="Einstellungen" aria-label="Einstellungen">${_CHROME_COG_SVG}</button>
      </div>
` : ''}
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
  _wirePillOpenClose();
}

// Open/close wiring for every expandable pill on the dashboard —
// Live-pill + Telegram pill + MQTT pill share the .cv-lp-open class
// and the same click pattern. Delegated via #cameraCards so the
// listener survives renderDashboard's innerHTML rebuilds; the
// _pillWired flag (same idea as _hdIdleWired above) means we only
// bind once per page lifetime. Only ONE pill per tile may be open at
// a time — opening a new pill closes any open sibling in the same
// card (B3 spec: "if Telegram is open and the user clicks Live,
// Telegram collapses first"). A document-level outside-click handler
// closes every open pill when the user taps elsewhere; same
// wire-once guard.
const _PILL_SELECTOR = '.cv-pill-live-wrap';
let _pillWired = false;
function _wirePillOpenClose(){
  if (_pillWired) return;
  const grid = byId('cameraCards');
  if (!grid) return;
  const togglePill = (el) => {
    const wasOpen = el.classList.contains('cv-lp-open');
    const card = el.closest('.cv-card');
    if (card) card.querySelectorAll('.cv-lp-open').forEach(other => {
      if (other !== el) other.classList.remove('cv-lp-open');
    });
    el.classList.toggle('cv-lp-open', !wasOpen);
  };
  grid.addEventListener('click', e => {
    const pill = e.target.closest(_PILL_SELECTOR);
    if (!pill || !grid.contains(pill)) return;
    e.stopPropagation();
    togglePill(pill);
  });
  const closeAllOutside = (e) => {
    if (e.target.closest(_PILL_SELECTOR)) return;
    document.querySelectorAll('.cv-lp-open').forEach(p => p.classList.remove('cv-lp-open'));
  };
  document.addEventListener('click', closeAllOutside);
  document.addEventListener('touchstart', closeAllOutside, { passive: true });
  _pillWired = true;
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
