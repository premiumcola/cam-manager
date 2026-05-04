// ─── camedit/coral-test/pipeline-tree.js ───────────────────────────────────
// R12 — extracted from coral-test.js. Renders the per-frame detection
// flow diagram on the Coral-Test panel header. Opacity reflects the
// current global toggle state (Coral / bird species / wildlife).
// Re-rendered on every settings hydrate + every toggle change.
import { byId, esc } from "../../core/dom.js";

export function _renderCoralPipelineTree(){
  const host = byId('coralPipelineTree'); if(!host) return;
  const coralOn    = !!byId('coralTpuEnabled')?.checked;
  const birdOn     = !!byId('birdSpeciesEnabled')?.checked;
  const wildlifeOn = !!byId('wildlifeEnabled')?.checked;
  const offTag = '<span class="cpt-tag-off">inaktiv</span>';
  const node = (cls, title, sub, list, prefix, off) => `
    <div class="cpt-row${off?' cpt-node--off':''}">
      <span class="cpt-prefix">${prefix}</span>
      <div class="cpt-node">
        <div class="cpt-node-head"><span class="cpt-node-icon ${cls}">${title.icon}</span><span class="cpt-node-title">${esc(title.text)}</span>${off?offTag:''}</div>
        ${sub?`<div class="cpt-node-sub">${esc(sub)}</div>`:''}
        ${list?`<div class="cpt-node-list">${esc(list)}</div>`:''}
      </div>
    </div>`;
  host.innerHTML = `
    <div class="cpt-title">KI-Pipeline · pro Frame</div>
    ${node('cpt-accent--end', {icon:'🎬', text:'Kameraframe (alle N ms)'}, 'Frame-Eingang aus dem Sub-Stream', '', '', false)}
    ${node('cpt-accent--motion', {icon:'🔲', text:'Bewegungserkennung (Pixel-Differenz)'}, 'Masken & Zonen werden hier angewandt', '', '│', false)}
    ${node('cpt-accent--coco', {icon:'🟡', text:'Normal-Threshold → COCO-Objekterkennung'}, '', 'Person · Katze · Vogel · Auto · Hund', '│   ├─►', !coralOn)}
    ${node('cpt-accent--bird', {icon:'🐦', text:'Wenn Vogel → Vogelarten-Klassifikation'}, 'iNaturalist ~960 Arten', 'Amsel · Blaumeise · Buchfink · Haussperling · …', '│   │     └─►', !(coralOn && birdOn))}
    ${node('cpt-accent--wildlife', {icon:'🦔', text:'Wildlife-Threshold → Wildlife-Klassifikation'}, 'ImageNet MobileNet, niedrigere Schwelle für kleine Tiere', 'Eichhörnchen · Fuchs · Igel', '│   └─►', !wildlifeOn)}
    ${node('cpt-accent--end', {icon:'⊘', text:'Kein Treffer → kein Event, keine Aufnahme'}, '', '', '└─►', false)}
  `;
}
