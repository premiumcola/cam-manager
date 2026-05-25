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
  alarm: '#ef4444',
  unknown: '#4a6477',
  timelapse: '#a855f7',
  motion_objects: '#c084fc',
  coral: '#f472b6',
  object: '#f472b6',
  notification: '#5bc8f5',
};

export const OBJ_LABEL = {
  person: 'Person',
  cat: 'Katze',
  bird: 'Vogel',
  car: 'Auto',
  dog: 'Hund',
  squirrel: 'Eichhörnchen',
  motion: 'Bewegung',
  alarm: 'Alarm',
  timelapse: 'Timelapse',
  motion_objects: 'Objekt · Motion',
  object: 'Objekt',
  notification: 'Benachrichtigung',
};

// Inline SVG icon set — kept as raw 16×16 strings; objIconSvg below
// rescales them by replacing the width/height attribute. Designed to
// read at small sizes (chip, badge, pill) and at large sizes
// (lightbox label bubbles, dashboard placeholders).
export const OBJ_SVG = {
  person: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="7" r="4.5" fill="#facc15"/><path d="M4 22c0-4.4 3.6-8 8-8s8 3.6 8 8" stroke="#facc15" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>`,
  cat: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M 15 14 C 21 13.5, 22 6.5, 18 6 C 14.5 6, 13.5 9.5, 15.5 11.5" stroke="#fb923c" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M 7 11 C 5 12.5, 4 15, 4 17.5 C 4 19.5, 5 21, 7 21 L 13 21 C 15 21, 16 19.5, 16 17.5 C 16 15, 15 12.5, 13 11 Z" fill="#fb923c"/><ellipse cx="7" cy="21.5" rx="1.3" ry="1.1" fill="#fb923c"/><ellipse cx="13" cy="21.5" rx="1.3" ry="1.1" fill="#fb923c"/><g transform="rotate(-10 10 6.5)"><ellipse cx="10" cy="6.5" rx="3.8" ry="3.5" fill="#fb923c"/><path d="M 6 3.5 L 5 0 L 8 2.8 Z" fill="#fb923c"/><path d="M 14 3.5 L 15 0 L 12 2.8 Z" fill="#fb923c"/><path d="M 6.3 3 L 6 1.5 L 7.5 2.5 Z" fill="#0e1217" opacity="0.22"/><path d="M 13.7 3 L 14 1.5 L 12.5 2.5 Z" fill="#0e1217" opacity="0.22"/><path d="M 7.5 6.5 Q 8.5 5.5, 9.5 6.5" stroke="#0e1217" stroke-width="0.85" fill="none" stroke-linecap="round"/><path d="M 10.5 6.5 Q 11.5 5.5, 12.5 6.5" stroke="#0e1217" stroke-width="0.85" fill="none" stroke-linecap="round"/><path d="M 9.3 8.2 L 10.7 8.2 L 10 9.2 Z" fill="#0e1217"/><path d="M 8.8 9.8 Q 10 10.7, 11.2 9.8" stroke="#0e1217" stroke-width="0.45" fill="none" stroke-linecap="round"/><path d="M 6.3 8.5 L 4 8 M 6.3 9.2 L 4 9.4 M 6.3 9.9 L 4.2 10.7 M 13.7 8.5 L 16 8 M 13.7 9.2 L 16 9.4 M 13.7 9.9 L 15.8 10.7" stroke="#0e1217" stroke-width="0.3" opacity="0.5" stroke-linecap="round"/></g></svg>`,
  bird: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><ellipse cx="13" cy="13.5" rx="5.8" ry="5" fill="#62d26f"/><circle cx="5.5" cy="8.5" r="3.3" fill="#62d26f"/><path d="M 4 10 Q 6 11.5, 9 12.5 L 9 14 Q 5.5 14.5, 4 11.5 Z" fill="#62d26f"/><path d="M 2.5 8.5 L -0.3 9.3 L 3 10.5 Z" fill="#f59e0b"/><circle cx="5" cy="8" r="0.6" fill="#0e1217"/><circle cx="5.18" cy="7.82" r="0.2" fill="#fff"/><path d="M 9.5 12 Q 13 12.8, 17 13.5 Q 18.5 13.5, 19 14" stroke="#0e1217" stroke-width="0.5" fill="none" opacity="0.5" stroke-linecap="round"/><path d="M 14 13 L 15.8 14.5" stroke="#0e1217" stroke-width="0.4" opacity="0.4" stroke-linecap="round"/><path d="M 15.5 12.5 L 17.3 14" stroke="#0e1217" stroke-width="0.4" opacity="0.4" stroke-linecap="round"/><path d="M 17 12 L 18.5 13.5" stroke="#0e1217" stroke-width="0.4" opacity="0.4" stroke-linecap="round"/><path d="M 18.5 15 L 22 18 L 18 17 Z" fill="#62d26f"/><path d="M 10 18 Q 9 19.5, 9.5 21.5" stroke="#62d26f" stroke-width="1.5" stroke-linecap="round" fill="none"/><path d="M 13.5 18 Q 14 19.5, 13 21.5" stroke="#62d26f" stroke-width="1.5" stroke-linecap="round" fill="none"/><path d="M 8 21.5 L 9.5 21.5 L 11 21.8" stroke="#62d26f" stroke-width="1" stroke-linecap="round"/><path d="M 11.5 21.5 L 13 21.5 L 14.5 21.8" stroke="#62d26f" stroke-width="1" stroke-linecap="round"/></svg>`,
  car: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="2" y="11" width="20" height="8" rx="2.5" fill="#f87171"/><rect x="6" y="7" width="11" height="5" rx="2" fill="#fca5a5"/><circle cx="7" cy="20" r="2.5" fill="#1e293b"/><circle cx="17" cy="20" r="2.5" fill="#1e293b"/><circle cx="7" cy="20" r="1.2" fill="#7f1d1d"/><circle cx="17" cy="20" r="1.2" fill="#7f1d1d"/><rect x="14.5" y="8" width="3" height="3.5" rx=".75" fill="rgba(255,255,255,.35)"/></svg>`,
  motion: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M1 12 C4 5 7 5 9 12 C11 19 14 19 16 12 C18 5 21 5 23 12" stroke="#cbd5e1" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg>`,
  alarm: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 3C7 3 4 7.5 4 12C4 17 7 19 7 19H17C17 19 20 17 20 12C20 7.5 17 3 12 3Z" fill="#ef4444"/><rect x="11" y="19" width="2" height="2.5" rx=".75" fill="#ef4444"/><rect x="9.5" y="21.5" width="5" height="1.5" rx=".75" fill="#ef4444"/><rect x="11.2" y="8" width="1.6" height="5.5" rx=".75" fill="#fff"/><circle cx="12" cy="15.5" r="1.1" fill="#fff"/></svg>`,
  timelapse: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2" stroke-linecap="round"><line x1="6" y1="3" x2="18" y2="3"/><line x1="6" y1="21" x2="18" y2="21"/><polygon points="7,4 17,4 12,12" fill="#a855f7" opacity=".8"/><polygon points="12,12 7,20 17,20" fill="#a855f7" opacity=".5"/></svg>`,
  motion_objects: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15A2.5 2.5 0 0 1 9.5 22a2.5 2.5 0 0 1-2.5-2.5V17a2.5 2.5 0 0 1-2-4.5 2.5 2.5 0 0 1 0-4A2.5 2.5 0 0 1 7 4.5 2.5 2.5 0 0 1 9.5 2z" fill="rgba(244,114,182,.22)" stroke="#f472b6" stroke-width="1.5" stroke-linejoin="round"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15A2.5 2.5 0 0 0 14.5 22a2.5 2.5 0 0 0 2.5-2.5V17a2.5 2.5 0 0 0 2-4.5 2.5 2.5 0 0 0 0-4A2.5 2.5 0 0 0 17 4.5 2.5 2.5 0 0 0 14.5 2z" fill="rgba(244,114,182,.22)" stroke="#f472b6" stroke-width="1.5" stroke-linejoin="round"/><path d="M1 12 C3 8 5.5 8 7 12 C8.5 16 11 16 12 12 C13 8 15.5 8 17 12 C18.5 16 21 16 23 12" stroke="#cbd5e1" stroke-width="1.6" stroke-linecap="round" fill="none" opacity=".95"/><circle cx="7" cy="12" r="1.1" fill="#c084fc"/><circle cx="17" cy="12" r="1.1" fill="#c084fc"/></svg>`,
  object: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f472b6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15A2.5 2.5 0 0 1 9.5 22a2.5 2.5 0 0 1-2.5-2.5V17a2.5 2.5 0 0 1-2-4.5 2.5 2.5 0 0 1 0-4A2.5 2.5 0 0 1 7 4.5 2.5 2.5 0 0 1 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15A2.5 2.5 0 0 0 14.5 22a2.5 2.5 0 0 0 2.5-2.5V17a2.5 2.5 0 0 0 2-4.5 2.5 2.5 0 0 0 0-4A2.5 2.5 0 0 0 17 4.5 2.5 2.5 0 0 0 14.5 2z"/></svg>`,
  notification: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21.5 3L2.5 10.8 9.5 13 12 20 21.5 3z" fill="#229ED9" stroke="#229ED9" stroke-width="1" stroke-linejoin="round"/><path d="M9.5 13L21.5 3" stroke="rgba(255,255,255,.45)" stroke-width=".9" stroke-linecap="round"/><g transform="translate(14.5 1.5) rotate(18)"><path d="M5 0.5C3.3 0.5 2.2 2 2.2 3.8C2.2 5.6 3 6.3 3 6.3H7C7 6.3 7.8 5.6 7.8 3.8C7.8 2 6.7 0.5 5 0.5Z" fill="#ef4444"/><rect x="4.4" y="6.3" width="1.2" height="1.1" rx=".35" fill="#ef4444"/><rect x="3.8" y="7.4" width="2.4" height=".75" rx=".35" fill="#ef4444"/><circle cx="5" cy="4" r=".55" fill="#fff"/></g></svg>`,
  dog: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M 12 11 C 8 11, 6 13.5, 6 16.5 C 6 19.5, 8.5 22, 12 22 C 15.5 22, 18 19.5, 18 16.5 C 18 13.5, 16 11, 12 11 Z" fill="#3b82f6"/><path d="M 10 19 L 9.5 14.5 M 12 19.5 L 12 14.3 M 14 19 L 14.5 14.5" stroke="#1e40af" stroke-width="0.55" opacity="0.45" stroke-linecap="round"/><path d="M 9 13 Q 12 12, 15 13" stroke="#60a5fa" stroke-width="0.6" opacity="0.4" stroke-linecap="round" fill="none"/><ellipse cx="4.8" cy="10" rx="2" ry="2.8" fill="#3b82f6"/><ellipse cx="19.2" cy="10" rx="2" ry="2.8" fill="#3b82f6"/><ellipse cx="9" cy="5.5" rx="1.9" ry="2.6" fill="#3b82f6"/><ellipse cx="15" cy="5.5" rx="1.9" ry="2.6" fill="#3b82f6"/><path d="M 3.5 8 L 4.5 7.4 L 4.3 8.5 Z" fill="#1e40af" opacity="0.7"/><path d="M 20.5 8 L 19.5 7.4 L 19.7 8.5 Z" fill="#1e40af" opacity="0.7"/><path d="M 8 3.3 L 9 2.5 L 9.4 3.7 Z" fill="#1e40af" opacity="0.7"/><path d="M 14.6 3.7 L 15 2.5 L 16 3.3 Z" fill="#1e40af" opacity="0.7"/></svg>`,
  squirrel: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M 12 18 Q 17 19, 20 17 Q 22.5 14, 22 9 Q 21 4, 17 3 Q 13 3, 12 6 Q 11 9, 13 11 Q 15 12.5, 17 11 Q 18.5 9.5, 17 7.5 Q 15.5 7, 14.5 8.5 Z" fill="#d97624"/><ellipse cx="20.5" cy="6" rx="1.8" ry="1.4" fill="#e8a06a" opacity="0.7"/><ellipse cx="22" cy="12" rx="1.4" ry="2" fill="#e8a06a" opacity="0.65"/><ellipse cx="18" cy="17" rx="1.6" ry="1.2" fill="#e8a06a" opacity="0.65"/><path d="M 14 10 Q 16 11, 16.8 10 Q 17.2 8.7, 16 8.3 Q 14.5 8.5, 14 10 Z" fill="#f5c294" opacity="0.6"/><g stroke="#a04510" stroke-width="0.42" stroke-linecap="round" fill="none" opacity="0.5"><path d="M 14 8 Q 16 7, 18 6"/><path d="M 19 5 Q 20 7, 20.5 9"/><path d="M 20 11 Q 21 13, 20.5 15"/><path d="M 17 13 Q 18 14.5, 17.5 16"/><path d="M 14 12.5 Q 15 14, 15 16"/></g><g stroke="#d97624" stroke-width="0.85" stroke-linecap="round" fill="none"><path d="M 16.5 3 Q 16.3 1.8, 16 0.8"/><path d="M 18 2.8 Q 18 1.5, 17.8 0.5"/><path d="M 21 4.2 Q 22 3.3, 22.5 2.5"/><path d="M 22.3 8 Q 23.5 7.5, 23.8 7"/><path d="M 22.5 10 Q 23.8 10, 24 9.5"/><path d="M 22.5 12 Q 23.8 12, 24 12.5"/><path d="M 22.2 14 Q 23.3 14.5, 23.5 15"/><path d="M 20.5 17 Q 21 18, 21.3 18.5"/></g><path d="M 4 19 Q 3 20.8, 5.5 20.8 L 11 20.8 Q 13 20.7, 13 18.5 L 13 14 Q 12.5 11, 9 11 Q 6 11, 4.5 13.5 Q 3.5 16.5, 4 19 Z" fill="#c8651a"/><path d="M 6.5 14 Q 8.5 14, 10 15 Q 11 17, 10.5 20 Q 8 20.8, 5.5 20 Q 4.8 17, 5.5 15 Q 6 14, 6.5 14 Z" fill="#f5c294" opacity="0.85"/><circle cx="6" cy="8.8" r="3.3" fill="#c8651a"/><ellipse cx="5" cy="10.5" rx="1.6" ry="1.2" fill="#f5c294" opacity="0.65"/><path d="M 2.5 9 Q 1 9.6, 2.3 10.7 Q 4 11, 4.5 9.7 Z" fill="#c8651a"/><path d="M 4.2 5.8 L 4 2.8 L 5.8 5 Z" fill="#c8651a"/><path d="M 7.2 5.3 L 8.3 2.5 L 8.7 5.8 Z" fill="#c8651a"/><path d="M 4.4 5.3 L 4.4 4 L 5.2 4.8 Z" fill="#7a3c0e"/><path d="M 7.7 5.2 L 8.2 3.8 L 8.4 5.5 Z" fill="#7a3c0e"/><path d="M 4 2.8 L 3.8 1.8 M 8.3 2.5 L 8.4 1.5" stroke="#c8651a" stroke-width="0.6" stroke-linecap="round"/><circle cx="5" cy="8.5" r="0.8" fill="#0e1217"/><circle cx="5.2" cy="8.25" r="0.25" fill="#fff"/><circle cx="2.1" cy="9.7" r="0.45" fill="#0e1217"/><path d="M 3 10.4 Q 3.5 10.9, 4 10.7" stroke="#0e1217" stroke-width="0.32" fill="none" stroke-linecap="round" opacity="0.6"/><ellipse cx="7" cy="14.5" rx="1" ry="1.5" fill="#c8651a" transform="rotate(-15 7 14.5)"/><ellipse cx="11" cy="14.5" rx="1" ry="1.5" fill="#c8651a" transform="rotate(15 11 14.5)"/><ellipse cx="9" cy="14" rx="1.6" ry="1.9" fill="#9a5a2c"/><path d="M 7.3 12.5 Q 9 11, 10.7 12.5 Q 10.5 13.5, 9 13.5 Q 7.5 13.5, 7.3 12.5 Z" fill="#3f2410"/><path d="M 9 11.3 L 9 10.5" stroke="#3f2410" stroke-width="0.45" stroke-linecap="round"/><ellipse cx="6" cy="20.6" rx="1.8" ry="0.7" fill="#a85510"/><ellipse cx="11" cy="20.6" rx="1.8" ry="0.7" fill="#a85510"/></svg>`,
};

// "Bubble" rendering — colored circle with the icon inside, sized
// proportionally. Used by the dashboard tile overlays + lightbox
// label chips.
export function objBubble(label, size = 22) {
  const raw = OBJ_SVG[label] || OBJ_SVG.alarm;
  const svgPx = Math.round(size * 0.7);
  const svg = raw.replace('width="16" height="16"', `width="${svgPx}" height="${svgPx}"`);
  const c = colors[label] || colors.unknown;
  const r = Math.max(6, Math.round(size * 0.38));
  return (
    `<span style="width:${size}px;height:${size}px;border-radius:${r}px;` +
    `background:${c}40;border:1.5px solid ${c}80;backdrop-filter:blur(3px);` +
    `display:inline-flex;align-items:center;justify-content:center;` +
    `flex-shrink:0">${svg}</span>`
  );
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

// Camera name → SVG keyword routing. CHARACTERFUL stroked
// illustrations restored after the 2026-05-13 "filled silhouettes"
// pass (de7c4e2) flattened them into chunky shapes. Each entry uses
// ``fill="none" stroke="currentColor" stroke-width=1.8`` with round
// linecap/linejoin so the glyph reads as an illustration rather than
// a mass — the wrench has a real handle and hex head, the squirrel
// has body + tail + paws, the camera carries a real lens detail.
// Every entry keeps the shared ``.cam-ico`` class AND explicit
// width/height attributes (20 × 20) so consumers without a size
// override land at the canonical baseline (CSS rule in
// 03-dashboard.css under the "cam-ico baseline" comment) and don't
// inherit the parent's intrinsic size. Per-consumer overrides
// (Dashboard tile, Mediathek placeholder, Statistik donut, Heatmap)
// ride on top via the container selector. Per-camera tinting via
// --cam-color flows through ``currentColor`` unchanged.
const _CAM_ICON_SVG = {
  wrench: `<svg class="cam-ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.77 3.77z"/></svg>`,
  squirrel: `<svg class="cam-ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="11" r="3"/><path d="M5.5 8.8 L 6 6.5 L 7.5 8"/><path d="M4 11 L 3 12 L 4 13"/><path d="M9 12 q4 1 4 5 v2 h-6 q-1 -3 0 -5"/><circle cx="5.5" cy="15" r="1.3"/><path d="M13 17 q6 0 7 -5 q0.5 -5 -3.5 -6 q-2.5 0 -2.5 2"/><circle cx="7" cy="10.6" r="0.5" fill="currentColor"/></svg>`,
  leaf: `<svg class="cam-ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21c.5-5 2-10 7-13 4-2.5 8-2.5 9-2 .5 1 .5 5-2 9 -3 5-8 6.5-13 7z"/><path d="M5 21l10-10"/></svg>`,
  bird: `<svg class="cam-ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6c-3.5-1-7 1-8 5l-2 7l5-3c3 2 7 0 8-4"/><circle cx="15.5" cy="6" r=".9" fill="currentColor"/></svg>`,
  door: `<svg class="cam-ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17"/><path d="M3 21h18"/><circle cx="14" cy="13" r=".9" fill="currentColor"/></svg>`,
  car: `<svg class="cam-ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 16h14v-3l-2-4h-10l-2 4v3z"/><circle cx="8" cy="16" r="1.5"/><circle cx="16" cy="16" r="1.5"/></svg>`,
  water: `<svg class="cam-ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 C 7 9 5 13 5 16 a 7 7 0 0 0 14 0 c 0 -3 -2 -7 -7 -13 z"/></svg>`,
  camera: `<svg class="cam-ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7l1.5-3h5L16 7"/><circle cx="12" cy="13" r="3.5"/></svg>`,
};

const _CAM_ICON_TONES = {
  wrench: '#9aa5b3',
  squirrel: '#b48b6a',
  bird: '#7faec9',
  leaf: '#8aa97a',
  door: '#a37b53',
  car: '#c47878',
  water: '#6fa3bd',
  camera: '#a8a8a8',
};

function _resolveCamIconKey(name) {
  const n = (name || '').toLowerCase();
  if (/werkstatt|garage|keller|labor/.test(n)) return 'wrench';
  if (/eingang|tor|tür|door/.test(n)) return 'door';
  if (/garten|garden|außen|outdoor/.test(n)) return 'leaf';
  if (/eichhörnchen|squirrel|tier|animal|natur/.test(n)) return 'squirrel';
  if (/vogel|bird|futter|feeder/.test(n)) return 'bird';
  if (/parkplatz|auto|car/.test(n)) return 'car';
  if (/pool|wasser|water/.test(n)) return 'water';
  return 'camera';
}

export function getCameraIcon(name) {
  return _CAM_ICON_SVG[_resolveCamIconKey(name)] || _CAM_ICON_SVG.camera;
}

// tx412 — polymorphic on (string|camera object). Passing the whole
// camera object honours a user-set `color` override (set via the
// Color-Picker in cam-edit's Allgemein tab). Passing just the name
// preserves the legacy contract: derive a default tone from the
// keyword regex on the display name. Existing callers (discovery
// previews + the few cam-name-only paths) keep working unchanged.
//
// P21 · the user-set `.color` override is the only user-input path
// in this function — gate it through a hex-only regex so consumers
// that interpolate the return value into inline `style="color:…"` or
// inline-JS attribute strings can't be tricked into running script.
// Backend schema is set to (str, ...) without a regex check, so the
// frontend must do the final validation. Non-hex values fall back to
// the name-derived auto-tone, matching the "no override" semantics.
const _HEX_RE = /^#[0-9a-f]{3,8}$/i;
export function getCameraColor(nameOrCamera) {
  if (nameOrCamera && typeof nameOrCamera === 'object') {
    if (nameOrCamera.color && _HEX_RE.test(nameOrCamera.color)) {
      return nameOrCamera.color;
    }
    return _CAM_ICON_TONES[_resolveCamIconKey(nameOrCamera.name)] || '#a8a8a8';
  }
  return _CAM_ICON_TONES[_resolveCamIconKey(nameOrCamera)] || '#a8a8a8';
}

// ── P32 · Dashboard chrome SVGs ────────────────────────────────────────────
// Moved out of dashboard.js so the inline-SVG count there stays grep-able
// and so other modules can mount the same chrome icons without
// re-duplicating the strokes. currentColor inheritance lets every consumer
// tint via its own parent rule.
export const DASHBOARD_SVG = {
  // Settings cog · bottom-right chrome cluster
  cog: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  // Simulation glyph — dashed circle + play triangle
  sim: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="7.5" stroke-dasharray="2.5 2.5"/><path d="M 10 8 L 16 12 L 10 16 Z" fill="currentColor" stroke="none"/></svg>`,
  // Expand · two diagonal arrows pointing away from centre
  expand: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4 L20 4 L20 9"/><path d="M20 4 L12 12"/><path d="M9 20 L4 20 L4 15"/><path d="M4 20 L12 12"/></svg>`,
  // Minimize · mirror of expand
  minimize: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 12 L20 12 L20 17"/><path d="M20 12 L12 4"/><path d="M9 12 L4 12 L4 7"/><path d="M4 12 L12 20"/></svg>`,
  // Telegram paper-plane
  telegram: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 L11 13"/><path d="M22 2 L15 22 L11 13 L2 9 Z"/></svg>`,
  // MQTT antenna broadcast
  mqtt: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><path d="M8.5 8.5 a 5 5 0 0 0 0 7"/><path d="M15.5 8.5 a 5 5 0 0 1 0 7"/><path d="M5.6 5.6 a 9 9 0 0 0 0 12.8"/><path d="M18.4 5.6 a 9 9 0 0 1 0 12.8"/></svg>`,
};
