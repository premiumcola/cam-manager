// ─── camedit/coral-test.js ─────────────────────────────────────────────────
// Stage 25 of the legacy.js → ES modules refactor — Coral TPU test
// panel: model browser, per-image inference test, batch grid renderer,
// pipeline tree, device-info widget, settings toggles. Pure code move
// from legacy.js, no behaviour changes.
//
// _toggleCoralSetting / reloadCoralRuntime / toggleCoralTab are
// invoked from inline onclicks in the Coral test page, so they keep
// their window.* assignments below. _renderCoralPipelineTree stays
// on window because hydrateSettings (still in legacy.js) calls it.
import { byId, esc } from "../core/dom.js";
import { state } from "../core/state.js";
import { j } from "../core/api.js";
import { showToast } from "../core/toast.js";

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
// Pipeline tree visualisation. Renders the per-frame detection flow inside
// the Objekterkennung settings card; opacity reflects the current global
// toggle state (Coral / bird species / wildlife). Re-rendered on every
// settings hydrate + every toggle change.
function _renderCoralPipelineTree(){
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
window._renderCoralPipelineTree = _renderCoralPipelineTree;

async function _updateCoralDeviceInfo(){
  const panel=byId('coralDeviceInfo'); if(!panel) return;
  try{
    const s=await j('/api/system');
    if(s.coral_device){
      panel.innerHTML=`<div class="field-help" style="margin-top:2px;color:#a78bfa">🔌 ${esc(s.coral_device)}</div>`;
    }else{
      panel.innerHTML='';
    }
  }catch(e){panel.innerHTML='';}
}
async function _populateCoralTestCameras(){
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
const _CORAL_LABEL_COLORS={person:'#6e6eff',cat:'#a06eff',bird:'#54d662',dog:'#00b0ff',car:'#f87171',fox:'#ff7a1a',squirrel:'#7c4a1f',hedgehog:'#a67c52'};
function _coralLabelColor(lbl){return _CORAL_LABEL_COLORS[String(lbl||'').toLowerCase()]||'#ffb400';}
// Render the per-model card stack below the annotated preview. Three
// stages are emitted by the backend (detection, bird_species, wildlife);
// each card shows category title + model filename + mode chip + latency,
// then either a results table or a muted "Modell nicht aktiviert:
// <reason>" line. Empty results array AND available=true → "Keine
// Ergebnisse" so the user can tell "the model ran but found nothing"
// apart from "the model didn't run".
const _CORAL_TEST_CAT_TITLES = {
  detection:    'Objekt-Erkennung',
  bird_species: 'Vogelarten',
  wildlife:     'Wildtiere',
};
function _renderCoralModelsRun(modelsRun){
  if (!Array.isArray(modelsRun) || !modelsRun.length) return '';
  const cards = modelsRun.map(m => {
    const title = _CORAL_TEST_CAT_TITLES[m.category] || m.category;
    const modeChip = m.mode === 'coral'
      ? '<span class="ct-mr-chip ct-mr-chip--coral">⚡ Coral</span>'
      : m.mode === 'cpu'
        ? '<span class="ct-mr-chip ct-mr-chip--cpu">💻 CPU</span>'
        : '<span class="ct-mr-chip ct-mr-chip--off">aus</span>';
    const ms = (m.inference_ms != null && m.inference_ms > 0)
      ? `<span class="ct-mr-ms">${m.inference_ms} ms</span>`
      : '';
    const file = m.model
      ? `<code class="ct-mr-file" title="${esc(m.model)}">${esc(m.model)}</code>`
      : '<span class="ct-mr-file ct-mr-file--missing">— kein Modell —</span>';
    let body;
    if (!m.available){
      body = `<div class="ct-mr-empty">Modell nicht aktiviert: ${esc(m.reason || 'unbekannt')}</div>`;
    } else if (m.error){
      body = `<div class="ct-mr-empty ct-mr-empty--err">Fehler: ${esc(m.error)}</div>`;
    } else if (!Array.isArray(m.results) || !m.results.length){
      body = '<div class="ct-mr-empty">Keine Ergebnisse</div>';
    } else if (m.category === 'detection'){
      body = '<div class="ct-mr-rows">' + m.results.map(d => {
        const c = _coralLabelColor(d.label);
        return `<div class="ct-mr-row" style="border-left-color:${c}">
          <span class="ct-mr-label">${esc(d.label)}</span>
          <span class="ct-mr-pct">${(d.score * 100).toFixed(0)}%</span>
        </div>`;
      }).join('') + '</div>';
    } else if (m.category === 'bird_species'){
      body = '<div class="ct-mr-rows">' + m.results.map(b => {
        const lat = b.latin && b.latin !== b.species ? ` <span class="ct-species-lat">(${esc(b.latin)})</span>` : '';
        const pct = b.score != null ? `${(b.score * 100).toFixed(0)}%` : '—';
        return `<div class="ct-mr-row">
          <span class="ct-mr-label">${esc(b.species || '?')}${lat}</span>
          <span class="ct-mr-pct">${pct}</span>
        </div>`;
      }).join('') + '</div>';
    } else if (m.category === 'wildlife'){
      body = '<div class="ct-mr-rows">' + m.results.map(w => {
        const pct = w.score != null ? `${(w.score * 100).toFixed(0)}%` : '—';
        const mapped = w.mapped
          ? `<span class="ct-mr-mapped">→ ${esc(w.mapped)}</span>`
          : '<span class="ct-mr-mapped ct-mr-mapped--none">→ keine Zuordnung</span>';
        return `<div class="ct-mr-row">
          <span class="ct-mr-label">
            <span class="ct-mr-from">${esc(w.from_label || '?')}</span>
            ${esc(w.imagenet || '?')}
            ${mapped}
          </span>
          <span class="ct-mr-pct">${pct}</span>
        </div>`;
      }).join('') + '</div>';
    } else {
      body = '<div class="ct-mr-empty">—</div>';
    }
    return `<div class="ct-mr-card">
      <div class="ct-mr-head">
        <span class="ct-mr-title">${esc(title)}</span>
        ${modeChip}
        ${ms}
      </div>
      ${file}
      ${body}
    </div>`;
  }).join('');
  return `<div class="ct-mr-stack">${cards}</div>`;
}

async function _runCoralTest(){
  const btn=byId('coralTestBtn'); const out=byId('coralTestResult');
  if(!btn||!out) return;
  const sel=byId('coralTestCamSel')?.value||'';
  btn.disabled=true; const orig=btn.textContent; btn.textContent='Teste…';
  // Batch mode: "test:<folder>" runs every image in storage/test_images/<folder>/
  if(sel.startsWith('test:')){
    const folder=sel.slice(5);
    out.innerHTML=`<div class="field-help" style="color:var(--muted)">Lade Testbilder aus <code>${esc(folder)}/</code> …</div>`;
    try{
      const r=await j('/api/coral/test-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder})});
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
function _renderCoralBatchResult(out,r,folder){
  if(r && r.ok===false){
    out.innerHTML=`<div style="color:#fca5a5;padding:8px">Detector nicht verfügbar: ${esc(r.error||'?')}<div class="field-help" style="margin-top:4px">${esc(r.detector_reason||'')}</div></div>`;
    return;
  }
  const results=r.results||[];
  const summary=r.summary||{};
  const total=summary.total_images||0;
  const hits=summary.with_detections||0;
  const rate=total>0?(hits/total):0;
  const avg=summary.avg_ms||0;
  const mode=r.detector_mode||'?';
  const modeLabel=mode==='coral'?'⚡ Coral TPU':mode==='cpu'?'💻 CPU-Fallback':'⏸ Bewegung';
  let summaryClass='cb-sum--ok',summaryIcon='✅',interp='';
  if(rate>=0.75){summaryClass='cb-sum--ok';summaryIcon='✅';interp=`${modeLabel} erkennt diese Kategorie zuverlässig.`;}
  else if(rate>=0.5){summaryClass='cb-sum--warn';summaryIcon='⚠️';interp='Mittlere Erkennungsrate — ggf. Modell oder min_score prüfen.';}
  else{summaryClass='cb-sum--bad';summaryIcon='❌';interp='Niedrige Erkennungsrate — min_score zu hoch oder falsches Modell?';}
  const cards=results.map(item=>{
    if(item.error){
      return `<div class="cb-card"><div class="cb-card-err">${esc(item.filename)}: ${esc(item.error)}</div></div>`;
    }
    const dets=item.detections||[];
    const pills=dets.length
      ? dets.map(d=>{
          const c=_coralLabelColor(d.label);
          const spPct=d.species_score!=null?` ${(d.species_score*100).toFixed(0)}%`:'';
          const spLat=d.species_latin && d.species && d.species!==d.species_latin?` <span class="ct-species-lat">(${esc(d.species_latin)})</span>`:'';
          const speciesLine=d.species?`<span class="ct-species" style="color:${c}">→ ${esc(d.species)}${spLat}${spPct}</span>`:'';
          return `<span class="ct-pill${d.species?' ct-pill--2line':''}" style="border-left-color:${c}"><span class="ct-pill-main">${esc(d.label)}<span class="ct-pct">${(d.score*100).toFixed(0)}%</span></span>${speciesLine}</span>`;
        }).join('')
      : '<span class="cb-empty">Keine Objekte erkannt</span>';
    // Wildlife (ImageNet) pill — only set for fox / squirrel / hedgehog
    // folders; shows the top ImageNet match and whether it maps to our
    // animal categories.
    let wildlifePill='';
    if(item.wildlife){
      const wl=item.wildlife;
      const wlc=wl.label?_coralLabelColor(wl.label):'#64748b';
      const wlPct=wl.score!=null?` ${(wl.score*100).toFixed(0)}%`:'';
      const mainTxt=wl.label?`${esc(wl.label)} ✓`:'kein Treffer';
      const subTxt=wl.imagenet?` <span class="ct-species-lat">ImageNet: ${esc(_truncMid(wl.imagenet,42))}</span>`:'';
      wildlifePill=`<span class="ct-pill ct-pill--2line" style="border-left-color:${wlc}"><span class="ct-pill-main">🦊 ${mainTxt}<span class="ct-pct">${wlPct}</span></span><span class="ct-species" style="color:${wlc}">${subTxt}</span></span>`;
    }
    // Image area: empty <canvas> placeholder. Bboxes are drawn client-
    // side after the b64 image loads — see the post-render pass below.
    // data-cb-idx links each canvas back to its result index in `results`
    // so we can pull bbox coordinates without re-serialising via attrs.
    const imgArea = item.image_b64
      ? `<canvas class="cb-canvas" data-cb-idx="${results.indexOf(item)}"></canvas>`
      : '<div class="cb-noimg">Kein Bild</div>';
    return `<div class="cb-card">
      <div class="cb-imgwrap">${imgArea}<span class="cb-ms">${item.inference_ms||0} ms</span></div>
      <div class="cb-fname" title="${esc(item.filename)}">${esc(_truncMid(item.filename,40))}</div>
      <div class="cb-pills">${pills}${wildlifePill}</div>
    </div>`;
  }).join('');
  // For wildlife folders, the headline stat is the wildlife hit-rate; for
  // everything else keep the COCO detection count.
  const isWildlifeFolder=['fox','hedgehog','squirrel'].includes(folder);
  const wlHits=summary.with_wildlife||0;
  const primaryLine=isWildlifeFolder
    ? `${summaryIcon} <strong>${wlHits} von ${total} Bildern</strong>: als ${esc(folder)} klassifiziert · Ø ${avg} ms`
    : `${summaryIcon} <strong>${hits} von ${total} Bildern</strong>: Objekte erkannt · Ø ${avg} ms`;
  if(isWildlifeFolder){
    const wlRate=total>0?(wlHits/total):0;
    summaryClass=wlRate>=0.75?'cb-sum--ok':wlRate>=0.5?'cb-sum--warn':'cb-sum--bad';
    summaryIcon=wlRate>=0.75?'✅':wlRate>=0.5?'⚠️':'❌';
    interp=wlRate>=0.75?'Wildlife-Klassifikator erkennt diese Art zuverlässig.':wlRate>=0.5?'Mittlere Klassifikationsrate — ggf. min_score prüfen.':'Niedrige Rate — Wildlife-Modell liefert oft andere Klasse.';
  }
  out.innerHTML=`
    <div class="cb-summary ${summaryClass}">
      <div class="cb-sum-line">${primaryLine}</div>
      <div class="cb-sum-interp">${esc(interp)}</div>
    </div>
    <div class="cb-grid">${cards}</div>`;
  // Post-render: hydrate each canvas with its image + bbox overlays.
  // We can't do this synchronously inside the cards.map loop because the
  // <canvas> elements only exist once innerHTML is committed.
  out.querySelectorAll('canvas.cb-canvas').forEach(canvas=>{
    const idx=parseInt(canvas.dataset.cbIdx);
    const item=results[idx]; if(!item || !item.image_b64) return;
    const im=new Image();
    im.onload=()=>_drawCoralBatchCanvas(canvas, im, item);
    im.src=item.image_b64;
  });
}

// Draw the source image to the canvas, then overlay COCO detection
// rectangles in green and (where applicable) the wildlife classifier
// rectangle in amber. Bbox coords come back from the server in the
// ORIGINAL image's pixel space, so we rescale them to the canvas size
// (= the resized transport image).
function _drawCoralBatchCanvas(canvas, im, item){
  // Match the canvas surface to the loaded image's intrinsic resolution
  // (= the 480-px-wide transport variant). CSS handles display sizing
  // via .cb-canvas { width:100%; height:auto }.
  canvas.width = im.naturalWidth;
  canvas.height = im.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(im, 0, 0);
  const ow = item.image_w || im.naturalWidth;
  const oh = item.image_h || im.naturalHeight;
  const sx = canvas.width / ow;
  const sy = canvas.height / oh;
  ctx.font = '12px ui-monospace,Menlo,Consolas,monospace';
  ctx.textBaseline = 'top';
  // ── COCO detections ───────────────────────────────────────────────
  const dets = item.detections || [];
  const cocoColor = '#4ade80';
  for(const d of dets){
    const b = d.bbox || [];
    if(b.length !== 4) continue;
    const x1=b[0]*sx, y1=b[1]*sy, x2=b[2]*sx, y2=b[3]*sy;
    ctx.strokeStyle = cocoColor;
    ctx.lineWidth = 2;
    ctx.strokeRect(x1, y1, x2-x1, y2-y1);
    // Label tab above the box. Falls inside the frame when box hugs the top edge.
    const txt = `${d.label} ${(d.score*100|0)}%`;
    const tw = ctx.measureText(txt).width + 8;
    const th = 16;
    const ly = y1 - th >= 0 ? y1 - th : y1;
    ctx.fillStyle = 'rgba(0,0,0,.65)';
    ctx.fillRect(x1, ly, tw, th);
    ctx.fillStyle = cocoColor;
    ctx.fillText(txt, x1+4, ly+2);
  }
  // ── Wildlife classifier ────────────────────────────────────────────
  // Only render the overlay when the classifier successfully mapped to one
  // of our categories (squirrel/fox/hedgehog). On a "kein Treffer" result
  // (wl.label == null) we leave the canvas alone — the bottom pill already
  // tells the user what ImageNet thought of the frame, and a full-frame
  // amber border would otherwise read like a positive detection.
  if(item.wildlife && item.wildlife.label){
    const wl = item.wildlife;
    // Use the squirrel/fox/hedgehog category colour so the box matches
    // the rest of the UI (and is consistent with COCO bbox colouring).
    const lblColor = _coralLabelColor(wl.label);
    let x1=0, y1=0, x2=canvas.width, y2=canvas.height, fullFrame=true;
    if(Array.isArray(wl.bbox) && wl.bbox.length===4){
      x1 = wl.bbox[0]*sx; y1 = wl.bbox[1]*sy;
      x2 = wl.bbox[2]*sx; y2 = wl.bbox[3]*sy;
      // Treat a near-full-frame bbox as the "no localisation" fallback.
      const w = x2-x1, h = y2-y1;
      fullFrame = (w >= canvas.width*0.95 && h >= canvas.height*0.95);
    }
    // Don't outline the entire image — when no localised bbox is available
    // we just paint the label badge in the top-left.
    if(!fullFrame){
      ctx.strokeStyle = lblColor;
      ctx.lineWidth = 2;
      ctx.strokeRect(x1+1, y1+1, Math.max(0, x2-x1-2), Math.max(0, y2-y1-2));
    }
    const txt = wl.score!=null ? `${wl.label} ${(wl.score*100|0)}%` : wl.label;
    const tw = ctx.measureText(txt).width + 8;
    const th = 16;
    const lx = fullFrame ? 4 : x1;
    const ly = fullFrame ? 4 : (y1 - th >= 0 ? y1 - th : y1);
    ctx.fillStyle = 'rgba(0,0,0,.65)';
    ctx.fillRect(lx, ly, tw, th);
    ctx.fillStyle = lblColor;
    ctx.fillText(txt, lx+4, ly+2);
  }
}
byId('coralTestBtn')?.addEventListener('click',_runCoralTest);

function _truncMid(s,max){
  s=String(s||''); if(s.length<=max) return s;
  const keep=Math.max(8,Math.floor((max-1)/2));
  return s.slice(0,keep)+'…'+s.slice(-keep);
}
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

async function _loadCoralModels(){
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
byId('coralModelsReload')?.addEventListener('click',_loadCoralModels);
