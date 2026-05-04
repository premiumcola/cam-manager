// ─── camedit/coral-test/models-strip.js ────────────────────────────────────
// R12 — extracted from coral-test.js. Status strip above the result grid:
// each configured model gets a small dot + nickname + "aktiv"/"deaktiviert"
// tag. Renders nothing on responses without models_active so older
// endpoints stay invisible.
import { byId, esc } from "../../core/dom.js";

export function _renderCoralModelsStrip(r){
  const strip = byId('coralTestModelsStrip');
  if (!strip) return;
  const ma = r && r.models_active;
  if (!ma){ strip.innerHTML = ''; strip.hidden = true; return; }
  const order = ['coco', 'bird_species', 'wildlife'];
  const items = order.map(k => {
    const m = ma[k] || {};
    const ok = !!m.available;
    return `<span class="ct-mstrip-item ${ok ? 'is-on' : 'is-off'}" title="${esc(m.reason || '')}">
      <span class="ct-mstrip-dot"></span>
      <span class="ct-mstrip-name">${esc(m.nickname || k)}</span>
      <span class="ct-mstrip-state">${ok ? 'aktiv' : 'deaktiviert'}</span>
    </span>`;
  }).join('');
  strip.innerHTML = items;
  strip.hidden = false;
}
