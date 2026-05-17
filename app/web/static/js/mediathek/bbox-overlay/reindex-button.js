// ─── mediathek/bbox-overlay/reindex-button.js ─────────────────────────────
// "Tracking neu indexieren" button mounted into the overlay-toggles
// pill row (right next to the Masken pill). Always visible during
// recorded-clip playback so an operator can re-run the post-clip
// tracker against the current model/settings without paging into a
// tab. Replaces the retired "Nach-Erkennung" tab — same flow, more
// discoverable, fewer clicks.
//
// Reuses ``reindex.js#triggerManualReindex`` so the actual fetch +
// poll-for-sidecar logic stays one implementation (the banner retry
// button uses the same entry point).

import { byId } from '../../core/dom.js';
import { triggerManualReindex } from './reindex.js';

const _BTN_ID = 'lbReindexBtn';

/**
 * Mount the regenerate button as a child of the overlay-toggles row.
 * Idempotent — calling again replaces the previous DOM.
 *
 * @param {HTMLElement|string} host  Container element or its id.
 */
export function mountReindexButton(host){
  const row = (typeof host === 'string') ? byId(host) : host;
  if (!row) return null;
  const prev = byId(_BTN_ID);
  if (prev) prev.remove();
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = _BTN_ID;
  btn.className = 'lb-reindex-btn';
  btn.title = 'Tracking neu indexieren';
  btn.setAttribute('aria-label', 'Tracking neu indexieren');
  btn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M2.5 8A5.5 5.5 0 0 1 13 5M13.5 8A5.5 5.5 0 0 1 3 11"/>
      <polyline points="12,2 12,5.5 8.5,5.5"/>
      <polyline points="4,14 4,10.5 7.5,10.5"/>
    </svg>
    <span class="lb-reindex-label">Neu indexieren</span>`;
  // Insert BEFORE the legend so the order stays
  // [Bboxes][Trails][Zonen][Masken][Reindex][Legend].
  const legend = row.querySelector('.lb-legend');
  if (legend) row.insertBefore(btn, legend);
  else row.appendChild(btn);
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    triggerManualReindex(btn);
  });
  return {
    teardown: () => { btn.remove(); },
  };
}
