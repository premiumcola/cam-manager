// ─── core/icons.js ─────────────────────────────────────────────────────────
// German label dictionary + inline SVG icon library shared across the
// dashboard, mediathek, lightbox, timeline, camera-edit and weather
// modules. The per-class colour palette lives in core/class-colors.js
// (the single source of truth) — `colors` here re-exports those plus
// a handful of non-class chrome entries (alarm, unknown, coral, etc.).
import { CLASS_COLORS } from './class-colors.js';

export const colors = {
  ...CLASS_COLORS,
  // Non-class extensions kept local — chrome tones, event-state tints,
  // legacy keys outside the canonical class set.
  alarm:        '#ef4444',
  unknown:      '#4a6477',
  timelapse:    '#a855f7',
  motion_objects: '#c084fc',
  coral:        '#f472b6',
  object:       '#f472b6',
  notification: '#5bc8f5',
};

export const OBJ_LABEL = {
  person:        'Person',
  cat:           'Katze',
  bird:          'Vogel',
  car:           'Auto',
  dog:           'Hund',
  squirrel:      'Eichhörnchen',
  motion:        'Bewegung',
  alarm:         'Alarm',
  timelapse:     'Timelapse',
  motion_objects:'Objekt · Motion',
  object:        'Objekt',
  notification:  'Benachrichtigung',
};

// Inline SVG icon set — kept as raw 16×16 strings; objIconSvg below
// rescales them by replacing the width/height attribute. Designed to
// read at small sizes (chip, badge, pill) and at large sizes
// (lightbox label bubbles, dashboard placeholders).
export const OBJ_SVG = {
  person:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="7" r="4.5" fill="#facc15"/><path d="M4 22c0-4.4 3.6-8 8-8s8 3.6 8 8" stroke="#facc15" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>`,
  cat:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><polygon points="5,11 2,4 9.5,9" fill="#fb923c"/><polygon points="19,11 22,4 14.5,9" fill="#fb923c"/><circle cx="12" cy="15" r="7" fill="#fb923c"/><circle cx="9" cy="14.5" r="1.6" fill="#fff" opacity=".9"/><circle cx="15" cy="14.5" r="1.6" fill="#fff" opacity=".9"/><circle cx="9" cy="14.5" r=".7" fill="#7c2d12"/><circle cx="15" cy="14.5" r=".7" fill="#7c2d12"/><path d="M10 18q2 1.5 4 0" stroke="#fff" stroke-width="1.2" stroke-linecap="round" fill="none" opacity=".75"/></svg>`,
  bird:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M2 12C5.5 7 9.5 9 12 13C14.5 9 18.5 7 22 12" fill="#38bdf8"/><ellipse cx="12" cy="15.5" rx="3.5" ry="2.5" fill="#38bdf8"/><circle cx="17.5" cy="10.5" r="2" fill="#38bdf8"/><circle cx="18.5" cy="10" r=".85" fill="#fff" opacity=".9"/><path d="M12 18v3" stroke="#38bdf8" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  car:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="2" y="11" width="20" height="8" rx="2.5" fill="#f87171"/><rect x="6" y="7" width="11" height="5" rx="2" fill="#fca5a5"/><circle cx="7" cy="20" r="2.5" fill="#1e293b"/><circle cx="17" cy="20" r="2.5" fill="#1e293b"/><circle cx="7" cy="20" r="1.2" fill="#7f1d1d"/><circle cx="17" cy="20" r="1.2" fill="#7f1d1d"/><rect x="14.5" y="8" width="3" height="3.5" rx=".75" fill="rgba(255,255,255,.35)"/></svg>`,
  motion:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M1 12 C4 5 7 5 9 12 C11 19 14 19 16 12 C18 5 21 5 23 12" stroke="#cbd5e1" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg>`,
  alarm:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 3C7 3 4 7.5 4 12C4 17 7 19 7 19H17C17 19 20 17 20 12C20 7.5 17 3 12 3Z" fill="#ef4444"/><rect x="11" y="19" width="2" height="2.5" rx=".75" fill="#ef4444"/><rect x="9.5" y="21.5" width="5" height="1.5" rx=".75" fill="#ef4444"/><rect x="11.2" y="8" width="1.6" height="5.5" rx=".75" fill="#fff"/><circle cx="12" cy="15.5" r="1.1" fill="#fff"/></svg>`,
  timelapse:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2" stroke-linecap="round"><line x1="6" y1="3" x2="18" y2="3"/><line x1="6" y1="21" x2="18" y2="21"/><polygon points="7,4 17,4 12,12" fill="#a855f7" opacity=".8"/><polygon points="12,12 7,20 17,20" fill="#a855f7" opacity=".5"/></svg>`,
  motion_objects:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15A2.5 2.5 0 0 1 9.5 22a2.5 2.5 0 0 1-2.5-2.5V17a2.5 2.5 0 0 1-2-4.5 2.5 2.5 0 0 1 0-4A2.5 2.5 0 0 1 7 4.5 2.5 2.5 0 0 1 9.5 2z" fill="rgba(244,114,182,.22)" stroke="#f472b6" stroke-width="1.5" stroke-linejoin="round"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15A2.5 2.5 0 0 0 14.5 22a2.5 2.5 0 0 0 2.5-2.5V17a2.5 2.5 0 0 0 2-4.5 2.5 2.5 0 0 0 0-4A2.5 2.5 0 0 0 17 4.5 2.5 2.5 0 0 0 14.5 2z" fill="rgba(244,114,182,.22)" stroke="#f472b6" stroke-width="1.5" stroke-linejoin="round"/><path d="M1 12 C3 8 5.5 8 7 12 C8.5 16 11 16 12 12 C13 8 15.5 8 17 12 C18.5 16 21 16 23 12" stroke="#cbd5e1" stroke-width="1.6" stroke-linecap="round" fill="none" opacity=".95"/><circle cx="7" cy="12" r="1.1" fill="#c084fc"/><circle cx="17" cy="12" r="1.1" fill="#c084fc"/></svg>`,
  object:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f472b6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15A2.5 2.5 0 0 1 9.5 22a2.5 2.5 0 0 1-2.5-2.5V17a2.5 2.5 0 0 1-2-4.5 2.5 2.5 0 0 1 0-4A2.5 2.5 0 0 1 7 4.5 2.5 2.5 0 0 1 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15A2.5 2.5 0 0 0 14.5 22a2.5 2.5 0 0 0 2.5-2.5V17a2.5 2.5 0 0 0 2-4.5 2.5 2.5 0 0 0 0-4A2.5 2.5 0 0 0 17 4.5 2.5 2.5 0 0 0 14.5 2z"/></svg>`,
  notification:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21.5 3L2.5 10.8 9.5 13 12 20 21.5 3z" fill="#229ED9" stroke="#229ED9" stroke-width="1" stroke-linejoin="round"/><path d="M9.5 13L21.5 3" stroke="rgba(255,255,255,.45)" stroke-width=".9" stroke-linecap="round"/><g transform="translate(14.5 1.5) rotate(18)"><path d="M5 0.5C3.3 0.5 2.2 2 2.2 3.8C2.2 5.6 3 6.3 3 6.3H7C7 6.3 7.8 5.6 7.8 3.8C7.8 2 6.7 0.5 5 0.5Z" fill="#ef4444"/><rect x="4.4" y="6.3" width="1.2" height="1.1" rx=".35" fill="#ef4444"/><rect x="3.8" y="7.4" width="2.4" height=".75" rx=".35" fill="#ef4444"/><circle cx="5" cy="4" r=".55" fill="#fff"/></g></svg>`,
  dog:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M7 14.5C7 12 9.2 10.5 12 10.5C14.8 10.5 17 12 17 14.5C17 17 14.8 19.5 12 19.5C9.2 19.5 7 17 7 14.5Z" fill="#7c2d12"/><ellipse cx="6.5" cy="8.5" rx="1.7" ry="2.2" fill="#7c2d12"/><ellipse cx="17.5" cy="8.5" rx="1.7" ry="2.2" fill="#7c2d12"/><ellipse cx="9.5" cy="5" rx="1.5" ry="2" fill="#7c2d12"/><ellipse cx="14.5" cy="5" rx="1.5" ry="2" fill="#7c2d12"/></svg>`,
  squirrel:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M19 19C19 21 17 22 14 22H8C6 22 5 20.5 5 19C5 16.5 7 15 9 15C11 15 12 16 13 16C14 16 14.5 14 14.5 12.5C14.5 9 11 7 11 5C11 3 12.5 1.5 14.5 2C16 2.4 17 3.8 17 5.5C17 7 16 8 16 9.5C16 11 17 13 18 14.5C19 16 19 17.5 19 19Z" fill="#7c4a1f"/><polygon points="13,2 14.5,0.5 15.5,2.2" fill="#7c4a1f"/><polygon points="15,1.5 16.5,0 17,2" fill="#7c4a1f"/><circle cx="14" cy="4.5" r=".55" fill="#fff"/></svg>`,
};

// "Bubble" rendering — colored circle with the icon inside, sized
// proportionally. Used by the dashboard tile overlays + lightbox
// label chips.
export function objBubble(label, size = 22) {
  const raw = OBJ_SVG[label] || OBJ_SVG.alarm;
  const svgPx = Math.round(size * 0.70);
  const svg = raw.replace('width="16" height="16"', `width="${svgPx}" height="${svgPx}"`);
  const c = colors[label] || colors.unknown;
  const r = Math.max(6, Math.round(size * 0.38));
  return `<span style="width:${size}px;height:${size}px;border-radius:${r}px;`
    + `background:${c}40;border:1.5px solid ${c}80;backdrop-filter:blur(3px);`
    + `display:inline-flex;align-items:center;justify-content:center;`
    + `flex-shrink:0">${svg}</span>`;
}

// Bare icon — same SVG as objBubble's inner glyph but without the
// surrounding bubble. Used when a callsite already provides its own
// container (e.g. inside a pill or chip).
export function objIconSvg(label, size = 18) {
  const raw = OBJ_SVG[label] || OBJ_SVG.alarm;
  return raw.replace('width="16" height="16"', `width="${size}" height="${size}"`);
}

// The fixed object label order used by the lightbox chip strip and a
// few legacy callsites that iterate "all known classes" in a
// deterministic order.
export const TL_LABELS = ['person', 'cat', 'bird', 'car', 'dog', 'squirrel', 'motion', 'alarm'];

// E5 (re-rev) · Camera name → SVG keyword routing. MASSIVE filled
// silhouettes — fill="currentColor", no strokes — so the icon reads
// cleanly even at small dashboard tile sizes and never fades into a
// hairline against a daylight snapshot. Every entry carries an
// explicit width/height attribute AND the shared ``.cam-ico`` class
// so consumers without an override land at the canonical 20 × 20 px
// baseline (CSS rule in 03-dashboard.css under the comment header
// "cam-ico baseline") instead of inheriting the parent's intrinsic
// size — which was the v17-followup-Auslöser: SVGs blowing up to
// container size when the parent had no width/height set. Per-
// consumer overrides (Dashboard tile 32 px, Mediathek placeholder
// 56 px, Statistik donut 18 px, Heatmap 16 px) ride on top via the
// container selector — see ``.cam-ico`` rule comments. */
const _CAM_ICON_SVG = {
  wrench: `<svg class="cam-ico" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.5 2.5a5.5 5.5 0 0 0-5.13 7.4L3 18.27a2.5 2.5 0 0 0 3.54 3.53l8.36-8.37A5.5 5.5 0 1 0 16.5 2.5zm0 8.5a3 3 0 1 1 0-6 3 3 0 0 1 0 6z"/></svg>`,
  squirrel: `<svg class="cam-ico" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 6.5a2.5 2.5 0 1 1 5 0 2.5 2.5 0 0 1-5 0zm5.5 4c-3 0-6.5 2-7.5 5.5C4.5 18 5 21 8 21h7c2 0 3.5-1.5 3.5-3.5 0-1.5-.5-3-1.5-4 1.5 0 3-1 3-2.5s-1-3-3-3c-1 0-1.5.5-2 1-.5-.5-1.5-1-3-1z"/><circle cx="6" cy="4" r="1.5"/></svg>`,
  bird: `<svg class="cam-ico" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22 3l-3.5 1c-3.5 1-6 3.5-7 7L9 17c-.5 1-1.5 1.5-2.5 1.5H4l1.5 1.5c1 1 3 1.5 5 1L13 19c3-1 5-3 6-6l1-4.5L22 3z"/><circle cx="19" cy="6" r=".7" fill="#fff"/></svg>`,
  leaf: `<svg class="cam-ico" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 21c.5-5 2-10 7-13 4-2.5 8-2.5 9-2 .5 1 .5 5-2 9-3 5.5-8 6.5-13 7L5 21z"/></svg>`,
  door: `<svg class="cam-ico" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 2v20h14V2H5zm10 11.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/></svg>`,
  car: `<svg class="cam-ico" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 16h14v-3l-2-4h-10l-2 4v3zm2.5-3.5h9l1-2.5h-11l1 2.5zM7 17h2v1.5H7zM15 17h2v1.5h-2z"/></svg>`,
  water: `<svg class="cam-ico" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3C7 9 5 13 5 16a7 7 0 0 0 14 0c0-3-2-7-7-13z"/></svg>`,
  camera: `<svg class="cam-ico" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 7v13h18V7h-5l-1.5-3h-5L8 7H3zm9 11a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zm0-2.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></svg>`,
};

const _CAM_ICON_TONES = {
  wrench: '#9aa5b3', squirrel: '#b48b6a', bird: '#7faec9', leaf: '#8aa97a',
  door:   '#a37b53', car:      '#c47878', water:'#6fa3bd', camera:'#a8a8a8',
};

function _resolveCamIconKey(name){
  const n = (name || '').toLowerCase();
  if (/werkstatt|garage|keller|labor/.test(n))               return 'wrench';
  if (/eingang|tor|tür|door/.test(n))                        return 'door';
  if (/garten|garden|außen|outdoor/.test(n))                 return 'leaf';
  if (/eichhörnchen|squirrel|tier|animal|natur/.test(n))     return 'squirrel';
  if (/vogel|bird|futter|feeder/.test(n))                    return 'bird';
  if (/parkplatz|auto|car/.test(n))                          return 'car';
  if (/pool|wasser|water/.test(n))                           return 'water';
  return 'camera';
}

export function getCameraIcon(name){
  return _CAM_ICON_SVG[_resolveCamIconKey(name)] || _CAM_ICON_SVG.camera;
}

export function getCameraColor(name){
  return _CAM_ICON_TONES[_resolveCamIconKey(name)] || '#a8a8a8';
}
