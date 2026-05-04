// ─── camedit/coral-test/results.js ─────────────────────────────────────────
// R12 — extracted from coral-test.js. Result-card rendering + per-mode
// grouping. Owns the result-grid DOM; delegates canvas drawing to bbox.js
// (which is hydrated once each card's <canvas> is mounted).
import { esc } from "../../core/dom.js";
import {
  _coralLabelColor,
  _drawCoralBatchCanvas,
  _truncMid,
} from "./bbox.js";

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

export function _renderCoralModelsRun(modelsRun){
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

// ── Mode-aware result helpers ────────────────────────────────────────────
// Source-model badges are styled in css/27-coral-test-modes.css. The colour
// ramp lives there too — keep these helpers HTML-only so a future cleanup
// can move the templating to a single render function without re-flowing
// the CSS.
const _CORAL_SOURCE_NICK_FALLBACK = {
  coco: 'COCO SSD',
  bird_species: 'Vögel',
  wildlife: 'Wildtiere',
};

// Per-image detection pill, optionally tagged with its source-model
// badge. Reused by both the cascade/coco_only paths (flat list) and
// the all_independent path (grouped under sub-headers).
export function _renderCoralDetectionPill(d){
  const c = _coralLabelColor(d.label);
  const spPct = d.species_score != null ? ` ${(d.species_score * 100).toFixed(0)}%` : '';
  const spLat = (d.species_latin && d.species && d.species !== d.species_latin)
    ? ` <span class="ct-species-lat">(${esc(d.species_latin)})</span>`
    : '';
  const speciesLine = d.species
    ? `<span class="ct-species" style="color:${c}">→ ${esc(d.species)}${spLat}${spPct}</span>`
    : '';
  const src = d.source_model;
  const badge = src
    ? `<span class="ct-src-badge ct-src-badge--${esc(src)}">${esc(_CORAL_SOURCE_NICK_FALLBACK[src] || src)}</span>`
    : '';
  return `<span class="ct-pill${d.species ? ' ct-pill--2line' : ''}" style="border-left-color:${c}">
    <span class="ct-pill-main">${esc(d.label)}<span class="ct-pct">${(d.score * 100).toFixed(0)}%</span></span>
    ${speciesLine}
    ${badge}
  </span>`;
}

// "Alle Modelle einzeln" mode — render three rows under each card, one
// per model, with a "kein Treffer" placeholder when the model produced
// nothing for this image (the absence is itself diagnostic).
export function _renderCoralGroupedPills(dets, modelNames){
  const groups = { coco: [], bird_species: [], wildlife: [] };
  for (const d of (dets || [])){
    const k = d.source_model;
    if (k && groups[k]) groups[k].push(d);
  }
  const order = ['coco', 'bird_species', 'wildlife'];
  const titleOf = (k) => (modelNames[k]?.nickname) || _CORAL_SOURCE_NICK_FALLBACK[k] || k;
  return order.map(k => {
    const head = `<div class="cb-group-head">${esc(titleOf(k))}</div>`;
    if (!groups[k].length){
      return `<div class="cb-group">
        ${head}
        <div class="cb-group-empty">kein Treffer</div>
      </div>`;
    }
    return `<div class="cb-group">
      ${head}
      <div class="cb-group-pills">${groups[k].map(d => _renderCoralDetectionPill(d)).join('')}</div>
    </div>`;
  }).join('');
}

export function _renderCoralBatchResult(out,r,folder){
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
  // Mode + per-model nicknames drive card layout. In all_independent
  // mode each card groups detections under three sub-headers so the
  // user can see what every model said about every image.
  const respMode=r.mode||'cascade';
  const modelNames=(r.models_active||{});
  const cards=results.map(item=>{
    if(item.error){
      return `<div class="cb-card"><div class="cb-card-err">${esc(item.filename)}: ${esc(item.error)}</div></div>`;
    }
    const dets=item.detections||[];
    const pills=respMode==='all_independent'
      ? _renderCoralGroupedPills(dets,modelNames)
      : (dets.length
          ? dets.map(d=>_renderCoralDetectionPill(d)).join('')
          : '<span class="cb-empty">Keine Objekte erkannt</span>');
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
