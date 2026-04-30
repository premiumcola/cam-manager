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
import { byId } from './core/dom.js';

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
