// ─── mediathek/bbox-overlay/cleanup.js ─────────────────────────────────────
// Public teardown — called from closeLightbox via the window bridge so
// legacy.js doesn't have to know about RAF state.
import { byId } from '../../core/dom.js';
import { _stopRafLoop } from './raf.js';

// Stop the loop and hide the banner + timeline. Timeline panel is
// hidden by the lightbox.js teardown via the [hidden] attribute on
// #lightboxTrackTimeline; its content stays until the next render so
// re-opening the same item doesn't flash an empty panel.
export function lbStopTrackingPlayback(){
  _stopRafLoop();
  const banner = byId('lbTrackingBanner');
  if (banner){
    banner.style.opacity = '0';
    banner.style.display = 'none';
  }
}
window.lbStopTrackingPlayback = lbStopTrackingPlayback;
