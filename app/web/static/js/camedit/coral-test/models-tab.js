// ─── camedit/coral-test/models-tab.js ──────────────────────────────────────
// R12 — extracted from coral-test.js. The Modelle sub-tab inside the
// Coral panel: fetches /api/coral/models, groups CPU + EdgeTPU variants
// of the same stem onto a single pair-row, and wires click-to-switch
// against /api/coral/models/select. Distinct concern from the test-batch
// runner — that lives in coral-test.js (the orchestrator) + results.js.
import { byId, esc } from "../../core/dom.js";
import { state } from "../../core/state.js";
import { j } from "../../core/api.js";
import { showToast } from "../../core/toast.js";
import { _updateCoralDeviceInfo } from "./device-info.js";

// Category metadata — headings + per-category note shown for each group
// of models. The note sits between the category description and the
// model rows; used today only for the detection category to flag that
// COCO + EfficientDet are interchangeable.
const _MODEL_CATEGORIES=[
  {id:'detection',    title:'Objekt-Erkennung (COCO)',
    desc:'Findet Objekte im Bild und markiert sie mit Rahmen. Erste Stufe für alles: Mensch, Auto, Vogel, Tier.',
    note:'Eines der beiden Modelle ist aktiv. Das andere ist als Alternative zum schnellen Wechsel verfügbar — kann gefahrlos gelöscht werden, wenn nicht gebraucht.'},
  {id:'bird_species', title:'Vogelarten-Klassifikation (iNaturalist)',
    desc:'Bestimmt die Vogelart, sobald die erste Stufe einen Vogel gefunden hat. Läuft auf dem Bildausschnitt des Vogels.'},
  {id:'wildlife',     title:'Wildtier-Erkennung (ImageNet)',
    desc:"Bestimmt die Tierart bei Säugern, die die erste Stufe nur generisch als 'Tier' erkennt — Eichhörnchen, Fuchs, Igel, Reh."},
  {id:'other',        title:'Sonstige Modelle',
    desc:'Eigene .tflite-Modelle, die keiner der obigen Kategorien zuzuordnen sind.'},
];

// Strip the EdgeTPU / CPU suffix so CPU + TPU variants of the same model
// collapse onto a single "pair" row.
function _stemFromFilename(fn){
  return String(fn||'').toLowerCase()
    .replace(/_edgetpu\.tflite$/,'')
    .replace(/\.tflite$/,'')
    .replace(/_quant$/,'')
    .replace(/_quant_postprocess$/,'')
    .replace(/_postprocess$/,'');
}

export async function _loadCoralModels(){
  const list=byId('coralModelsList'); if(!list) return;
  list.innerHTML='<div class="field-help" style="color:var(--muted)">Lade Modelle…</div>';
  try{
    const r=await j('/api/coral/models');
    const models=r.models||[];
    if(!models.length){
      list.innerHTML=`<div class="field-help">Keine Modelle in <code>${esc(r.models_dir||'/app/models')}</code> gefunden.</div>`;
      return;
    }
    // 1) Group by category, then by stem (to pair CPU + TPU variants).
    const byCat={};
    for(const m of models){
      const cat=m.model_category||'other';
      (byCat[cat]=byCat[cat]||{}) ;
      const stem=_stemFromFilename(m.filename);
      (byCat[cat][stem]=byCat[cat][stem]||[]).push(m);
    }
    // 2) Render each category that has at least one model.
    let html='';
    for(const cat of _MODEL_CATEGORIES){
      const stems=byCat[cat.id];
      if(!stems||!Object.keys(stems).length) continue;
      const catNote = cat.note
        ? `<div class="mcat-note">${esc(cat.note)}</div>`
        : '';
      html+=`<div class="mcat"><div class="mcat-head">${esc(cat.title)}</div><div class="mcat-desc">${esc(cat.desc)}</div>${catNote}`;
      // Stable stem order, alphabetical.
      const stemKeys=Object.keys(stems).sort();
      // Coral TPU availability picks which variant is actively in use:
      // EdgeTPU when present, otherwise CPU. Read from the first camera's
      // status (already loaded by hydrateSettings).
      const coralAvail = !!state.cameras?.[0]?.coral_available;
      for(const stem of stemKeys){
        const variants=stems[stem];
        const cpu=variants.find(v=>!v.edgetpu);
        const tpu=variants.find(v=>v.edgetpu);
        // The pair is "in use" if either variant matches the configured
        // model_path of an enabled category. Within an in-use pair, the
        // hardware-appropriate variant carries the green "wird verwendet"
        // chip; the other side stays at neutral "verfügbar".
        const pairInUse = variants.some(v=>v.active_in_category);
        const usedVariant = pairInUse ? (coralAvail ? (tpu||cpu) : (cpu||tpu)) : null;
        const labelInfo=(variants[0]||{}).labels||{};
        // "Erkennt N Klassen · Liste: <file>" instead of the cryptic
        // "Labels: <file> (N Einträge)" — N is the number of classes
        // the model can identify, not a generic file count.
        const labelPill=labelInfo.filename
          ? (labelInfo.exists
              ? `<span class="mpair-labels" title="${esc(labelInfo.path||'')}">${labelInfo.count?`Erkennt ${labelInfo.count} Klassen · `:''}Liste: ${esc(labelInfo.filename)}</span>`
              : `<span class="mpair-labels mpair-labels--missing">⚠ Klassen-Liste fehlt: ${esc(labelInfo.filename)}</span>`)
          : '';
        const mkVariantHtml=(v,label)=>{
          if(!v) return `<div class="mvar mvar--missing"><span class="mvar-kind">${esc(label)}</span><span class="mvar-empty">nicht vorhanden</span></div>`;
          // "wird verwendet" only on the variant the runtime actually
          // loads given the current Coral-availability. Everything else
          // shipped under /app/models/ is just "verfügbar".
          const inUse = (v === usedVariant);
          const stateChip = inUse
            ? '<span class="mvar-chip mvar-chip--use">wird verwendet</span>'
            : '<span class="mvar-chip mvar-chip--ok">verfügbar</span>';
          return `<div class="mvar${inUse?' mvar--in-use':''}" data-path="${esc(v.path)}">
            <span class="mvar-kind mvar-kind--${label.toLowerCase()}">${esc(label)}</span>
            <span class="mvar-size">${v.size_mb!=null?v.size_mb+' MB':''}</span>
            ${stateChip}
          </div>`;
        };
        // Title row: friendly stem + official filenames in a muted
        // sub-line (CPU first, EDGETPU second; "—" placeholder when one
        // variant is missing). Keeps the stem readable while preserving
        // the actual on-disk filenames so users can locate the file.
        const anyVar=cpu||tpu;
        const fileNames=`${cpu?esc(cpu.filename):'—'} · ${tpu?esc(tpu.filename):'—'}`;
        html+=`<div class="mpair">
          <div class="mpair-head">
            <span class="mpair-name-block">
              <span class="mpair-name" title="${esc(anyVar.filename)}">${esc(stem)}</span>
              <span class="mpair-files">${fileNames}</span>
            </span>
            ${labelPill}
          </div>
          <div class="mpair-desc">${esc(anyVar.description||'')}</div>
          <div class="mpair-row">
            ${mkVariantHtml(cpu,'CPU')}
            ${mkVariantHtml(tpu,'EDGETPU')}
          </div>
          <div class="mpair-note">EdgeTPU wird bevorzugt. CPU wird automatisch als Fallback verwendet.</div>
        </div>`;
      }
      html+='</div>';
    }
    list.innerHTML=html;
    // Wire click-to-switch (only on rendered variant cards)
    list.querySelectorAll('.mvar[data-path]').forEach(card=>{
      card.addEventListener('click',async()=>{
        const p=card.dataset.path;
        if(!p||card.classList.contains('mvar--active')) return;
        card.style.opacity='0.6';
        try{
          const r=await j('/api/coral/models/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:p})});
          if(r.ok){
            // Toast wording matches the runtime that will actually
            // reload — Coral users get the TPU restart message; CPU-
            // only systems see "CPU-Detector wird neu gestartet" so
            // they don't expect a Coral lifecycle event that won't
            // fire.
            const coralAvail=!!state.cameras?.[0]?.coral_available;
            const restartMsg=coralAvail?'Coral wird neu gestartet':'CPU-Detector wird neu gestartet';
            showToast('Modell aktiviert · '+restartMsg,'success');
            await _loadCoralModels();
            await _updateCoralDeviceInfo();
          }else{
            showToast('Modellwechsel fehlgeschlagen: '+(r.error||'?'),'error');
          }
        }catch(e){
          showToast('Modellwechsel fehlgeschlagen: '+e.message,'error');
        }finally{
          card.style.opacity='';
        }
      });
    });
  }catch(e){
    list.innerHTML=`<div style="color:#fca5a5">Fehler beim Laden: ${esc(String(e))}</div>`;
  }
}
