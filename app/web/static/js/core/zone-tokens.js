// ─── core/zone-tokens.js ───────────────────────────────────────────────────
// Single source of truth for zone + mask visual styling across the
// shape editor and every viewing context (lightbox, live view,
// coral test, timelapse playback). Anywhere a literal blue / red
// rgba() shows up in zone or mask context, the linter should
// warn — point the callsite here.
//
// Green = Erkennungs-Zone (inclusion), red = Ausschluss-Maske
// (exclusion). The same colours appear in 00-zone-tokens.css as
// CSS custom properties so component CSS can reference them too.

export const ZONE_STROKE = 'rgba(34,197,94,1)';     // green-500-ish
export const ZONE_FILL   = 'rgba(34,197,94,0.18)';
export const MASK_STROKE = 'rgba(239,68,68,1)';     // red-500-ish
export const MASK_FILL   = 'rgba(239,68,68,0.18)';

export const PREVIEW_DASH        = [7, 6];
export const LINE_W              = 3;
export const LINE_W_EMPH         = 5;
export const VERTEX_R            = 10;
export const VERTEX_R_HOV        = 13;
export const CLOSE_RING_BASE     = 16;
export const CLOSE_RING_AMP      = 8;
export const CLOSE_RING_PERIOD_MS = 1200;
