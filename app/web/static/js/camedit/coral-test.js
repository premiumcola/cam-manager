// ─── camedit/coral-test.js ─────────────────────────────────────────────────
// Stage 25 of the legacy.js → ES modules refactor — Coral TPU test panel
// orchestrator.
//
// R12 split: focused concerns moved into `coral-test/` sub-package:
//   * coral-test/results.js        — result-card rendering + grouping
//   * coral-test/bbox.js           — canvas bbox drawer + colour palette
//   * coral-test/models-strip.js   — models_active status pills
//   * coral-test/models-tab.js     — model-list + selection
//   * coral-test/pipeline-tree.js  — _renderCoralPipelineTree
//   * coral-test/device-info.js    — _updateCoralDeviceInfo
//
// What stays here:
//   * tab-switch / settings-toggle inline-onclick handlers
//   * the run-button handler (_runCoralTest)
//   * camera dropdown population (_populateCoralTestCameras)
//   * click bindings + window-bridges that consumers still rely on
//
// _toggleCoralSetting / reloadCoralRuntime / toggleCoralTab are
// invoked from inline onclicks in the Coral test page, so they keep
// their window.* assignments. _renderCoralPipelineTree stays on window
// because hydrateSettings (still in legacy.js) calls it.
import { byId, esc } from "../core/dom.js";
import { state } from "../core/state.js";
import { j } from "../core/api.js";
import { showToast } from "../core/toast.js";
import { loadAll } from "../live-update.js";
import { _coralLabelColor } from "./coral-test/bbox.js";
import {
  _renderCoralBatchResult,
  _renderCoralModelsRun,
} from "./coral-test/results.js";
import { _renderCoralModelsStrip } from "./coral-test/models-strip.js";
import { _loadCoralModels } from "./coral-test/models-tab.js";
import { _renderCoralPipelineTree } from "./coral-test/pipeline-tree.js";
import { _updateCoralDeviceInfo } from "./coral-test/device-info.js";

// Re-export the names index.js (and any future direct importer) consumes
// so the refactor doesn't ripple into camedit/index.js. The window-
// bridges below keep the still-thunked consumers working until R13.
export {
  _renderCoralPipelineTree,
  _updateCoralDeviceInfo,
};

window._toggleCoralSetting=async function(key,inputEl){
  const nowOn=!!inputEl.checked;
  const coralEnabled=key==='coral_enabled'   ?nowOn:!!(byId('coralTpuEnabled')?.checked);
  const birdEnabled =key==='bird_species_enabled'?nowOn:!!(byId('birdSpeciesEnabled')?.checked);
  const wildlifeOn  =key==='wildlife_enabled'?nowOn:!!(byId('wildlifeEnabled')?.checked);
  await fetch('/api/settings/app',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({processing:{coral_enabled:coralEnabled,bird_species_enabled:birdEnabled,wildlife_enabled:wildlifeOn}})});
  showToast('Coral gespeichert · Kameras werden neu gestartet.','success');
  // Reflect the new toggle state in the pipeline tree before loadAll()
  // rebuilds everything from scratch. The wildlife-only form fields
  // were retired in the Erkennung-tab refactor, so no per-form toggle
  // is needed here anymore.
  _renderCoralPipelineTree?.();
  await loadAll();
};
window.reloadCoralRuntime=async function(){
  const coralEnabled=!!(byId('coralTpuEnabled')?.checked);
  const birdEnabled =!!(byId('birdSpeciesEnabled')?.checked);
  const wildlifeOn  =!!(byId('wildlifeEnabled')?.checked);
  await fetch('/api/settings/app',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({processing:{coral_enabled:coralEnabled,bird_species_enabled:birdEnabled,wildlife_enabled:wildlifeOn}})});
  showToast('Coral-Runtime neu gestartet.','success');
  await loadAll();
};
// Coral section sub-tab switcher (Einstellungen / Test / Modelle)
window.toggleCoralTab=function(tabId){
  document.querySelectorAll('.coral-tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===tabId));
  document.querySelectorAll('.coral-tab-content').forEach(p=>p.hidden = p.id!==`coral-pane-${tabId}`);
  // Lazy-load the models list the first time the Modelle tab is shown
  if(tabId==='models' && !window._coralModelsLoadedOnce){
    window._coralModelsLoadedOnce=true;
    _loadCoralModels?.();
  }
};

export async function _populateCoralTestCameras(){
  const sel=byId('coralTestCamSel'); if(!sel) return;
  const cams=state.cameras||[];
  const current=sel.value;
  // Fetch test-image folders (best-effort; degrade silently if endpoint missing/empty)
  let folders=[];
  try{const r=await j('/api/coral/test-images'); folders=r.folders||[];}catch{}
  let html='<option value="">Testbild (ohne Kamera)</option>';
  if(cams.length){
    html+='<optgroup label="— Kameras —">'+
      cams.map(c=>`<option value="${esc(c.id)}">${esc(c.name||c.id)}</option>`).join('')+
      '</optgroup>';
  }
  if(folders.length){
    html+='<optgroup label="— Testbilder —">'+
      folders.map(f=>`<option value="test:${esc(f.name)}">${esc(f.icon||'📁')} ${esc(f.label||f.name)} (${f.count} Bilder)</option>`).join('')+
      '</optgroup>';
  }
  sel.innerHTML=html;
  if(current&&[...sel.options].some(o=>o.value===current)) sel.value=current;
}

async function _runCoralTest(){
  const btn=byId('coralTestBtn'); const out=byId('coralTestResult');
  if(!btn||!out) return;
  const sel=byId('coralTestCamSel')?.value||'';
  btn.disabled=true; const orig=btn.textContent; btn.textContent='Teste…';
  // Batch mode: "test:<folder>" runs every image in storage/test_images/<folder>/
  if(sel.startsWith('test:')){
    const folder=sel.slice(5);
    const mode=byId('coralTestModeSel')?.value||'cascade';
    out.innerHTML=`<div class="field-help" style="color:var(--muted)">Lade Testbilder aus <code>${esc(folder)}/</code> …</div>`;
    // Reset the per-batch status strip — it gets re-populated from
    // models_active in the response. Hidden until we have data.
    const strip=byId('coralTestModelsStrip');
    if(strip){strip.innerHTML='';strip.hidden=true;}
    try{
      const r=await j('/api/coral/test-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder,mode})});
      _renderCoralModelsStrip(r);
      _renderCoralBatchResult(out,r,folder);
    }catch(e){
      out.innerHTML=`<div style="color:#fca5a5">Batch-Test fehlgeschlagen: ${esc(String(e))}</div>`;
    }finally{
      btn.disabled=false; btn.textContent=orig;
    }
    return;
  }
  const camId=sel;
  out.innerHTML='<div class="field-help" style="color:var(--muted)">Führe Inferenz aus…</div>';
  try{
    const r=await j('/api/coral/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({camera_id:camId||undefined})});
    const mode=r.detector_mode||'motion_only';
    const modeColor=mode==='coral'?'#4ade80':mode==='cpu'?'#facc15':'rgba(255,255,255,0.6)';
    const modeLabel=mode==='coral'?'⚡ Coral TPU':mode==='cpu'?'💻 CPU-Fallback':'⏸ Bewegung';
    const srcLabel=r.source==='camera'?(r.camera_name||r.camera_id||'?'):'Testmuster';
    const dets=r.detections||[];
    const pillsHtml=dets.length
      ? dets.map(d=>{
          const c=_coralLabelColor(d.label);
          const spPct=d.species_score!=null?` ${(d.species_score*100).toFixed(0)}%`:'';
          const spLat=d.species_latin && d.species && d.species!==d.species_latin?` <span class="ct-species-lat">(${esc(d.species_latin)})</span>`:'';
          const speciesLine=d.species?`<span class="ct-species" style="color:${c}">→ ${esc(d.species)}${spLat}${spPct}</span>`:'';
          return `<span class="ct-pill${d.species?' ct-pill--2line':''}" style="border-left-color:${c}"><span class="ct-pill-main">${esc(d.label)}<span class="ct-pct">${(d.score*100).toFixed(0)}%</span></span>${speciesLine}</span>`;
        }).join('')
      : '';
    const overlayBottom=dets.length
      ? `<div class="coral-test-overlay-bottom">${pillsHtml}</div>`
      : `<div class="coral-test-empty">Keine Objekte erkannt</div>`;
    const imgBlock=r.image_b64
      ? `<div class="coral-test-imgwrap">
           <img src="${r.image_b64}" alt="Coral test result"/>
           <div class="coral-test-overlay-top">
             <span class="ct-mode" style="color:${modeColor}">● ${esc(modeLabel)}</span>
             ${r.inference_ms>0?`<span class="ct-ms">${r.inference_ms} ms</span>`:''}
             <span class="ct-src">${esc(srcLabel)}</span>
           </div>
           ${overlayBottom}
         </div>`
      : `<div style="background:var(--surface);padding:10px;border-radius:10px;font-size:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
           <span style="font-weight:700;color:${modeColor}">● ${esc(modeLabel)}</span>
           ${r.inference_ms>0?`<span style="color:var(--muted)">${r.inference_ms} ms</span>`:''}
           <span style="color:var(--muted);margin-left:auto">${esc(srcLabel)}</span>
         </div>`;
    const reasonRow=(r.detector_reason&&r.detector_reason!=='ok')?`<div class="field-help" style="margin-top:6px;font-family:monospace">${esc(r.detector_reason)}</div>`:'';
    const usbRow=r.usb_info?`<div class="field-help" style="margin-top:4px;color:#a78bfa">🔌 ${esc(r.usb_info)}</div>`:'';
    const errRow=r.inference_error?`<div style="color:#fca5a5;margin-top:6px;font-size:12px">Inferenz-Fehler: ${esc(r.inference_error)}</div>`:'';
    // Per-model breakdown stack — one card per stage (detection, bird,
    // wildlife). Backend emits models_run with results[]; renderer
    // shows the model's filename, mode chip, latency, and either the
    // per-result rows or a "Modell nicht aktiviert: <reason>" line.
    const modelsRunHtml=_renderCoralModelsRun(r.models_run);
    out.innerHTML=imgBlock+reasonRow+usbRow+errRow+modelsRunHtml;
  }catch(e){
    out.innerHTML=`<div style="color:#fca5a5">Test fehlgeschlagen: ${esc(String(e))}</div>`;
  }finally{
    btn.disabled=false; btn.textContent=orig;
  }
}

byId('coralTestBtn')?.addEventListener('click',_runCoralTest);
byId('coralModelsReload')?.addEventListener('click',_loadCoralModels);

// ── window.* bridges ────────────────────────────────────────────────────────
// hydrateSettings() in camedit/index.js calls these via the
// window._populateCoralTestCameras?.() / _updateCoralDeviceInfo?.()
// indirection it set up before this module had named exports. Without
// these bridges the Coral-Test camera <select> stays empty (no live
// cams + no test-image folders) and the device-info widget never
// hydrates. Same migration path as the rest: bridge here, drop the
// indirection in camedit/index.js once both modules import directly.
window._populateCoralTestCameras = _populateCoralTestCameras;
window._updateCoralDeviceInfo    = _updateCoralDeviceInfo;
window._renderCoralPipelineTree  = _renderCoralPipelineTree;
