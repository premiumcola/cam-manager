// ─── Stage-2 core/* imports ─────────────────────────────────────────────────
// Helpers extracted from this file's top into per-domain modules under
// js/core/. Listed individually so a future tree-shake can drop unused
// names — and so each helper's home is easy to find by name.
import { state, shapeState, IS_IOS, STAT_MEDIA_DRILLDOWN } from './core/state.js';
import { byId, esc } from './core/dom.js';
import { j } from './core/api.js';
import { showToast, showConfirm, _resolveConfirm, bindConfirmModal } from './core/toast.js';
import {
  colors, OBJ_LABEL, OBJ_SVG, objBubble, objIconSvg, TL_LABELS,
  getCameraIcon, getCameraColor,
} from './core/icons.js';

// _hmTip stays here — fixed-position heatmap tooltip used only by the
// timeline view; will move with the timeline module in a later stage.
let _hmTip=null;
// OBJ_SVG / objBubble / objIconSvg / TL_LABELS now live in core/icons.js
function _renderLbLabels(){
  const el=byId('lightboxLabels');
  if(!el||!_lbItem) return;
  const active=new Set(_lbItem.labels||[]);
  const species=_lbItem.bird_species||'';
  const birdColor=colors.bird||'#0ea5e9';
  const bubbles=TL_LABELS.map(l=>{
    const isActive=active.has(l);
    const rawSvg=OBJ_SVG[l]||OBJ_SVG.alarm;
    const svg=rawSvg.replace('width="16" height="16"','width="38" height="38"');
    const title=OBJ_LABEL[l]||l;
    const c=colors[l]||colors.unknown;
    const speciesSub=(l==='bird' && species && isActive)
      ? `<span style="position:absolute;top:calc(100% + 4px);left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.72);color:${birdColor};font-size:11px;font-weight:700;padding:3px 8px;border-radius:8px;white-space:nowrap;border:1px solid ${birdColor}55;pointer-events:none">${esc(species)}</span>`
      : '';
    return `<span data-label="${l}" title="${title}" style="position:relative;width:54px;height:54px;border-radius:50%;background:${isActive?c+'30':'rgba(0,0,0,0.60)'};filter:drop-shadow(0 2px 8px rgba(0,0,0,0.8));display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;cursor:pointer;pointer-events:auto;transition:background .15s,opacity .15s,border-color .15s;opacity:${isActive?'1':'0.6'};border:2px solid ${isActive?c+'cc':'rgba(255,255,255,0.08)'}">${svg}${speciesSub}</span>`;
  }).join('');
  el.innerHTML=bubbles;
  el.querySelectorAll('[data-label]').forEach(btn=>{
    btn.onclick=async()=>{
      const lbl=btn.dataset.label;
      const cur=new Set(_lbItem.labels||[]);
      if(cur.has(lbl)) cur.delete(lbl); else cur.add(lbl);
      const newLabels=[...cur];
      try{
        const res=await j(`/api/camera/${_lbItem.camera_id}/events/${_lbItem.event_id}/labels`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({labels:newLabels})});
        if(res.ok){
          _lbItem.labels=res.labels;
          if(res.top_label!==undefined) _lbItem.top_label=res.top_label;
          const idx=(state.media||[]).findIndex(x=>x.event_id===_lbItem.event_id);
          if(idx>=0){
            state.media[idx].labels=res.labels;
            if(res.top_label!==undefined) state.media[idx].top_label=res.top_label;
          }
          const aIdx=(state._allMedia||[]).findIndex(x=>x.event_id===_lbItem.event_id);
          if(aIdx>=0){
            state._allMedia[aIdx].labels=res.labels;
            if(res.top_label!==undefined) state._allMedia[aIdx].top_label=res.top_label;
          }
          _renderLbLabels();
          // sync thumbnail in media grid
          const thumbCard=byId('mediaGrid')?.querySelector(`[data-event-id="${CSS.escape(_lbItem.event_id)}"]`);
          if(thumbCard){const bubblesEl=thumbCard.querySelector('.media-label-bubbles');if(bubblesEl) bubblesEl.innerHTML=res.labels.slice(0,3).map(l=>objBubble(l,26)).join('');}
          // Re-pull timeline + storage stats so badges and dots reflect the retag.
          refreshTimelineAndStats();
        }
      }catch(e){console.error('label update failed',e);}
    };
  });
}
// getCameraIcon / getCameraColor now live in core/icons.js.
// shapeState now lives in core/state.js. byId / esc now live in
// core/dom.js. The fetch helper `j` now lives in core/api.js.

// ── Squirrel character library ────────────────────────────────────────────────
const SQUIRREL_CHARS=[
  // 1: original hopping squirrel with camera
  `<svg viewBox="0 0 52 52" width="72" height="72" xmlns="http://www.w3.org/2000/svg"><g class="sq-hop-anim" style="transform-origin:26px 40px"><path d="M36 42 Q48 32 46 18 Q44 8 34 10 Q24 12 28 26 Q32 38 36 42Z" fill="none" stroke="#cfe7ff" stroke-width="2" stroke-linecap="round"/><ellipse cx="22" cy="36" rx="10" ry="8" fill="none" stroke="#cfe7ff" stroke-width="2"/><circle cx="22" cy="24" r="8" fill="none" stroke="#cfe7ff" stroke-width="2"/><path d="M16 18 L14 12 L20 16Z" fill="none" stroke="#cfe7ff" stroke-width="1.5" stroke-linejoin="round"/><path d="M26 18 L28 12 L22 16Z" fill="none" stroke="#cfe7ff" stroke-width="1.5" stroke-linejoin="round"/><circle cx="25" cy="23" r="1.8" fill="#cfe7ff"/><ellipse cx="28" cy="26" rx="2.5" ry="1.5" fill="none" stroke="#cfe7ff" stroke-width="1.5"/><g class="cam-wobble-anim" style="transform-origin:22px 33px"><rect x="14" y="30" width="16" height="11" rx="2.5" fill="none" stroke="#cfe7ff" stroke-width="1.8"/><circle cx="22" cy="35.5" r="3" fill="none" stroke="#cfe7ff" stroke-width="1.5"/><rect x="25" y="28.5" width="4" height="3" rx="1" fill="none" stroke="#cfe7ff" stroke-width="1.5"/></g><line x1="16" y1="43" x2="14" y2="50" stroke="#cfe7ff" stroke-width="2" stroke-linecap="round" class="leg-l-anim"/><line x1="28" y1="43" x2="30" y2="50" stroke="#cfe7ff" stroke-width="2" stroke-linecap="round" class="leg-r-anim"/></g></svg>`,
  // 2: burglar — eye mask, camera in sack over shoulder
  `<svg viewBox="0 0 72 72" width="72" height="72" xmlns="http://www.w3.org/2000/svg"><g class="sq-hop-anim" style="transform-origin:30px 58px"><path d="M44 54 Q58 42 56 26 Q54 12 44 14 Q34 16 38 30 Q42 44 44 54Z" fill="none" stroke="#cfe7ff" stroke-width="2" stroke-linecap="round"/><ellipse cx="28" cy="46" rx="12" ry="10" fill="none" stroke="#cfe7ff" stroke-width="2"/><circle cx="28" cy="28" r="9" fill="none" stroke="#cfe7ff" stroke-width="2"/><path d="M21 21 L19 13 L27 20Z" fill="none" stroke="#cfe7ff" stroke-width="1.5" stroke-linejoin="round"/><path d="M33 21 L37 13 L30 20Z" fill="none" stroke="#cfe7ff" stroke-width="1.5" stroke-linejoin="round"/><rect x="19" y="24" width="18" height="7" rx="3.5" fill="none" stroke="#cfe7ff" stroke-width="1.8"/><circle cx="25" cy="27" r="2" fill="none" stroke="#cfe7ff" stroke-width="1.5"/><circle cx="33" cy="27" r="2" fill="none" stroke="#cfe7ff" stroke-width="1.5"/><line x1="19" y1="27" x2="14" y2="27" stroke="#cfe7ff" stroke-width="1.5" stroke-linecap="round"/><ellipse cx="30" cy="34" rx="2" ry="1.5" fill="none" stroke="#cfe7ff" stroke-width="1.5"/><path d="M16 44 Q10 42 8 52" stroke="#cfe7ff" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="7" cy="57" r="7" fill="none" stroke="#cfe7ff" stroke-width="1.8"/><path d="M2 50 Q7 46 12 50" fill="none" stroke="#cfe7ff" stroke-width="1.5" stroke-linecap="round"/><circle cx="7" cy="57" r="3" fill="none" stroke="#cfe7ff" stroke-width="1.5"/><line x1="22" y1="55" x2="18" y2="65" stroke="#cfe7ff" stroke-width="2" stroke-linecap="round" class="leg-l-anim"/><line x1="34" y1="55" x2="38" y2="65" stroke="#cfe7ff" stroke-width="2" stroke-linecap="round" class="leg-r-anim"/></g></svg>`,
  // 3: rooftop spy — sitting on roof ridge with binoculars
  `<svg viewBox="0 0 72 72" width="72" height="72" xmlns="http://www.w3.org/2000/svg"><line x1="2" y1="67" x2="70" y2="60" stroke="#cfe7ff" stroke-width="2.5" stroke-linecap="round"/><line x1="2" y1="64" x2="70" y2="57" stroke="#cfe7ff" stroke-width="1" stroke-dasharray="4 3" stroke-linecap="round"/><g class="sq-hop-anim" style="transform-origin:26px 57px"><path d="M42 54 Q56 42 54 26 Q52 12 42 14 Q32 16 36 30 Q40 44 42 54Z" fill="none" stroke="#cfe7ff" stroke-width="2" stroke-linecap="round"/><ellipse cx="24" cy="48" rx="11" ry="10" fill="none" stroke="#cfe7ff" stroke-width="2"/><circle cx="24" cy="30" r="9" fill="none" stroke="#cfe7ff" stroke-width="2"/><path d="M17 23 L15 16 L22 22Z" fill="none" stroke="#cfe7ff" stroke-width="1.5" stroke-linejoin="round"/><path d="M29 23 L33 16 L26 22Z" fill="none" stroke="#cfe7ff" stroke-width="1.5" stroke-linejoin="round"/><circle cx="27" cy="29" r="1.8" fill="#cfe7ff"/><ellipse cx="29" cy="33" rx="2" ry="1.5" fill="none" stroke="#cfe7ff" stroke-width="1.5"/><line x1="35" y1="42" x2="44" y2="36" stroke="#cfe7ff" stroke-width="1.8" stroke-linecap="round"/><g class="cam-wobble-anim" style="transform-origin:44px 33px"><rect x="36" y="29" width="8" height="5" rx="2" fill="none" stroke="#cfe7ff" stroke-width="1.5"/><rect x="45" y="29" width="8" height="5" rx="2" fill="none" stroke="#cfe7ff" stroke-width="1.5"/><circle cx="40" cy="31" r="2" fill="none" stroke="#cfe7ff" stroke-width="1.2"/><circle cx="49" cy="31" r="2" fill="none" stroke="#cfe7ff" stroke-width="1.2"/><line x1="44" y1="31" x2="45" y2="31" stroke="#cfe7ff" stroke-width="2.5" stroke-linecap="round"/></g><line x1="18" y1="57" x2="14" y2="66" stroke="#cfe7ff" stroke-width="2" stroke-linecap="round" class="leg-l-anim"/><line x1="30" y1="57" x2="34" y2="66" stroke="#cfe7ff" stroke-width="2" stroke-linecap="round" class="leg-r-anim"/></g></svg>`,
  // 4: detective — deerstalker hat, magnifying glass
  `<svg viewBox="0 0 72 72" width="72" height="72" xmlns="http://www.w3.org/2000/svg"><g class="sq-hop-anim" style="transform-origin:28px 58px"><path d="M44 56 Q58 44 56 28 Q54 14 44 16 Q34 18 38 32 Q42 46 44 56Z" fill="none" stroke="#cfe7ff" stroke-width="2" stroke-linecap="round"/><ellipse cx="26" cy="46" rx="12" ry="10" fill="none" stroke="#cfe7ff" stroke-width="2"/><circle cx="26" cy="28" r="9" fill="none" stroke="#cfe7ff" stroke-width="2"/><path d="M19 21 L17 14 L24 20Z" fill="none" stroke="#cfe7ff" stroke-width="1.5" stroke-linejoin="round"/><path d="M31 21 L35 14 L28 20Z" fill="none" stroke="#cfe7ff" stroke-width="1.5" stroke-linejoin="round"/><path d="M16 20 Q18 11 26 10 Q34 11 36 20Z" fill="none" stroke="#cfe7ff" stroke-width="1.8"/><line x1="14" y1="20" x2="38" y2="20" stroke="#cfe7ff" stroke-width="2" stroke-linecap="round"/><path d="M14 20 Q12 17 16 15" fill="none" stroke="#cfe7ff" stroke-width="1.5" stroke-linecap="round"/><path d="M38 20 Q40 17 37 15" fill="none" stroke="#cfe7ff" stroke-width="1.5" stroke-linecap="round"/><circle cx="26" cy="10" r="1.5" fill="#cfe7ff"/><circle cx="29" cy="27" r="1.8" fill="#cfe7ff"/><ellipse cx="31" cy="31" rx="2" ry="1.5" fill="none" stroke="#cfe7ff" stroke-width="1.5"/><line x1="38" y1="44" x2="46" y2="50" stroke="#cfe7ff" stroke-width="2" stroke-linecap="round"/><g class="cam-wobble-anim" style="transform-origin:46px 47px"><circle cx="44" cy="45" r="7" fill="none" stroke="#cfe7ff" stroke-width="1.8"/><line x1="49" y1="50" x2="56" y2="58" stroke="#cfe7ff" stroke-width="2.5" stroke-linecap="round"/><path d="M40 41 Q42 39 44 40" fill="none" stroke="#cfe7ff" stroke-width="1.2" stroke-linecap="round"/></g><line x1="20" y1="55" x2="16" y2="65" stroke="#cfe7ff" stroke-width="2" stroke-linecap="round" class="leg-l-anim"/><line x1="32" y1="55" x2="36" y2="65" stroke="#cfe7ff" stroke-width="2" stroke-linecap="round" class="leg-r-anim"/></g></svg>`,
  // 5: paparazzo — crouching behind bush, long telephoto lens
  `<svg viewBox="0 0 72 72" width="72" height="72" xmlns="http://www.w3.org/2000/svg"><path d="M4 70 Q8 60 14 64 Q18 56 24 60 Q28 52 34 58 Q40 52 46 58 Q52 54 56 62 Q62 58 66 66 L66 70Z" fill="none" stroke="#cfe7ff" stroke-width="1.8" stroke-linejoin="round"/><g class="sq-hop-anim" style="transform-origin:28px 58px"><ellipse cx="28" cy="58" rx="12" ry="7" fill="none" stroke="#cfe7ff" stroke-width="2"/><path d="M44 60 Q58 48 56 32 Q54 18 44 20 Q34 22 38 36 Q41 50 44 60Z" fill="none" stroke="#cfe7ff" stroke-width="2" stroke-linecap="round"/><circle cx="26" cy="42" r="9" fill="none" stroke="#cfe7ff" stroke-width="2"/><path d="M19 35 L17 28 L24 34Z" fill="none" stroke="#cfe7ff" stroke-width="1.5" stroke-linejoin="round"/><path d="M31 35 L35 28 L28 34Z" fill="none" stroke="#cfe7ff" stroke-width="1.5" stroke-linejoin="round"/><circle cx="23" cy="41" r="2.2" fill="none" stroke="#cfe7ff" stroke-width="1.5"/><circle cx="23" cy="41" r="1" fill="#cfe7ff"/><circle cx="30" cy="41" r="2.2" fill="none" stroke="#cfe7ff" stroke-width="1.5"/><circle cx="30" cy="41" r="1" fill="#cfe7ff"/><ellipse cx="28" cy="46" rx="2" ry="1.5" fill="none" stroke="#cfe7ff" stroke-width="1.5"/><g class="cam-wobble-anim" style="transform-origin:40px 50px"><rect x="32" y="46" width="10" height="8" rx="1.5" fill="none" stroke="#cfe7ff" stroke-width="1.8"/><rect x="42" y="48" width="22" height="4" rx="2" fill="none" stroke="#cfe7ff" stroke-width="1.5"/><circle cx="65" cy="50" r="3" fill="none" stroke="#cfe7ff" stroke-width="1.5"/><rect x="34" y="44" width="4" height="2" rx="1" fill="none" stroke="#cfe7ff" stroke-width="1.2"/></g></g></svg>`,
];
const download=(url)=>window.open(url,'_blank');

// Dead-camera-id snapshot poll suppression. After a camera rename
// (manuf/model edit triggers storage_migration to compute a new
// canonical id), the old <img src="/api/camera/<old-id>/snapshot.jpg">
// elements stay in the DOM until the next renderDashboard. The
// 5 fps preview refresh keeps bumping their timestamps, producing
// a 404 storm in the console. _failedSnapshotIds tracks the camera
// ids whose snapshot endpoint has 404'd two times in a row;
// _camImgRetry stops retrying once that threshold is hit, and the
// preview refresh skips them. Every loadAll() resets the map since
// the next dashboard re-render will use the fresh ids from
// /api/cameras.
const _failedSnapshotIds = new Map();
function _resetFailedSnapshotIds(){ _failedSnapshotIds.clear(); }
function _isSnapshotIdDead(camId){
  return camId ? (_failedSnapshotIds.get(camId) || 0) >= 2 : false;
}
function _camIdFromImg(img){
  return img?.closest?.('[data-camid]')?.dataset?.camid || null;
}

// ── Camera snapshot retry (handles 503 on initial load before stream is ready) ─
function _camImgRetry(img){
  const camId = _camIdFromImg(img);
  // After a rename, the old camera id keeps producing 404s on every
  // poll until the dashboard re-renders. Two consecutive failures is
  // the threshold for marking the id dead — that catches a real
  // rename (the new img element will carry the fresh id) while
  // tolerating one transient 503 during cam restart.
  if (camId) {
    const n = (_failedSnapshotIds.get(camId) || 0) + 1;
    _failedSnapshotIds.set(camId, n);
    if (n >= 2) {
      img.style.display = 'none';
      return;
    }
  }
  const retries=parseInt(img.dataset.snapRetry||'0');
  if(retries>=12){img.style.display='none';return;}
  img.dataset.snapRetry=retries+1;
  // Exponential backoff: 500ms, 1s, 1.5s … capped at 3s
  const delay=Math.min(500*(retries+1),3000);
  setTimeout(()=>{
    if(!img.isConnected) return; // card removed from DOM
    const base=img.src.split('?')[0];
    img.src=base+'?t='+Date.now();
  },delay);
}
window._camImgRetry=_camImgRetry;

// ─── DIAG:cam-edit-lock ─────────────────────────────────────────────────────
// Temporary diagnostic strip + helper for the "cam-edit panel locks until
// F5 after a Verbinden/restart" bug. The strip shows a rolling history of
// the last 8 events so the lock-up moment is visible in real time. To
// remove this entire block plus the inline _erkDebugSet calls below,
// search for the literal string "DIAG:cam-edit-lock" and delete every
// matching line.
const _erkDebugHistory = [];
function _erkDebugSet(msg){
  try{
    const ts = new Date();
    const stamp = `${String(ts.getHours()).padStart(2,'0')}:`
                + `${String(ts.getMinutes()).padStart(2,'0')}:`
                + `${String(ts.getSeconds()).padStart(2,'0')}`
                + `.${String(ts.getMilliseconds()).padStart(3,'0').slice(0,2)}`;
    _erkDebugHistory.push(`${stamp} ${msg}`);
    while(_erkDebugHistory.length > 8) _erkDebugHistory.shift();
    let strip = document.getElementById('erkDebugStrip');
    if(!strip){
      strip = document.createElement('div');
      strip.id = 'erkDebugStrip';
      strip.style.cssText = 'position:fixed;top:8px;left:8px;z-index:99999;'
        + 'background:rgba(0,0,0,.85);color:#fde047;padding:8px 10px;'
        + 'border-radius:8px;font-family:ui-monospace,Menlo,monospace;'
        + 'font-size:10.5px;line-height:1.45;max-width:min(90vw,520px);'
        + 'pointer-events:none;white-space:pre-wrap;backdrop-filter:blur(4px)';
      document.body.appendChild(strip);
    }
    strip.textContent = _erkDebugHistory.join('\n');
  }catch(_){}
}
window._erkDebugSet = _erkDebugSet;
// ─── /DIAG:cam-edit-lock ────────────────────────────────────────────────────

// ── Camera edit slide panel ───────────────────────────────────────────────────
let _currentEditCamId=null;
function _restoreEditWrapper(){
  const w=byId('cameraEditWrapper');
  // DIAG:cam-edit-lock — surface whether the wrapper exists at the moment
  // of restore. If it's null here, that's the lock cause: a previous
  // renderCameraSettings blew away the row that held it.
  _erkDebugSet(`_restoreEditWrapper · wrapper=${w?'ok':'NULL'} · _currentEditCamId=${_currentEditCamId}`);
  if(!w) return;
  w.classList.remove('slide-open');
  document.querySelectorAll('.cam-item.editing').forEach(el=>el.classList.remove('editing'));
  const sec=byId('cameras'); if(sec&&w.parentElement!==sec) sec.appendChild(w);
  _currentEditCamId=null;
}
function _closeEditPanel(){
  if(!_currentEditCamId) return;
  const w=byId('cameraEditWrapper');
  _erkDebugSet(`_closeEditPanel · wrapper=${w?'ok':'NULL'}`);  // DIAG:cam-edit-lock
  w?.classList.remove('slide-open');
  document.querySelectorAll('.cam-item.editing').forEach(el=>el.classList.remove('editing'));
  // The 400 ms timeout lets the slide-out animation finish before
  // detaching the wrapper from its host row. If `w` was already null
  // when we entered (the wrapper was destroyed by a renderCameraSettings
  // innerHTML blow), or if it gets detached between now and the
  // timeout firing, sec.appendChild(null) would throw
  // "parameter 1 is not of type 'Node'". The guard inside the timer
  // re-checks both `w` and `sec` so a transient null on either side
  // is silently absorbed instead of cascading into an uncaught error.
  setTimeout(()=>{
    if(!w) return;
    const sec=byId('cameras');
    if(sec) sec.appendChild(w);
  },400);
  _currentEditCamId=null;
}

// ── Live update ───────────────────────────────────────────────────────────────
let _liveUpdateInterval=null;
let _previewRefreshInterval=null;
const _prevCamStatuses=new Map();

// ── 5fps dashboard preview refresh ────────────────────────────────────────────
// Refreshes all visible camera thumbnails at ~5fps while the tab is active.
// Uses the existing snapshot.jpg endpoint (served from sub-stream frame buffer).
const _hdCards=new Set();
function startPreviewRefresh(){
  if(_previewRefreshInterval) clearInterval(_previewRefreshInterval);
  _previewRefreshInterval=setInterval(()=>{
    if(document.hidden) return; // don't burn requests when tab is backgrounded
    const grid=byId('cameraCards');
    if(!grid) return;
    grid.querySelectorAll('.cv-img.loaded').forEach(img=>{
      if(img.dataset.hdMode==='1') return; // HD MJPEG stream refreshes itself
      // Skip stale post-rename camera ids (see _failedSnapshotIds).
      // Without this, the 5 fps loop keeps refreshing dead URLs and
      // produces a 404 storm in the console until the dashboard
      // re-renders with the fresh id.
      const camId = _camIdFromImg(img);
      if (_isSnapshotIdDead(camId)) return;
      const base=img.src.split('?')[0];
      img.src=base+'?t='+Date.now();
    });
  },200); // 5fps
}
function toggleCardHd(camId,btn){
  const card=btn.closest('.cv-card');
  const img=card?.querySelector('.cv-img');
  if(!img) return;
  if(_hdCards.has(camId)){
    _hdCards.delete(camId);
    btn.classList.remove('active');
    img.dataset.hdMode='0';
    img.src=`/api/camera/${encodeURIComponent(camId)}/snapshot.jpg?t=${Date.now()}`;
  } else {
    _hdCards.add(camId);
    btn.classList.add('active');
    img.dataset.hdMode='1';
    img.src=`/api/camera/${encodeURIComponent(camId)}/stream_hd.mjpg`;
  }
  _refreshLivePillForCard(camId);
}

// Re-paint the expanded LivePill row values for one card based on current HD state.
// Used by both toggleCardHd() and the 3s polling loop so the pill never shows
// sub-stream values while HD-Stream is active.
function _refreshLivePillForCard(camId){
  const card=byId('cameraCards')?.querySelector(`[data-camid="${CSS.escape(camId)}"]`);
  if(!card) return;
  const livePill=card.querySelector('.cv-pill-live-wrap');
  if(!livePill) return;
  const c=(state.cameras||[]).find(x=>x.id===camId)||{};
  const hdOn=_hdCards.has(camId);
  const modeEl=livePill.querySelector('.cv-stream-mode');
  if(modeEl){
    if(hdOn){
      modeEl.textContent='● HD-Stream';
      modeEl.className='cv-stream-mode cv-mode-hd';
    } else {
      const mode=c.stream_mode||'baseline';
      modeEl.textContent=mode==='live'?'● Live':'○ Vorschau';
      modeEl.className='cv-stream-mode '+(mode==='live'?'cv-mode-live':'cv-mode-base');
    }
  }
  const fpsEl=livePill.querySelector('.cv-lp-fps-val');
  if(fpsEl) fpsEl.textContent=hdOn?'—':((c.preview_fps||0)>0?(c.preview_fps+' fps'):'—');
  const fpsSubEl=livePill.querySelector('.cv-lp-fps-sub');
  if(fpsSubEl) fpsSubEl.textContent=hdOn?'Main-Stream aktiv':'Gemessen (Sub-Stream)';
  const resEl=livePill.querySelector('.cv-lp-res-val');
  if(resEl) resEl.textContent=hdOn?'Main-Stream':(c.preview_resolution||c.resolution||'—');
}
window._refreshLivePillForCard=_refreshLivePillForCard;
window.toggleCardHd=toggleCardHd;

function startLiveUpdate(){
  if(_liveUpdateInterval) clearInterval(_liveUpdateInterval);
  state.cameras.forEach(c=>_prevCamStatuses.set(c.id,c.status));
  _liveUpdateInterval=setInterval(async()=>{
    try{
      const r=await j('/api/cameras');
      // Transitions into/out of 'active' change whether the live overlays
      // (cv-tr / cv-br) are present in the DOM — those only render when
      // the camera is active. Simply toggling classes isn't enough; we
      // need a full renderDashboard() so the missing overlay nodes appear.
      let needsRedraw=false;
      (r.cameras||[]).forEach(c=>{
        const prev=_prevCamStatuses.get(c.id);
        _prevCamStatuses.set(c.id,c.status);
        if(prev!==c.status){
          const wasActive=prev==='active';
          const nowActive=c.status==='active';
          if(wasActive!==nowActive) needsRedraw=true;
          if(c.status==='starting') showCameraReloadAnimation(c.id);
          // Camera settings list badge
          const item=byId('cameraSettingsList')?.querySelector(`[data-camid="${CSS.escape(c.id)}"]`);
          if(item){
            const stCol=s=>s==='active'?'good':s==='error'?'danger':'warn';
            const b=item.querySelector('.badge');
            if(b){b.className=`badge ${stCol(c.status)}`;b.textContent=c.status||'—';}
          }
        }
        // Always update live pill and FPS display
        const card=byId('cameraCards')?.querySelector(`[data-camid="${CSS.escape(c.id)}"]`);
        if(card){
          const livePill=card.querySelector('.cv-pill-live-wrap');
          if(livePill){
            const isActive=c.status==='active';
            livePill.classList.toggle('cv-live-active',isActive);
            livePill.classList.toggle('cv-live-off',!isActive);
            const hdr=livePill.querySelector('.cv-live-exp-header span');
            if(hdr) hdr.textContent='Livestream '+(isActive?'aktiv':'inaktiv');
            // Stash the latest sub-stream values on the cached camera record so
            // the next HD-off transition has fresh data, but do NOT paint the
            // pill yet — _refreshLivePillForCard() decides what to render based
            // on HD state.
            const cached=(state.cameras||[]).find(x=>x.id===c.id);
            if(cached){
              cached.preview_fps=c.preview_fps;
              cached.stream_mode=c.stream_mode;
              cached.preview_resolution=c.preview_resolution;
              cached.resolution=c.resolution;
              cached.status=c.status;
            }
            _refreshLivePillForCard(c.id);
          }
        }
      });
      if(needsRedraw){
        state.cameras=r.cameras||state.cameras;
        renderDashboard();
      }
      // Refresh the cam-edit Erkennung-tab status strip every poll so
      // the dot colour, ms/Frame, and "letztes Update vor X" stay in
      // sync with reality. The function reads the form's current cam id
      // and is a no-op when no cam-edit form is open.
      _renderGlobalStatusRows();
      // Same for the Alerting-tab status strip (Telegram bot
      // connection state). Fire-and-forget; bails silently on errors.
      _renderAlertStatusStrip();
    }catch{/* silent */}
  },3000);
}

async function loadAll(){
  _restoreEditWrapper();
  state.bootstrap=await j('/api/bootstrap');
  state.config=await j('/api/config');
  state.cameras=(await j('/api/cameras')).cameras||[];
  // Fresh camera list — clear the post-rename dead-id tally so the
  // (now-current) ids start polling again. _camImgRetry rebuilds the
  // map on the next 404 streak if a rename happens later.
  _resetFailedSnapshotIds();
  if(typeof window._updateMobileDockLiveDot==='function') window._updateMobileDockLiveDot();
  state.timeline=await j(`/api/timeline?hours=${state.tlHours||168}${state.label?`&label=${encodeURIComponent(state.label)}`:''}`);
  await loadMediaStorageStats();
  renderShell();
  renderDashboard();
  renderTimeline();
  renderCameraSettings();
  await renderProfiles();
  await renderAudit();
  hydrateSettings();
  hydrateTelegram();
  initTelegramTabs();
  hydratePushUI();
  initWeatherTabs();
  initWeatherStats();
  await loadWeatherSightings();
  hydrateWeatherSettings();
  loadTlStatus();
  _updateTlActiveTags(state.cameras||[]);
  if(state.bootstrap.needs_wizard) openWizard();
  byId('openWizardBtn').classList.toggle('hidden', !!state.bootstrap?.wizard_completed || !state.bootstrap?.needs_wizard);
  startPreviewRefresh(); // 5fps thumbnail refresh for dashboard cards
  updateMediaSectionTitle();
}

// Single source of truth for page size: rows × dynamic column count.
// Called before every load, page-change, delete, resize, and filter-change.
let _lastKnownCols=0;
const _MEDIA_ROWS=4;
function calcItemsPerPage(){
  const grid=byId('mediaGrid');
  let containerW=0;
  if(grid){
    const gr=grid.getBoundingClientRect();
    if(gr.width>0) containerW=gr.width;
  }
  if(!containerW){
    const isMobile=window.innerWidth<=768;
    const mediaEl=byId('media');
    containerW=Math.max(193,mediaEl&&mediaEl.clientWidth>192?mediaEl.clientWidth-24:window.innerWidth-(isMobile?24:320));
  }
  const GAP=10,MIN_CARD=192;
  const cols=_lastKnownCols||Math.max(1,Math.floor((containerW+GAP)/(MIN_CARD+GAP)));
  return _MEDIA_ROWS*cols;
}
// Filter labels rendered in the Mediathek pill bar. Sort happens at render
// time (by count desc); this list seeds the canonical set + tie-break order.
const MEDIA_FILTER_LABELS=['motion','person','cat','bird','car','dog','squirrel','timelapse'];

function _aggregateMediaCounts(){
  const counts={};
  MEDIA_FILTER_LABELS.forEach(l=>counts[l]=0);
  const stats=(state.mediaStats||[]).filter(s=>{
    if(!state.mediaCamera) return true;
    return (s.camera_id||s.id||s.name)===state.mediaCamera;
  });
  stats.forEach(s=>{
    const lc=s.label_counts||{};
    Object.entries(lc).forEach(([k,v])=>{
      if(Object.prototype.hasOwnProperty.call(counts,k)) counts[k]+=v||0;
    });
    counts.timelapse+=s.timelapse_count||0;
  });
  return counts;
}

function _seedTopMediaLabel(){
  // Seed-all-available: pre-select every label that actually has items
  // in the currently-aggregated counts. Tapping a pill DESELECTS it;
  // tapping again reselects. An empty Set is a UX shortcut for "no filter
  // active → show everything" — never an empty grid.
  const counts=_aggregateMediaCounts();
  const present=MEDIA_FILTER_LABELS.filter(l=>(counts[l]||0)>0);
  state.mediaLabels=new Set(present);
  return present.length>0;
}

function _pruneEmptyMediaFilters(){
  const counts=_aggregateMediaCounts();
  const before=state.mediaLabels.size;
  for(const l of [...state.mediaLabels]){
    if(!counts[l]) state.mediaLabels.delete(l);
  }
  return before>0 && state.mediaLabels.size===0;
}

// mode: 'overview' (all pills, no counts, click → openAllMediaDrilldown(label))
//       'drilldown' (only pills with count>0, with counts, toggles state.mediaLabels)
function renderMediaFilterPills(mode){
  const id=mode==='overview'?'mediaFilterBarOverview':'mediaFilterBar';
  const bar=byId(id); if(!bar) return;
  const counts=_aggregateMediaCounts();
  const sorted=MEDIA_FILTER_LABELS.slice().sort((a,b)=>{
    const d=(counts[b]||0)-(counts[a]||0);
    if(d) return d;
    return MEDIA_FILTER_LABELS.indexOf(a)-MEDIA_FILTER_LABELS.indexOf(b);
  });
  const labels=mode==='overview'?sorted:sorted.filter(l=>(counts[l]||0)>0);
  let html=labels.map(l=>{
    const cnt=counts[l]||0;
    const empty=cnt===0;
    const active=mode==='drilldown'&&state.mediaLabels.has(l);
    const cls=`media-pill cat-filter-btn${active?' active':''}${empty?' media-pill--empty':''}`;
    const cb=CAT_COLORS[l]||'#94a3b8';
    const cntChip=(mode==='drilldown'&&cnt>0)?`<span class="mp-count" style="pointer-events:none">${cnt}</span>`:'';
    return `<button type="button" class="${cls}" data-type="label" data-val="${l}" style="--cb:${cb}"${empty?' tabindex="-1" aria-disabled="true"':''}><span class="cfb-icon" style="pointer-events:none">${objIconSvg(l,18)}</span><span style="pointer-events:none">${OBJ_LABEL[l]||l}</span>${cntChip}</button>`;
  }).join('');
  // Status hint when the user has deselected every filter — the grid then
  // falls back to "show everything", and this pill keeps the state
  // visible so the user knows nothing is being hidden.
  if(mode==='drilldown' && state.mediaLabels.size===0 && labels.length>0){
    html+=`<span class="media-pill media-pill--status" aria-disabled="true">alle Filter aus</span>`;
  }
  bar.innerHTML=html;
  bar.querySelectorAll('.media-pill').forEach(p=>{
    if(p.classList.contains('media-pill--empty')) return;
    const val=p.dataset.val;
    // Belt-and-braces: re-set --cb via setProperty in addition to the
    // inline style attribute. The tinted-pill CSS reads var(--cb) for
    // the bg/text color-mix, and the drilldown bar inside .media-drill-
    // head was rendering as if --cb were missing on some browsers.
    if(val && CAT_COLORS[val]) p.style.setProperty('--cb',CAT_COLORS[val]);
    p.addEventListener('click',()=>{
      if(mode==='overview'){
        openAllMediaDrilldown(val);
        return;
      }
      if(state.mediaLabels.has(val)) state.mediaLabels.delete(val);
      else state.mediaLabels.add(val);
      state.mediaPage=0;
      renderMediaFilterPills('drilldown');
      if(byId('mediaDrilldown')?.style.display!=='none'){
        loadMedia().then(()=>{renderMediaGrid();renderMediaPagination();});
      }
    });
  });
}
let _cachedPageSize=0;
async function loadMedia(){
  const labels=state.mediaLabels;
  const ps=calcItemsPerPage(); _cachedPageSize=ps;
  const cams=state.mediaCamera?[state.mediaCamera]:state.cameras.map(c=>c.id);
  // Unified filter — EventStore now holds both motion and timelapse events.
  const allLabels=[...labels];
  const labelParam=allLabels.length===1?`&label=${encodeURIComponent(allLabels[0])}`
    :allLabels.length>1?`&labels=${encodeURIComponent(allLabels.join(','))}`:'';
  // Fetch ALL matching items from every camera in one pass (no server-side offset).
  // Pagination is done client-side on the merged+sorted list so that multi-camera
  // views produce a consistent global order and every page is fully filled.
  const allItems=[];
  for(const camId of cams){
    const data=await j(`/api/camera/${camId}/media?limit=9999&offset=0${labelParam}`);
    const items=data.items||[];
    for(const item of items) allItems.push({...item,camera_id:camId});
  }
  allItems.sort((a,b)=>(b.time||'').localeCompare(a.time||''));
  state._allMedia=allItems;
  // If the active label filter has no matching items (period change etc.),
  // drop it and reload once with the cleaned filter.
  const availNow=new Set(allItems.flatMap(item=>item.labels||[]));
  const toClear=[...state.mediaLabels].filter(l=>l!=='timelapse'&&!availNow.has(l));
  if(toClear.length){
    toClear.forEach(l=>state.mediaLabels.delete(l));
    syncMediaPills();
    return loadMedia();
  }
  state.mediaTotalPages=Math.max(1,Math.ceil(allItems.length/ps));
  state.mediaPage=Math.min(state.mediaPage||0,state.mediaTotalPages-1);
  const offset=(state.mediaPage||0)*ps;
  state.media=allItems.slice(offset,offset+ps);
  state.mediaHasMore=false;
}

function renderShell(){
  // Hero title is now a static "TAM-spy" lockup with the squirrel-on-
  // hyphen ornament — no longer driven by config.app.{name,tagline,
  // subtitle}. Side-nav app-name still hydrates if present so users
  // who renamed the app via Settings keep their custom label there.
  const _sideAppName=byId('sideAppName');
  if (_sideAppName) _sideAppName.textContent = state.config.app.name || 'TAM-spy';
  // Null-guard the legacy hero IDs so a config still containing
  // tagline/subtitle doesn't crash renderShell — they just no-op.
  const nameEl = byId('appName');
  if (nameEl) nameEl.textContent = state.config.app.name || 'TAM-spy';
  const tagEl = byId('appTagline');
  if (tagEl) tagEl.textContent = state.config.app.tagline || 'Motion · Objekte · Timelapse';
  const subEl = byId('appSubtitle');
  if (subEl) subEl.textContent = state.config.app.subtitle || 'RTSP-Streams · KI-Erkennung · Vogelarten · Telegram-Alerts';
}

function _camGridCols(n){
  if(n<=1) return 'cam-grid-1';
  if(n<=2) return 'cam-grid-2';
  if(n<=4) return 'cam-grid-4';
  return 'cam-grid-n';
}

// Surveillance mode for the live-tile bottom-overlay. Four states drive
// the colour + label + animation of the new .cv-surveil block:
//   off     cam disarmed                          → grey, eye crossed-out
//   watch   armed, no Telegram, no active window  → storm-blue, passive
//   notify  armed + Telegram on                   → amber, eye blinks
//   alarm   armed + currently inside a schedule
//           window with telegram or hard action   → red, head pulses
const SURVEIL_ACC = {
  off:    '80,80,90',
  watch:  '127,174,201',
  notify: '251,146,60',
  alarm:  '220,38,38',
};
const SURVEIL_LABEL = {
  off:    'Stumm',
  watch:  'Beobachtung',
  notify: 'Benachrichtigung',
  alarm:  'Wachmodus',
};
function _isInScheduleWindow(from, to){
  if (!from || !to) return false;
  const now = new Date();
  const m = now.getHours()*60 + now.getMinutes();
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  const f = fh*60 + fm, t = th*60 + tm;
  return f <= t ? (m >= f && m < t) : (m >= f || m < t);
}
function _surveilMode(c){
  if (!c.armed) return 'off';
  const sch = c.schedule || {};
  if (sch.enabled && _isInScheduleWindow(sch.from, sch.to)){
    const acts = sch.actions || {};
    if (acts.telegram !== false || acts.hard !== false) return 'alarm';
  }
  return c.telegram_enabled ? 'notify' : 'watch';
}
function _surveilEyeSvg(mode){
  if (mode === 'off') {
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';
  }
  return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/></svg>';
}

function renderDashboard(){
  const cams=state.cameras;
  const gridCls=_camGridCols(cams.length);
  byId('cameraCards').className=`camera-grid ${gridCls}`;
  byId('cameraCards').innerHTML=cams.map(c=>{
    const hdOn=_hdCards.has(c.id);
    const snapUrl=hdOn
      ? `/api/camera/${esc(c.id)}/stream_hd.mjpg`
      : `/api/camera/${esc(c.id)}/snapshot.jpg?t=${Date.now()}`;
    const isActive=c.status==='active';
    const tlOn=!!(c.timelapse&&c.timelapse.enabled);
    const fps=c.frame_interval_ms?Math.round(1000/c.frame_interval_ms):null;
    const previewFps=(c.preview_fps||0)>0?c.preview_fps:null;
    const streamMode=c.stream_mode||'baseline';
    const mode=_surveilMode(c);
    const acc=SURVEIL_ACC[mode];
    const label=SURVEIL_LABEL[mode];
    const sch=c.schedule||{};
    return `<article class="cv-card${c.armed?'':' cv-card--muted'}" data-camid="${esc(c.id)}" data-cam-name="${esc(c.name||c.id)}" onclick="_cvCardClick(event,'${esc(c.id)}')">
  <div class="cv-frame">
    <div class="cv-img-wrap">
      <div class="cv-loading-placeholder">${isActive?_makeConnectingPlaceholder():_makeOfflinePlaceholder()}</div>
      <img class="cv-img cam-snap" src="${snapUrl}" alt="${esc(c.name)}" data-hd-mode="${hdOn?'1':'0'}"
        onload="this.classList.add('loaded');this.previousElementSibling.style.display='none'"
        onerror="_camImgRetry(this)" />
    </div>
    <div class="cv-grad-top"></div>
    <div class="cv-grad-bot"></div>

    <!-- top-left: thematic icon + name. Surveillance mode lives in the
         bottom-left .cv-surveil block; no duplicate indicator here. -->
    <div class="cv-title-wrap">
      <div class="cv-name-row">
        <span class="cv-title-icon" aria-hidden="true">${getCameraIcon(c.name)}</span>
        <div class="cv-name">${esc(c.name)}</div>
      </div>
      ${c.location?`<div class="cv-loc">${esc(c.location)}</div>`:''}
    </div>
${isActive?`
    <!-- top-right: [Live + HD] row + optional Timelapse pill. The old
         alarm/notification pill moved into .cv-surveil below. -->
    <div class="cv-tr">
      <div class="cv-tr-row">
        <div class="cv-pill-live-wrap cv-live-active">
          <div class="cv-live-collapsed">
            <div class="cv-pdot"></div>
            <span>Live</span>
            ${previewFps?`<span style="color:rgba(134,239,172,.55);font-size:10px;font-weight:400;margin-left:3px">${previewFps} fps</span>`:''}
            <svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="rgba(200,245,224,.55)" stroke-width="1.8" stroke-linecap="round" style="margin-left:auto;margin-right:2px;flex-shrink:0"><path d="M3 4.5l3 3 3-3"/></svg>
          </div>
          <div class="cv-live-expanded">
            <div class="cv-live-exp-header">
              <div class="cv-pdot"></div>
              <span>Livestream aktiv</span>
            </div>
            <div class="cv-lp-row"><span>Stream-Modus</span><strong class="cv-stream-mode ${hdOn?'cv-mode-hd':(streamMode==='live'?'cv-mode-live':'cv-mode-base')}">${hdOn?'● HD-Stream':(streamMode==='live'?'● Live':'○ Vorschau')}</strong></div>
            <div class="cv-lp-row"><span>Preview-FPS<br><small class="cv-lp-fps-sub">${hdOn?'Analyse läuft im Sub-Stream weiter':'Gemessen (Sub-Stream)'}</small></span><strong class="cv-lp-fps-val">${hdOn?(previewFps!=null?previewFps+' fps':'—'):(previewFps!=null?previewFps+' fps':'—')}</strong></div>
            <div class="cv-lp-row"><span>Auflösung</span><strong class="cv-lp-res-val">${hdOn?esc(c.main_resolution||c.preview_resolution||c.resolution||'—'):esc(c.preview_resolution||c.resolution||'—')}</strong></div>
            <div class="cv-lp-row"><span>Analyse-Framerate<br><small>Wie oft TAM-spy analysiert</small></span><strong>${fps!=null?fps+' fps':'—'}</strong></div>
          </div>
        </div>
      </div>
      ${tlOn?`<div class="cv-pill cv-pill-tl" title="Timelapse aktiv">${objIconSvg('timelapse',14)}Timelapse</div>`:''}
    </div>
    ${c.rtsp_url?`<button class="cv-hd-badge${hdOn?' active':''}" data-cam="${esc(c.id)}" onclick="event.stopPropagation();toggleCardHd('${esc(c.id)}',this)" title="HD-Vorschau">HD</button>`:''}
`:''}
    <!-- bottom-left: surveillance stack — mode pill + targets row +
         optional schedule window time. Always rendered (mode='off'
         shows for disarmed cams too); targets+time hidden when off. -->
    <div class="cv-surveil" data-mode="${mode}" style="--surveil-acc:${acc}">
      <div class="cv-surveil-head">
        <span class="cv-surveil-eye">${_surveilEyeSvg(mode)}</span>
        <span class="cv-surveil-label">${esc(label)}</span>
      </div>
      ${mode==='off'?'':`
        <div class="cv-surveil-targets">
          ${(c.object_filter||[]).map(cls=>`<div class="cv-surveil-tgt" data-cls="${esc(cls)}" title="${esc(OBJ_LABEL[cls]||cls)}">${objIconSvg(cls,16)}</div>`).join('')}
        </div>
        ${sch.enabled?`<div class="cv-surveil-time">${esc(sch.from||'')} – ${esc(sch.to||'')}</div>`:''}
      `}
    </div>
    <!-- bottom-right: settings cog. Flat dark surface matches the
         mobile-dock chrome; tap → camera-edit form. -->
    <button class="cv-cog" type="button" onclick="event.stopPropagation();editCamera('${esc(c.id)}')" title="Einstellungen" aria-label="Einstellungen">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
    </button>
  </div>
</article>`;
  }).join('');
  byId('cameraCards').querySelectorAll('.cv-pill-live-wrap').forEach(el=>{
    const collapsed=el.querySelector('.cv-live-collapsed');
    requestAnimationFrame(()=>{
      const w=Math.ceil(collapsed.getBoundingClientRect().width);
      if(w>0) el.style.setProperty('--lp-collapsed-w', w+'px');
    });
    let _t=null;
    el.addEventListener('mouseenter',()=>{clearTimeout(_t);el.classList.add('cv-lp-open');});
    el.addEventListener('mouseleave',()=>{_t=setTimeout(()=>el.classList.remove('cv-lp-open'),120);});
    el.addEventListener('touchstart',e=>{e.stopPropagation();clearTimeout(_t);const open=el.classList.toggle('cv-lp-open');if(!open)clearTimeout(_t);},{passive:true});
    document.addEventListener('touchstart',e=>{if(!el.contains(e.target)){clearTimeout(_t);el.classList.remove('cv-lp-open');}},{passive:true});
  });
}

// Live-detection 3 s flash on the .cv-surveil-tgt of a class. CSS already
// supports the .is-detecting class (animation gated by prefers-reduced-
// motion). Per-(cam,cls) throttle so a sustained detection stream doesn't
// spam: minimum 2 s between flashes for the same target. Exposed on
// window so the backend pipeline (when it lands — currently detections
// live in container logs only, no SSE / WebSocket on the frontend) can
// trigger it via window._flashDetection(camId, cls).
const _flashThrottle = new Map();
window._flashDetection = function(camId, cls){
  if (!camId || !cls) return;
  const key = camId + '|' + cls;
  const now = Date.now();
  const last = _flashThrottle.get(key) || 0;
  if (now - last < 2000) return;
  _flashThrottle.set(key, now);
  const tile = document.querySelector(`.cv-card[data-camid="${CSS.escape(camId)}"]`);
  if (!tile) return;
  const tgt = tile.querySelector(`.cv-surveil-tgt[data-cls="${CSS.escape(cls)}"]`);
  if (!tgt) return;
  tgt.classList.remove('is-detecting');
  void tgt.offsetWidth;     // force reflow so animation restarts
  tgt.classList.add('is-detecting');
  setTimeout(() => tgt.classList.remove('is-detecting'), 3000);
};

// ── Timeline ─────────────────────────────────────────────────────────────────
const CAT_COLORS={alle:'#8888aa',motion:'#cbd5e1',person:'#facc15',cat:'#fb923c',bird:'#38bdf8',car:'#f87171',dog:'#7c2d12',squirrel:'#7c4a1f',timelapse:'#a855f7'};
// Lane order, top-down. Lanes auto-filter by content presence: any lane
// with zero events in the visible time range is omitted entirely.
const TL_LANES=['motion','person','cat','bird','car','dog','squirrel'];
const GAP_MS=2*60*1000;

function _tlGroupLane(points, label, tMin, tMax){
  const filtered=points
    .filter(p=>{
      const t=new Date(p.time).getTime();
      if(!t||t<tMin||t>tMax) return false;
      const labs=p.labels||[];
      if(label==='motion') return labs.length===0||labs.every(l=>l==='motion');
      return labs.includes(label);
    })
    .sort((a,b)=>new Date(a.time)-new Date(b.time));
  const groups=[];
  let curr=null;
  for(const p of filtered){
    const t=new Date(p.time).getTime();
    if(!curr||t-curr.endTime>GAP_MS){ curr={startTime:t,endTime:t,count:1}; groups.push(curr); }
    else { curr.endTime=t; curr.count++; }
  }
  return groups;
}

function _tlFmtTs(ts, hours){
  const d=new Date(ts);
  if(hours<=3) return d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0');
  if(hours<=24) return d.getHours().toString().padStart(2,'0')+':00';
  if(hours<=168) return ['So','Mo','Di','Mi','Do','Fr','Sa'][d.getDay()]+' '+d.getDate()+'.'+(d.getMonth()+1);
  return d.getDate()+'.'+(d.getMonth()+1)+'.';
}

function renderTimeline(){
  const container=byId('timelineContainer'); if(!container) return;
  const tracks=state.timeline?.tracks||[];

  // Find earliest event timestamp across all tracks (TASK 2)
  let earliestMs=null;
  tracks.forEach(tr=>{
    (tr.points||[]).forEach(p=>{
      const t=new Date(p.time).getTime();
      if(t&&(!earliestMs||t<earliestMs)) earliestMs=t;
    });
  });
  const now=Date.now();

  const slider=byId('tlRangeSlider');
  if(slider&&earliestMs&&!state._tlInitialized){
    const dataHours=Math.max(1,Math.ceil((now-earliestMs)/3600000));
    state.tlHours=dataHours;
    state._tlInitialized=true;
    slider.value=dataHours;
  }

  const hours=state.tlHours||12;
  const lbl=byId('tlRangeLabel');
  if(lbl) lbl.textContent=hours<24?`letzte ${hours}h`:`${Math.round(hours/24)} Tage`;

  const tMax=now;
  let tMin=now-hours*3600000;
  // Clamp tMin to earliest event — no point showing empty space before first data point
  if(earliestMs&&earliestMs>tMin) tMin=earliestMs;
  const span=tMax-tMin||1;

  // Compute which lanes have events per camera in the visible range. Only
  // those lanes are rendered. Cameras with no events at all are skipped.
  const camLaneGroups=tracks.map(tr=>{
    const lanes=TL_LANES
      .map(label=>({label,groups:_tlGroupLane(tr.points||[], label, tMin, tMax)}))
      .filter(l=>l.groups.length>0);
    return {tr,lanes};
  }).filter(c=>c.lanes.length>0);

  if(!camLaneGroups.length){container.innerHTML='<div class="tl-empty">Keine Ereignisse im gewählten Zeitraum.</div>';return;}

  let html='';
  camLaneGroups.forEach(({tr,lanes},ti)=>{
    const cam=(state.config?.cameras||[]).find(c=>c.id===tr.camera_id)||{};
    const camName=cam.name||tr.camera_id;
    const camIcon=getCameraIcon(camName);
    html+=`<div class="tl-cam-block${ti>0?' tl-cam-block--notfirst':''}">`;
    const sbCls=STAT_MEDIA_DRILLDOWN?'tl-cam-sidebox stat-drillable':'tl-cam-sidebox';
    const sbClick=STAT_MEDIA_DRILLDOWN?`onclick="_statOpenMedia('${esc(tr.camera_id)}','')"`:'' ;
    html+=`<div class="${sbCls}" ${sbClick}><div class="tl-cam-icon">${camIcon}</div><div class="tl-cam-name">${esc(camName)}</div></div>`;
    html+=`<div class="tl-lanes-wrap">`;
    for(let k=1;k<5;k++) html+=`<div class="tl-vgrid" style="left:calc(var(--tl-label-w) + (100% - var(--tl-label-w))*${k}/5)"></div>`;
    lanes.forEach(({label,groups})=>{
      const color=colors[label]||colors.unknown;
      const labelText=OBJ_LABEL[label]||label;
      html+=`<div class="tl-lane">`;
      html+=`<div class="tl-lane-label" style="--lane-c:${CAT_COLORS[label]||'#8888aa'}"><span class="tl-lane-label-icon">${OBJ_SVG[label]||''}</span><span class="tl-lane-label-text">${labelText}</span></div>`;
      html+=`<div class="tl-track">`;
      groups.forEach(g=>{
        const leftPct=Math.max(0,(g.startTime-tMin)/span*100);
        const widthPct=Math.max(0.8,Math.min((g.endTime-g.startTime)/span*100,100-leftPct));
        if(leftPct>=100) return;
        html+=`<div class="tl-bar" style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;background:${color};opacity:0.85" data-camid="${esc(tr.camera_id)}" data-label="${esc(label)}" title="${g.count} Events · ${labelText}"></div>`;
      });
      html+=`</div></div>`;
    });
    html+=`</div></div>`;
  });

  // X-axis — 6 evenly spaced labels, aligned to track start (after label column)
  html+=`<div class="tl-xaxis">`;
  for(let k=0;k<6;k++) html+=`<span class="tl-xlabel">${_tlFmtTs(tMin+span*k/5,hours)}</span>`;
  html+=`</div>`;
  container.innerHTML=html;

  // Bar click → navigate to Mediathek. On touch devices, the first tap
  // shows a small inline tooltip with the bar's title content (camera +
  // window + count); a second tap before the tooltip's 2.5 s dismiss
  // navigates. Desktop click navigates immediately as before.
  const _isCoarsePtr=()=>window.matchMedia('(hover:none) and (pointer:coarse)').matches;
  container.querySelectorAll('.tl-bar').forEach(bar=>{
    bar.onclick=(ev)=>{
      if(_isCoarsePtr() && !bar.classList.contains('tl-bar--tip-shown')){
        ev.preventDefault();
        _tlShowBarTooltip(bar);
        return;
      }
      state.mediaCamera=bar.dataset.camid;
      state.mediaLabels=bar.dataset.label?new Set([bar.dataset.label]):new Set();
      document.querySelector('#media').scrollIntoView({behavior:'smooth',block:'start'});
      loadMedia().then(()=>renderMediaGrid());
    };
  });
}

// Tap-tooltip for .tl-bar on touch devices. The bar carries its native
// title attribute — we read it, position a body-attached toast above the
// bar, mark the bar as tip-shown, and auto-dismiss after 2.5 s. Tapping
// elsewhere dismisses too.
let _tlTipEl=null,_tlTipTimer=0;
function _tlShowBarTooltip(bar){
  const text=bar.getAttribute('title')||'';
  if(!text) return;
  if(!_tlTipEl){
    _tlTipEl=document.createElement('div');
    _tlTipEl.className='tl-bar-tooltip';
    document.body.appendChild(_tlTipEl);
  }
  _tlTipEl.textContent=text;
  const r=bar.getBoundingClientRect();
  _tlTipEl.style.left=Math.max(8,Math.min(window.innerWidth-220,r.left+r.width/2-110))+'px';
  _tlTipEl.style.top=Math.max(8,r.top-44)+'px';
  _tlTipEl.classList.add('visible');
  bar.classList.add('tl-bar--tip-shown');
  clearTimeout(_tlTipTimer);
  _tlTipTimer=setTimeout(()=>_tlHideBarTooltip(),2500);
  // First outside tap dismisses; capture phase so it fires before the
  // bar's own click handler if user moves to a different bar.
  document.addEventListener('click',_tlOutsideTipHandler,{capture:true,once:true});
}
function _tlHideBarTooltip(){
  if(_tlTipEl) _tlTipEl.classList.remove('visible');
  document.querySelectorAll('.tl-bar--tip-shown').forEach(b=>b.classList.remove('tl-bar--tip-shown'));
}
function _tlOutsideTipHandler(e){
  // Don't dismiss when the tap landed on a bar — that bar's click
  // handler will run next and decide (show-tip OR navigate).
  if(e.target?.closest?.('.tl-bar')) return;
  _tlHideBarTooltip();
}

// ── RTSP path options (shared with discovery) ────────────────────────────────
const RTSP_PATH_OPTS=[
  {label:'Reolink H.264 – Main (RLC-810A, ältere FW)',   value:'/h264Preview_01_main'},
  {label:'Reolink H.265 – Main (CX810, neuere FW)',      value:'/h265Preview_01_main'},
  {label:'Reolink – Sub (immer H.264)',                   value:'/h264Preview_01_sub'},
  {label:'Hikvision – Main', value:'/Streaming/Channels/101'},
  {label:'Hikvision – Sub',  value:'/Streaming/Channels/102'},
  {label:'Dahua – Main',     value:'/cam/realmonitor?channel=1&subtype=0'},
  {label:'Dahua – Sub',      value:'/cam/realmonitor?channel=1&subtype=1'},
  {label:'Generic stream0',  value:'/stream0'},
  {label:'Generic stream1',  value:'/stream1'},
  {label:'Generic /live',    value:'/live'},
];

// Encode only URL-reserved chars that break parsing (?=query, @=host, #=fragment)
// ! is allowed unencoded in userinfo per RFC 3986
function _rtspEnc(s){ return (s||'').replace(/%/g,'%25').replace(/\?/g,'%3F').replace(/@/g,'%40').replace(/#/g,'%23'); }

// ── URL password masking ────────────────────────────────────────────────
// Replace only the password portion of a URL with dots. The real URL is
// stored in input.dataset.real; .value holds the masked text so the input
// visibly hides the secret. Before form submit we unmask (_unmaskUrlsForSubmit)
// so the saved value is the real URL. In masked state the input is also
// readonly — clicking the eye reveals AND makes the field editable.
function _maskUrlPassword(url){
  return (url||'').replace(/:([^@:/]+)@/,':••••••••@');
}
function _applyUrlMask(input){
  if(!input) return;
  const real=input.dataset.real!=null?input.dataset.real:input.value;
  input.dataset.real=real;
  input.value=_maskUrlPassword(real);
  // While masked: readonly so keystrokes can't corrupt the masked dots.
  // (rtsp_url is also readonly for other reasons — that's fine, stays so.)
  input.setAttribute('readonly','readonly');
  input.dataset.masked='1';
}
function _revealUrl(input){
  if(!input) return;
  if(input.dataset.real!=null) input.value=input.dataset.real;
  input.dataset.masked='0';
  // rtsp_url keeps its inherent readonly, only snapshot_url becomes editable
  if(input.name!=='rtsp_url') input.removeAttribute('readonly');
}
window._toggleUrlMask=function(btn){
  const wrap=btn.closest('.url-wrap'); const input=wrap?.querySelector('input[data-mask-url="1"]');
  if(!input) return;
  const nowRevealed=input.dataset.masked==='1';
  if(nowRevealed){_revealUrl(input); _setEyeState(btn,true);}
  else {
    // User just edited the revealed value — stash new real before re-masking
    input.dataset.real=input.value;
    _applyUrlMask(input); _setEyeState(btn,false);
  }
};
function _unmaskUrlsForSubmit(form){
  form.querySelectorAll('input[data-mask-url="1"]').forEach(inp=>{
    if(inp.dataset.masked==='1' && inp.dataset.real!=null){
      inp.value=inp.dataset.real;
    }
  });
}

// Maps the manufacturer field to the vendor's RTSP "Main" stream path.
// Used as the auto-default in the camera-edit form so the user never has
// to know vendor-specific path strings. Discovery results have their
// own _defaultRtspPath() (different — H.264 fallback, kept for legacy).
function _defaultRtspPathForManufacturer(mfg){
  const m = (mfg || '').toLowerCase().trim();
  if (m.startsWith('reolink')) return '/h265Preview_01_main';
  if (m.startsWith('hikvision')) return '/Streaming/Channels/101';
  if (m.startsWith('dahua') || m.startsWith('amcrest')) return '/cam/realmonitor?channel=1&subtype=0';
  return '/stream0';
}

window._toggleCamRtspErw = function(){
  const body = byId('rtspPathErwBody');
  const btn  = byId('camRtspErwBtn');
  if (!body || !btn) return;
  const wasOpen = !body.hidden;
  body.hidden = wasOpen;
  btn.setAttribute('aria-expanded', wasOpen ? 'false' : 'true');
};

// Drive the "manuell überschrieben" pill + auto-open the Erweitert
// disclosure when the path doesn't match the manufacturer default.
function _updateRtspErweitertVisuals(){
  const sel = byId('rtspPathSelect');
  if (!sel) return;
  const isManual = sel.dataset.manual === '1';
  const pill = byId('rtspPathCustomPill');
  if (pill) pill.hidden = !isManual;
  if (isManual) {
    const body = byId('rtspPathErwBody');
    const btn  = byId('camRtspErwBtn');
    if (body) body.hidden = false;
    if (btn)  btn.setAttribute('aria-expanded', 'true');
  }
}

function initRtspBuilder(){
  const sel=byId('rtspPathSelect');
  // Defensive: editCamera can fire from a setTimeout race after the
  // recovery / restart flow before the cam-edit form has been
  // re-rendered into the DOM. Without this guard, sel is null and
  // .options throws TypeError mid-init — leaving _currentEditCamId
  // stale and locking every future cam-edit click until F5.
  if(!sel) return;
  const form=byId('cameraForm');
  if(!form) return;
  if(!sel.options.length) RTSP_PATH_OPTS.forEach(p=>{const o=document.createElement('option');o.value=p.value;o.textContent=p.label;sel.appendChild(o);});
  const f=form.elements;
  const rebuild=()=>{
    const ip=(f['rtsp_ip']?.value||'').trim();
    const user=(f['rtsp_user']?.value||'').trim();
    const pass=(f['rtsp_pass']?.value||'').trim();
    const port=(f['rtsp_port']?.value||'554').trim();
    const path=f['rtsp_path']?.value||'';
    const setMaskable=(input,realVal)=>{
      if(!input) return;
      input.dataset.real=realVal;
      // Re-mask iff the eye is currently in masked mode; otherwise show real
      if(input.dataset.masked==='1') input.value=_maskUrlPassword(realVal);
      else input.value=realVal;
    };
    if(!ip){setMaskable(f['rtsp_url'],'');
      if (typeof _refreshConnectionWarn === 'function') _refreshConnectionWarn();
      return;}
    const auth=user?(user+(pass?':'+_rtspEnc(pass):'')+'@'):'';
    const portPart=port&&port!=='554'?':'+port:'';
    setMaskable(f['rtsp_url'],`rtsp://${auth}${ip}${portPart}${path}`);
    // auto-fill snapshot if empty
    const snapReal=f['snapshot_url']?.dataset.real||f['snapshot_url']?.value||'';
    if(!snapReal && user)
      setMaskable(f['snapshot_url'],`http://${user}:${_rtspEnc(pass)}@${ip}/cgi-bin/snapshot.cgi`);
    // Re-evaluate the connection-warn indicator + field highlights — the
    // user may have just typed credentials that close the gap, no save
    // needed for the indicator to flip back to grey.
    if (typeof _refreshConnectionWarn === 'function') _refreshConnectionWarn();
  };
  ['rtsp_ip','rtsp_user','rtsp_pass','rtsp_port'].forEach(n=>f[n]?.addEventListener('input',rebuild));
  sel.addEventListener('change',()=>{
    // Flag manual mode unless the user happened to pick the current
    // manufacturer's default (i.e. they reset themselves to auto).
    const def=_defaultRtspPathForManufacturer(f['manufacturer']?.value);
    sel.dataset.manual = (sel.value !== def) ? '1' : '0';
    _updateRtspErweitertVisuals();
    rebuild();
  });
  // Manufacturer typing propagates to the path picker unless the user
  // has explicitly overridden it via the dropdown.
  f['manufacturer']?.addEventListener('input',()=>{
    if (sel.dataset.manual === '1') return;
    const def=_defaultRtspPathForManufacturer(f['manufacturer'].value);
    if (sel.value !== def) {
      sel.value = def;
      rebuild();
    }
  });
}

function parseRtspUrl(url){
  try{
    const u=new URL(url.replace(/^rtsp:\/\//,'http://'));
    return{user:decodeURIComponent(u.username||''),pass:decodeURIComponent(u.password||''),host:u.hostname||'',port:u.port||'554',path:u.pathname+(u.search||'')||''};
  }catch{return{};}
}

window.toggleCameraEnabled=async function(camId,enabled){
  const cam=(state.cameras||[]).find(x=>x.id===camId);
  if(!cam) return;
  await fetch('/api/settings/cameras',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...cam,enabled})});
  await loadAll();
};
function renderCameraSettings(){
  // DIAG:cam-edit-lock — fires every time the cam list innerHTML is
  // blown. If the wrapper was a child of one of those rows at this
  // moment, it gets destroyed. The followup "wrapper.parent" log line
  // makes the parent visible so we know whether it survives.
  const _diagWrap = byId('cameraEditWrapper');
  const _diagWrapParentId = _diagWrap?.parentElement?.id || _diagWrap?.parentElement?.className || 'unknown';
  _erkDebugSet(`renderCameraSettings · wrapper.parent=${_diagWrapParentId} · _currentEditCamId=${_currentEditCamId}`);
  byId('cameraSettingsList').innerHTML=state.cameras.map(c=>{
    // Merge is offered only for cameras that have been offline for ≥ 10 min
    // straight (frame_age_s is the seconds-since-last-good-frame counter the
    // runtime maintains; null = camera never produced a frame and is also
    // not "abandoned" in the merge sense). Brief disconnects (network blip,
    // camera reboot) keep the button hidden; the moment a camera reconnects
    // and frame_age_s drops back under the threshold, the next render hides
    // the button automatically — no manual dismiss needed.
    const MERGE_OFFLINE_THRESHOLD_S = 600;
    const canMerge = typeof c.frame_age_s === 'number'
                  && c.frame_age_s >= MERGE_OFFLINE_THRESHOLD_S;
    return `
    <div class="cam-item" data-camid="${esc(c.id)}">
      <div class="cam-item-head" style="cursor:pointer" onclick="editCamera('${esc(c.id)}')">
        <div class="cam-item-head-left">
          <span class="cam-item-head-icon">${getCameraIcon(c.name)}</span>
          <span class="cam-item-head-name">${esc(c.name)}</span>
        </div>
        <div style="display:flex;gap:8px;align-items:center" onclick="event.stopPropagation()">
          <label class="switch" title="${c.enabled?'Aktiv · klicken zum Deaktivieren':'Inaktiv · klicken zum Aktivieren'}">
            <input type="checkbox" ${c.enabled?'checked':''} onchange="toggleCameraEnabled('${esc(c.id)}',this.checked)">
            <span class="slider"></span>
          </label>
          <button class="btn-reconnect" title="Neu verbinden" onclick="event.stopPropagation();_reconnectCam('${esc(c.id)}',this)">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2.5 8A5.5 5.5 0 0 1 13 5M13.5 8A5.5 5.5 0 0 1 3 11"/>
              <polyline points="12,2 12,5.5 8.5,5.5"/>
              <polyline points="4,14 4,10.5 7.5,10.5"/>
            </svg>
            Verbinden
          </button>
          ${canMerge?`<button class="btn-cam-merge" title="In aktive Kamera zusammenführen" data-merge-action="open" data-merge-id="${esc(c.id)}" data-merge-name="${esc(c.name)}">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 3v3a3 3 0 0 0 3 3h4a3 3 0 0 1 3 3v1"/><polyline points="11,11 13,13 11,15"/>
            </svg>
            Zusammenführen
          </button>`:''}
          <button class="btn-cam-delete" title="Kamera löschen" onclick="event.stopPropagation();_quickDeleteCamera('${esc(c.id)}','${esc(c.name)}')">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="2,4 14,4"/><path d="M5 4V2h6v2"/><path d="M3 4l1 10h8l1-10"/>
              <line x1="6.5" y1="7" x2="6.5" y2="11"/><line x1="9.5" y1="7" x2="9.5" y2="11"/>
            </svg>
          </button>
          <!-- Expand chevron — pure visual cue; the whole row is clickable. -->
          <svg class="cam-item-chevron" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5,3 11,8 5,13"/></svg>
        </div>
      </div>
    </div>`;}).join('');
}

// ── Camera merge modal ────────────────────────────────────────────────────────
let _mergeSource=null;
let _mergeTarget=null;
function openMergeModal(sourceId,sourceName){
  _mergeSource={id:sourceId,name:sourceName};
  _mergeTarget=null;
  // Active cameras only — merging into an offline replacement makes no sense.
  const targets=(state.cameras||[]).filter(c=>c.id!==sourceId && c.status==='active');
  byId('mergeIntro').innerHTML=`Medien von <strong>${esc(sourceName)}</strong> werden in die gewählte Ziel-Kamera verschoben. Der Eintrag <strong>${esc(sourceName)}</strong> wird danach gelöscht.`;
  const list=byId('mergeTargets');
  if(!targets.length){
    list.innerHTML='<div class="item muted" style="padding:12px">Keine aktive Ziel-Kamera verfügbar.</div>';
  } else {
    // Inline onclick="…('${esc(name)}')" breaks on names containing single
    // quotes (e.g. "Squirrel Town 'Nut Bar'"). Switched to data-attributes
    // + a delegated listener on #mergeTargets — safe for any character.
    list.innerHTML=targets.map(c=>`
      <div class="item merge-target-item" data-tgt-id="${esc(c.id)}" data-tgt-name="${esc(c.name)}" style="cursor:pointer;display:flex;align-items:center;gap:10px;padding:10px 12px">
        <span style="font-size:18px">${getCameraIcon(c.name)}</span>
        <div style="flex:1">
          <div style="font-weight:600">${esc(c.name)}</div>
          <div class="small muted">${esc(c.id)}</div>
        </div>
        <span class="merge-target-radio" style="width:16px;height:16px;border-radius:50%;border:2px solid var(--muted);flex-shrink:0"></span>
      </div>`).join('');
  }
  byId('mergeWarning').style.display='none';
  const btn=byId('mergeConfirmBtn');
  btn.disabled=true; btn.style.opacity='.5'; btn.textContent='Zusammenführen';
  byId('mergeModal').classList.remove('hidden');
  document.body.style.overflow='hidden';
}
window.openMergeModal=openMergeModal;
function _selectMergeTarget(id,name){
  _mergeTarget={id,name};
  document.querySelectorAll('.merge-target-item').forEach(el=>{
    const sel=el.dataset.tgtId===id;
    el.classList.toggle('selected',sel);
    const dot=el.querySelector('.merge-target-radio');
    if(dot){
      dot.style.borderColor=sel?'var(--accent)':'var(--muted)';
      dot.style.background=sel?'var(--accent)':'transparent';
    }
    el.style.background=sel?'rgba(59,130,246,.08)':'';
  });
  const w=byId('mergeWarning');
  w.style.display='block';
  w.innerHTML=`Die Aktion verschiebt alle Medien von <strong>${esc(_mergeSource.name)}</strong> nach <strong>${esc(name)}</strong> und entfernt anschließend den Eintrag <strong>${esc(_mergeSource.name)}</strong> aus der Konfiguration. Sie kann nicht rückgängig gemacht werden.`;
  const btn=byId('mergeConfirmBtn');
  btn.disabled=false; btn.style.opacity='1';
}
window._selectMergeTarget=_selectMergeTarget;
function closeMergeModal(){
  byId('mergeModal').classList.add('hidden');
  document.body.style.overflow='';
  _mergeSource=null; _mergeTarget=null;
}
byId('closeMergeBtn')?.addEventListener('click',closeMergeModal);
byId('mergeCancelBtn')?.addEventListener('click',closeMergeModal);
byId('mergeModal')?.addEventListener('click',e=>{ if(e.target===byId('mergeModal')) closeMergeModal(); });
// Delegated listeners replace inline onclick="…('${esc(name)}')" — those
// strings break on quotes / backslashes / ampersands in camera names.
// Buttons declare data-merge-id / data-merge-name; the listener resolves
// values from dataset at click time, which is byte-safe for any character.
document.addEventListener('click',(ev)=>{
  const trigger=ev.target.closest('[data-merge-action="open"]');
  if(!trigger) return;
  ev.stopPropagation();
  const id=trigger.dataset.mergeId;
  if(!id) return;
  openMergeModal(id, trigger.dataset.mergeName || id);
});
byId('mergeTargets')?.addEventListener('click',(ev)=>{
  const item=ev.target.closest('.merge-target-item');
  if(!item) return;
  const id=item.dataset.tgtId;
  if(!id) return;
  _selectMergeTarget(id, item.dataset.tgtName || id);
});
byId('mergeConfirmBtn')?.addEventListener('click',async()=>{
  if(!_mergeSource||!_mergeTarget) return;
  const btn=byId('mergeConfirmBtn');
  // Two-step confirm: first click arms the button, second click fires the call.
  if(btn.dataset.armed!=='1'){
    btn.dataset.armed='1';
    btn.textContent='Wirklich zusammenführen?';
    btn.style.background='#ef4444';
    return;
  }
  btn.disabled=true; btn.textContent='Wird verschoben …';
  try{
    const r=await j(`/api/cameras/${encodeURIComponent(_mergeSource.id)}/merge-into/${encodeURIComponent(_mergeTarget.id)}`,{method:'POST'});
    const tgtName=_mergeTarget.name;
    closeMergeModal();
    showToast(`${r.moved_files||0} Datei(en) nach „${tgtName}“ verschoben (${r.moved_events||0} Events, ${r.moved_timelapses||0} Timelapse).`,'success');
    await loadAll();
  }catch(e){
    btn.disabled=false; btn.dataset.armed='0';
    btn.textContent='Zusammenführen'; btn.style.background='';
    showToast('Zusammenführen fehlgeschlagen: '+(e.message||e),'error');
  }
});
window._reconnectCam=function(camId,btn){
  _erkDebugSet(`_reconnectCam(${camId}) clicked`);  // DIAG:cam-edit-lock
  btn.classList.add('spinning');
  setTimeout(()=>btn.classList.remove('spinning'),520);
  reloadCamera(camId);
};
window._quickDeleteCamera=async function(camId,camName){
  if(!await showConfirm(`Kamera "${camName}" wirklich löschen?\n\nDie Kamera wird aus der Konfiguration entfernt. Medien bleiben im Speicher erhalten und erscheinen unter "Archivierte Kameras".`)) return;
  try{
    const r=await j(`/api/settings/cameras/${encodeURIComponent(camId)}`,{method:'DELETE'});
    if(r.event_count>0) showToast(`${r.event_count} gespeicherte Ereignisse bleiben im Archiv erhalten.`,'warn');
    if(_currentEditCamId===camId) _restoreEditWrapper();
    await loadAll();
  }catch(e){showToast('Fehler beim Löschen: '+esc(e.message||e),'error');}
};

// ── Whitelist chips ───────────────────────────────────────────────────────────
let _whitelistState=[];
function _renderWhitelistChips(profiles,selected){
  _whitelistState=[...(selected||[])];
  const el=byId('whitelistChipsContainer'); if(!el) return;
  if(!profiles.length){el.innerHTML='<span class="small muted">Keine Profile vorhanden</span>'; _updateWhitelistHidden(); return;}
  el.innerHTML=profiles.map(p=>`<span class="wl-chip ${_whitelistState.includes(p.name)?'selected':''}" onclick="toggleWlChip('${esc(p.name)}')">${esc(p.name)}</span>`).join('');
  _updateWhitelistHidden();
}
window.toggleWlChip=function(name){
  const idx=_whitelistState.indexOf(name);
  if(idx>=0) _whitelistState.splice(idx,1); else _whitelistState.push(name);
  document.querySelectorAll('.wl-chip').forEach(c=>c.classList.toggle('selected',_whitelistState.includes(c.textContent)));
  _updateWhitelistHidden();
};
function _updateWhitelistHidden(){
  const f=byId('cameraForm')?.elements;
  if(f&&f['whitelist_names']) f['whitelist_names'].value=_whitelistState.join(',');
}

// ── Camera form one-time listeners ───────────────────────────────────────────
let _camFormInited=false;
function _initCameraFormListeners(){
  if(_camFormInited) return; _camFormInited=true;
  const f=byId('cameraForm').elements;
  // Auto-generate ID from name (only for new cameras)
  f['name']?.addEventListener('input',()=>{
    if(f['id'].dataset.autoGen==='1')
      f['id'].value='cam-'+f['name'].value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
  });
  // Motion sensitivity slider
  f['motion_sensitivity']?.addEventListener('input',()=>{
    const v=parseFloat(f['motion_sensitivity'].value||0);
    const lbl=byId('motionSensLabel'); if(lbl) lbl.textContent=Math.round(v*100)+'%';
  });
  // Slider value labels (Erkennung tab — see _initErkSliders). The old
  // motionSensLabel / detectionMinScoreLabel / labelThresholdPersonLabel /
  // frameIntervalLabel / wildlifeMotionLabel / snapshotIntervalLabel
  // wiring lived here; the new 5-step workflow uses _initErkSliders for
  // the consolidated wiring with new IDs (erkMinScoreVal etc.).
  _initErkSliders(byId('cameraForm'));
}

// Erkennung-tab slider value labels. Single delegated handler over a
// (name, valueId, formatter) map so adding a new slider in Phase 2 is
// one extra row — not a new addEventListener block. The label lookup
// is null-guarded per row so a template that omits a label element
// doesn't abort the whole init. Compound labels (frame-interval → fps,
// confirm_n + confirm_seconds → "N Treffer in S Sekunden") run after
// the per-slider loop so they pick up the latest input value.
function _initErkSliders(form){
  if (!form) return;
  const map = [
    ['detection_min_score',    'erkMinScoreVal',      v => Math.round(v * 100) + '%'],
    ['label_threshold_person', 'erkPersonVal',        v => Math.round(v * 100) + '%'],
    ['motion_sensitivity',     'erkMotionVal',        v => Math.round(v * 100) + '%'],
    ['frame_interval_ms',      'erkFrameIntervalVal', v => v + ' ms'],
    ['confirm_n',              'erkConfirmN',         v => v + ' ×'],
    ['confirm_seconds',        'erkConfirmS',         v => v + ' s'],
  ];
  for (const [name, valId, fmt] of map){
    const inp = form.querySelector(`[name="${name}"]`);
    const lbl = document.getElementById(valId);
    if (!inp || !lbl) continue;
    const upd = () => { lbl.textContent = fmt(parseFloat(inp.value)); };
    inp.addEventListener('input', upd);
    upd();
  }
  // Compound: confirmation filter — "N Treffer in S Sekunden bestätigen".
  const cn = form.querySelector('[name="confirm_n"]');
  const cs = form.querySelector('[name="confirm_seconds"]');
  const cl = document.getElementById('erkConfirmLbl');
  if (cn && cs && cl){
    const upd = () => { cl.textContent = `${cn.value} Treffer in ${cs.value} Sekunden bestätigen`; };
    cn.addEventListener('input', upd);
    cs.addEventListener('input', upd);
    upd();
  }
  // Compound: frame_interval_ms → fps line. 1000 / interval rounded to
  // nearest integer; the slider's 100 ms low end is 10 fps, the 2000 ms
  // high end is 0.5 fps (rounds to 1).
  const fi = form.querySelector('[name="frame_interval_ms"]');
  const fl = document.getElementById('erkFrameIntervalLbl');
  if (fi && fl){
    const upd = () => {
      const fps = Math.max(1, Math.round(1000 / parseFloat(fi.value)));
      fl.textContent = `≈ ${fps} fps · niedriger = mehr Coral-Last`;
    };
    fi.addEventListener('input', upd);
    upd();
  }
}

// Per-class confidence drilldown rendered into #erkPerClassAdvanced when
// the user opens "Pro Klasse anpassen" under step 2. Defaults mirror the
// settings_store fallbacks (cat 0.55 / bird 0.45 / squirrel 0.45 / car
// 0.65 / dog 0.55) so a fresh camera with no per-class entries doesn't
// look misconfigured. Sliders are name="label_threshold_<key>" so the
// save handler's _collectLabelThresholds() picks them up automatically.
const _ERK_PERCLASS_CONFIDENCE = [
  { key: 'cat',      label: 'Katze',        defaultV: 0.55 },
  { key: 'bird',     label: 'Vogel',        defaultV: 0.45 },
  { key: 'squirrel', label: 'Eichhörnchen', defaultV: 0.45 },
  { key: 'car',      label: 'Auto',         defaultV: 0.65 },
  { key: 'dog',      label: 'Hund',         defaultV: 0.55 },
];
function _renderErkPerClassConfidence(form, cam){
  const wrap = byId('erkPerClassAdvanced'); if (!wrap) return;
  const thresholds = cam?.label_thresholds || {};
  wrap.innerHTML = _ERK_PERCLASS_CONFIDENCE.map(c => {
    const raw = thresholds[c.key];
    const v = (raw != null && Number.isFinite(parseFloat(raw))) ? parseFloat(raw) : c.defaultV;
    return `
      <div class="erk-card">
        <div class="row">
          <input type="range" name="label_threshold_${c.key}" min="0.50" max="0.95" step="0.01" value="${v.toFixed(2)}" />
          <span class="val" id="erkLT_${c.key}_val">${Math.round(v * 100)}%</span>
        </div>
        <span class="lbl">${esc(c.label)} · überschreibt allgemein</span>
      </div>`;
  }).join('');
  // Live-update value labels.
  _ERK_PERCLASS_CONFIDENCE.forEach(c => {
    const inp = wrap.querySelector(`[name="label_threshold_${c.key}"]`);
    const lbl = byId(`erkLT_${c.key}_val`);
    if (inp && lbl){
      inp.addEventListener('input', () => {
        lbl.textContent = Math.round(parseFloat(inp.value) * 100) + '%';
      });
    }
  });
}

// One-time wiring for the "Pro Klasse anpassen ▾" disclosure toggle in
// step 2. Flips #erkPerClassAdvanced visibility, swaps the label text,
// and updates aria-expanded — no animation per CLAUDE.md / reduced-
// motion default. Idempotent via dataset.wired so re-opening cam-edit
// doesn't double-bind.
function _bindErkPerClassToggle(){
  const btn = byId('erkPerClassToggle');
  const wrap = byId('erkPerClassAdvanced');
  const lbl = byId('erkPerClassToggleLbl');
  if (!btn || !wrap || !lbl || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => {
    const open = wrap.hidden;
    wrap.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    lbl.textContent = open ? 'Weniger anzeigen' : 'Pro Klasse anpassen';
  });
}

// Read every label_threshold_<class> slider from the form into the
// dict shape settings.json expects. Includes the step-2 person
// slider AND any per-class drilldown sliders rendered into
// #erkPerClassAdvanced. Drops NaN values silently — no slider, no
// entry, schema falls back to the global detection_min_score.
function _collectLabelThresholds(form){
  const out = {};
  form.querySelectorAll('[name^="label_threshold_"]').forEach(inp => {
    const key = inp.name.replace('label_threshold_', '');
    const v = parseFloat(inp.value);
    if (key && Number.isFinite(v)) out[key] = v;
  });
  return out;
}

// Per-class confirmation-window drilldown rendered into
// #erkConfirmPerClass when "Pro Klasse anpassen" under step 3 is
// opened. Each class gets a two-col card matching the global slider's
// shape: confirm_<key>_n + confirm_<key>_s sliders side by side, with
// a compound "<class> · N in S s" label below. Defaults track the
// settings_store fallbacks (per-class N-of-M defaults vary by how
// noisy each class typically is — birds 2/4 because flap-flap-flap
// is fast, persons 3/5 because slow movement triggers more
// confidently).
const _ERK_PERCLASS_CONFIRM = [
  { key: 'person',   label: 'Person',       defN: 3, defS: 5 },
  { key: 'cat',      label: 'Katze',        defN: 3, defS: 5 },
  { key: 'bird',     label: 'Vogel',        defN: 2, defS: 4 },
  { key: 'squirrel', label: 'Eichhörnchen', defN: 2, defS: 3 },
];
function _renderErkPerClassConfirm(form, cam){
  const wrap = byId('erkConfirmPerClass'); if (!wrap) return;
  const cw = cam?.confirmation_window || {};
  wrap.innerHTML = _ERK_PERCLASS_CONFIRM.map(c => {
    const cur = cw[c.key] || {};
    const n = parseInt(cur.n, 10);
    const s = parseFloat(cur.seconds);
    const nVal = Number.isFinite(n) ? n : c.defN;
    const sVal = Number.isFinite(s) ? Math.round(s) : c.defS;
    return `
      <div class="erk-card">
        <div class="two-col">
          <div class="row">
            <input type="range" name="confirm_${c.key}_n" min="1" max="10" step="1" value="${nVal}" />
            <span class="val" id="erkCWN_${c.key}">${nVal} ×</span>
          </div>
          <div class="row">
            <input type="range" name="confirm_${c.key}_s" min="2" max="20" step="1" value="${sVal}" />
            <span class="val" id="erkCWS_${c.key}">${sVal} s</span>
          </div>
        </div>
        <span class="lbl" id="erkCWL_${c.key}">${esc(c.label)} · ${nVal} in ${sVal} s</span>
      </div>`;
  }).join('');
  // Live-update value labels and the compound row label.
  _ERK_PERCLASS_CONFIRM.forEach(c => {
    const nInp = wrap.querySelector(`[name="confirm_${c.key}_n"]`);
    const sInp = wrap.querySelector(`[name="confirm_${c.key}_s"]`);
    const nLbl = byId(`erkCWN_${c.key}`);
    const sLbl = byId(`erkCWS_${c.key}`);
    const cLbl = byId(`erkCWL_${c.key}`);
    if (!nInp || !sInp) return;
    const upd = () => {
      if (nLbl) nLbl.textContent = nInp.value + ' ×';
      if (sLbl) sLbl.textContent = sInp.value + ' s';
      if (cLbl) cLbl.textContent = `${c.label} · ${nInp.value} in ${sInp.value} s`;
    };
    nInp.addEventListener('input', upd);
    sInp.addEventListener('input', upd);
  });
}

// One-time wiring for the step-3 "Pro Klasse anpassen ▾" toggle.
// Same pattern as _bindErkPerClassToggle (step 2) — separate so each
// disclosure can swap independent state without coupling.
function _bindErkConfirmPerClassToggle(){
  const btn = byId('erkConfirmPerClassToggle');
  const wrap = byId('erkConfirmPerClass');
  const lbl = byId('erkConfirmPerClassToggleLbl');
  if (!btn || !wrap || !lbl || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => {
    const open = wrap.hidden;
    wrap.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    lbl.textContent = open ? 'Weniger anzeigen' : 'Pro Klasse anpassen';
  });
}

// Read every confirm_<class>_n + confirm_<class>_s slider pair from
// the form into the dict shape settings.json expects:
//   { global: {n,seconds}, person: {n,seconds}, cat: {n,seconds}, … }
// The "global" entry comes from the step-3 main slider (name=confirm_n
// + confirm_seconds, no class suffix). Per-class entries are written
// only when both n and s are present and finite. Existing entries that
// have no UI slider in scope are merged from existingCam — Phase 1's
// preservation pattern is unchanged here.
function _collectConfirmationWindow(form, existingCam){
  const out = { ...(existingCam?.confirmation_window || {}) };
  // Legacy hidden grid (compat — see #camConfirmGrid).
  const grid = byId('camConfirmGrid');
  grid?.querySelectorAll('[data-cw-cls]').forEach(row => {
    const cls = row.dataset.cwCls;
    const nIn = row.querySelector('[data-cw-n]');
    const sIn = row.querySelector('[data-cw-s]');
    const n = parseInt(nIn?.value, 10);
    const s = parseFloat(sIn?.value);
    if (cls && Number.isFinite(n) && Number.isFinite(s)){
      out[cls] = { n: Math.max(1, n), seconds: Math.max(0.5, s) };
    }
  });
  // Step-3 global slider.
  const gn = parseInt(form.querySelector('[name="confirm_n"]')?.value, 10);
  const gs = parseFloat(form.querySelector('[name="confirm_seconds"]')?.value);
  if (Number.isFinite(gn) && Number.isFinite(gs)){
    out.global = { n: Math.max(1, gn), seconds: Math.max(2, gs) };
  }
  // Per-class drilldown sliders — confirm_<key>_n / confirm_<key>_s.
  // Only emit an entry when both inputs exist and parse as finite.
  form.querySelectorAll('[name^="confirm_"][name$="_n"]').forEach(nInp => {
    const m = nInp.name.match(/^confirm_(.+)_n$/);
    if (!m) return;
    const key = m[1];
    if (!key || key === 'seconds' || key === 'global') return;
    const sInp = form.querySelector(`[name="confirm_${key}_s"]`);
    const n = parseInt(nInp.value, 10);
    const s = parseFloat(sInp?.value);
    if (Number.isFinite(n) && Number.isFinite(s)){
      out[key] = { n: Math.max(1, n), seconds: Math.max(2, s) };
    }
  });
  return out;
}

// ── Alerting tab — class-severity matrix ─────────────────────────────────
// Per-class severity matrix replaces the legacy 4-valued alarm_profile
// select. Each known class maps to one of "off" / "info" / "alarm";
// the runtime computes the event's effective severity by reading the
// detected labels and picking the highest-rank entry from this dict.
// 7 classes × 3 choices fits comfortably in a 4-column grid.
const _ALERT_SEV_CLASSES = [
  { key: 'person',   label: 'Person',       em: '👤' },
  { key: 'cat',      label: 'Katze',        em: '🐈' },
  { key: 'bird',     label: 'Vogel',        em: '🐦' },
  { key: 'squirrel', label: 'Eichhörnchen', em: '🐿' },
  { key: 'car',      label: 'Auto',         em: '🚗' },
  { key: 'dog',      label: 'Hund',         em: '🐕' },
  { key: 'motion',   label: 'Bewegung',     em: '〰️' },
];
function _renderSeverityMatrix(form, cam){
  const wrap = byId('alertSeverityMatrix'); if (!wrap) return;
  const cs = cam?.class_severity || {};
  // Header row (Klasse | Aus | Info | Alarm).
  let html = `
    <div class="sev-cell sev-header">Klasse</div>
    <div class="sev-cell sev-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
      Aus
    </div>
    <div class="sev-cell sev-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/></svg>
      Info
    </div>
    <div class="sev-cell sev-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M2 5l4-3M22 5l-4-3"/></svg>
      Alarm
    </div>
  `;
  for (const c of _ALERT_SEV_CLASSES){
    const cur = cs[c.key] || 'off';
    const cell = (val, mode) => {
      const on = cur === val;
      const cls = `sev-cell sev-radio${on ? ' is-on is-' + mode + '-mode' : ''}`;
      return `<div class="${cls}" data-cls="${c.key}" data-val="${val}" role="radio" aria-checked="${on}" tabindex="0">${on ? '●' : '○'}</div>`;
    };
    html += `
      <div class="sev-cell sev-row-label"><span class="em">${c.em}</span>${esc(c.label)}</div>
      ${cell('off',   'off')}
      ${cell('info',  'info')}
      ${cell('alarm', 'alarm')}
    `;
  }
  wrap.innerHTML = html;
  // Single delegated click handler per render (innerHTML wipes prior
  // listeners). Touch + mouse + pen all share the same path.
  wrap.addEventListener('click', (e) => {
    const cell = e.target.closest('.sev-radio');
    if (!cell) return;
    const cls = cell.dataset.cls;
    const val = cell.dataset.val;
    wrap.querySelectorAll(`.sev-radio[data-cls="${cls}"]`).forEach(r => {
      r.classList.remove('is-on','is-off-mode','is-info-mode','is-alarm-mode');
      r.setAttribute('aria-checked','false');
      r.textContent = '○';
    });
    cell.classList.add('is-on','is-' + val + '-mode');
    cell.setAttribute('aria-checked','true');
    cell.textContent = '●';
    // Conflict-banner check is wired in the follow-up commit; no-op
    // until then.
    if (typeof _checkAlertingConflicts === 'function'){
      _checkAlertingConflicts(form);
    }
  });
}

// Read the matrix back into the dict shape settings.json expects.
// Drops unset rows silently (every row has exactly one is-on cell after
// render so the .is-on selector is the source of truth).
function _collectClassSeverity(form){
  const wrap = byId('alertSeverityMatrix');
  const out = {};
  if (!wrap) return out;
  wrap.querySelectorAll('.sev-radio.is-on').forEach(r => {
    out[r.dataset.cls] = r.dataset.val;
  });
  return out;
}

// Conflict-warning banner — flags Alerting-tab settings that wouldn't
// reach the user. Two checks:
//   1. Any class is set to alarm/info but BOTH channels (Telegram +
//      MQTT) are off → push has nowhere to go.
//   2. Any class is set to alarm/info but the master "Alerting aktiv"
//      switch (armed) is off → push is globally muted.
// Banner is purely informational — never blocks save. JS toggles the
// hidden attribute and rewrites the message on every relevant change.
function _checkAlertingConflicts(form){
  const banner = byId('alertConflictBanner');
  const text   = byId('alertConflictText');
  if (!banner || !text) return;
  const cs = _collectClassSeverity(form);
  const anyAlarming = Object.values(cs).some(v => v === 'alarm' || v === 'info');
  const tg = !!form.querySelector('[name="telegram_enabled"]')?.checked;
  const mq = !!form.querySelector('[name="mqtt_enabled"]')?.checked;
  const armed = !!form.querySelector('[name="armed"]')?.checked;
  const messages = [];
  if (anyAlarming && !tg && !mq){
    messages.push("Klassen sind auf <strong>Alarm</strong> oder <strong>Info</strong> gesetzt, aber <strong>kein Kanal aktiv</strong> — es kommt nichts an. Aktiviere Telegram oder MQTT in Schritt 2.");
  }
  if (anyAlarming && !armed){
    messages.push("Der globale <strong>Stumm-Schalter</strong> in Schritt 5 ist aus — alle Pushes werden blockiert.");
  }
  if (messages.length){
    text.innerHTML = messages.join(' · ');
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

// Per-class notification-cooldown drilldown rendered into
// #alertCooldownGrid when "Cooldown pro Klasse anpassen ▾" is opened.
// Each class gets a 0-600 s slider (15 s steps); the value label
// switches from "X s" to "X min" past 60 s for compactness.
// Defaults match _NOTIFY_COOLDOWN_DEFAULTS in telegram_bot so the
// surfaced values reflect the actual runtime fallback.
const _ALERT_COOLDOWN_CLASSES = [
  { key: 'person',   label: 'Person',       def: 60  },
  { key: 'cat',      label: 'Katze',        def: 120 },
  { key: 'bird',     label: 'Vogel',        def: 300 },
  { key: 'squirrel', label: 'Eichhörnchen', def: 300 },
  { key: 'dog',      label: 'Hund',         def: 120 },
  { key: 'car',      label: 'Auto',         def: 30  },
  { key: 'motion',   label: 'Bewegung',     def: 30  },
];
function _fmtCooldownVal(s){
  const v = parseInt(s, 10);
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return 'aus';
  if (v < 60)  return v + ' s';
  return Math.round(v / 60) + ' min';
}
function _renderAlertCooldownGrid(form, cam){
  const wrap = byId('alertCooldownGrid'); if (!wrap) return;
  const cd = cam?.notification_cooldown || {};
  wrap.innerHTML = _ALERT_COOLDOWN_CLASSES.map(c => {
    const raw = cd[c.key];
    const v = (raw != null && Number.isFinite(parseInt(raw, 10))) ? parseInt(raw, 10) : c.def;
    return `
      <div class="erk-card">
        <div class="row">
          <input type="range" name="cooldown_${c.key}" min="0" max="600" step="15" value="${v}" />
          <span class="val" id="erkCD_${c.key}_val">${esc(_fmtCooldownVal(v))}</span>
        </div>
        <span class="lbl">${esc(c.label)} · min. Abstand zwischen zwei Pushes</span>
      </div>`;
  }).join('');
  _ALERT_COOLDOWN_CLASSES.forEach(c => {
    const inp = wrap.querySelector(`[name="cooldown_${c.key}"]`);
    const lbl = byId(`erkCD_${c.key}_val`);
    if (inp && lbl){
      inp.addEventListener('input', () => { lbl.textContent = _fmtCooldownVal(inp.value); });
    }
  });
}

// One-time wiring for the cooldown disclosure toggle.
function _bindAlertCooldownToggle(){
  const btn = byId('alertCooldownToggle');
  const wrap = byId('alertCooldownGrid');
  const lbl = byId('alertCooldownToggleLbl');
  if (!btn || !wrap || !lbl || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => {
    const open = wrap.hidden;
    wrap.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    lbl.textContent = open ? 'Weniger anzeigen' : 'Cooldown pro Klasse anpassen';
  });
}

// Read every cooldown_<class> slider from the form into the dict
// shape settings.json expects. Empty grid (drilldown never opened)
// yields {}, which the runtime treats as "use _NOTIFY_COOLDOWN_DEFAULTS"
// — same effective behaviour as before this commit.
function _collectAlertCooldown(form){
  const out = {};
  form.querySelectorAll('[name^="cooldown_"]').forEach(inp => {
    const key = inp.name.replace('cooldown_', '');
    const v = parseInt(inp.value, 10);
    if (key && Number.isFinite(v)) out[key] = v;
  });
  return out;
}

// Test-Push button on the Alerting tab — fires
// /api/cameras/<id>/test-alert, animates the play-icon while in
// flight, then renders a per-channel result panel below: ✓ Telegram
// angekommen / ✗ MQTT: Kanal aus. Idempotent wiring via
// dataset.wired so re-opening cam-edit doesn't double-bind.
function _bindAlertTestButton(){
  const btn = byId('alertTestBtn'); if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', _onAlertTestClick);
}
const _ALERT_CHAN_LABELS = { telegram: 'Telegram', mqtt: 'MQTT' };
async function _onAlertTestClick(ev){
  const btn = ev.currentTarget;
  const camId = byId('cameraForm')?.elements?.['id']?.value;
  const result = byId('alertTestResult');
  if (!camId || !result) return;
  const lblEl = btn.querySelector('.alert-test-btn-lbl');
  const original = lblEl?.textContent || '';
  btn.disabled = true;
  btn.classList.add('is-busy');
  if (lblEl) lblEl.textContent = ' sende…';
  result.hidden = true;
  let data = null;
  try{
    const r = await fetch(`/api/cameras/${encodeURIComponent(camId)}/test-alert`, { method: 'POST' });
    try { data = await r.json(); } catch(_){}
  }catch(_){
    data = null;
  }
  btn.disabled = false;
  btn.classList.remove('is-busy');
  if (lblEl) lblEl.textContent = original;
  if (!data){
    result.className = 'alert-test-result is-err';
    result.innerHTML = `<strong>Fehler:</strong> Netzwerk · keine Antwort vom Server`;
    result.hidden = false;
    return;
  }
  const lines = [];
  for (const [chan, res] of Object.entries(data.channels || {})){
    const label = _ALERT_CHAN_LABELS[chan] || chan;
    if (res?.ok)  lines.push(`✓ ${label} angekommen`);
    else          lines.push(`✗ ${label}: ${res?.error || 'Fehler'}`);
  }
  result.className = 'alert-test-result ' + (data.ok ? 'is-ok' : 'is-err');
  const head = data.ok ? 'Erfolg' : 'Fehler';
  result.innerHTML = `<strong>${head}</strong><ul>${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`;
  result.hidden = false;
}

// Hydrate the Alerting-tab status strip from /api/system/telegram.
// Mutates the existing static markup rather than re-rendering so the
// dot's CSS animation isn't restarted on every poll. Three pieces:
//   - Dot variant: is-ok (green) when bot is enabled+connected, is-cpu
//     (orange-pulse) when enabled but disconnected, is-off (grey) when
//     disabled entirely.
//   - alertStatusBot: "verbunden" / "getrennt" / "deaktiviert".
//   - alertStatusLast: relative "vor X Min." since last push (uses the
//     existing _fmtRelativeAgeS helper from the Erkennung-tab strip).
// Errors during fetch leave the strip showing whatever it had — a
// transient flake shouldn't blank the UI.
async function _renderAlertStatusStrip(){
  const host = byId('alertStatusStrip'); if (!host) return;
  let data = null;
  try {
    const r = await fetch('/api/system/telegram');
    if (r.ok) data = await r.json();
  } catch(_){}
  const dot = byId('alertStatusDot');
  const txt = byId('alertStatusBot');
  const last = byId('alertStatusLast');
  if (!data){
    if (dot){ dot.classList.remove('is-ok','is-cpu','is-off'); dot.classList.add('is-off'); }
    if (txt) txt.textContent = '—';
    if (last) last.textContent = '—';
    return;
  }
  let variant, label;
  if (!data.enabled){
    variant = 'is-off'; label = 'deaktiviert';
  } else if (data.connected){
    variant = 'is-ok'; label = 'verbunden';
  } else {
    variant = 'is-cpu'; label = 'getrennt';
  }
  if (dot){
    dot.classList.remove('is-ok','is-cpu','is-off');
    dot.classList.add(variant);
  }
  if (txt) txt.textContent = label;
  if (last) last.textContent = _fmtRelativeAgeS(data.last_send_age_s);
}

// Wire the conflict banner to react to channel/master switches in the
// Alerting tab. Idempotent via dataset.wired so re-opening cam-edit
// doesn't double-bind. The matrix click handler in
// _renderSeverityMatrix already calls _checkAlertingConflicts on every
// cell click.
function _bindAlertingConflictWatch(form){
  if (!form || form.dataset.alertingConflictWired) return;
  form.dataset.alertingConflictWired = '1';
  ['telegram_enabled', 'mqtt_enabled', 'armed', 'recording_enabled'].forEach(name => {
    const inp = form.querySelector(`[name="${name}"]`);
    if (inp) inp.addEventListener('change', () => _checkAlertingConflicts(form));
  });
}

// "Erkennung jetzt simulieren" — the button below the 5 steps in the
// Erkennung tab. Posts to /api/cameras/<id>/test-detection, animates
// the icon while the request is in flight, then renders the snapshot
// + bounding boxes inline. Click again to re-run; click × to dismiss.
function _bindErkSimulate(){
  const btn = byId('erkSimulateBtn');
  const close = byId('erkSimClose');
  if (btn && !btn.dataset.wired){
    btn.dataset.wired = '1';
    btn.addEventListener('click', _onErkSimulateClick);
  }
  if (close && !close.dataset.wired){
    close.dataset.wired = '1';
    close.addEventListener('click', () => {
      const wrap = byId('erkSimResult');
      if (wrap) wrap.hidden = true;
    });
  }
}
async function _onErkSimulateClick(ev){
  const btn = ev.currentTarget;
  const camId = byId('cameraForm')?.elements?.['id']?.value;
  if (!camId) return;
  const lblEl = btn.querySelector('.erk-test-btn-lbl');
  const originalLabel = lblEl?.textContent || '';
  btn.disabled = true;
  btn.classList.add('is-busy');
  if (lblEl) lblEl.textContent = ' simuliere…';
  try{
    const r = await fetch(`/api/cameras/${encodeURIComponent(camId)}/test-detection`, { method: 'POST' });
    let data = null;
    try { data = await r.json(); } catch(_){}
    if (!r.ok || !data?.ok){
      const msg = (data && data.error) ? data.error : 'Fehler';
      showToast('Test fehlgeschlagen · ' + msg, 'error');
      return;
    }
    _renderErkSimResult(data);
  }catch(err){
    showToast('Test fehlgeschlagen · Netzwerk', 'error');
  }finally{
    btn.disabled = false;
    btn.classList.remove('is-busy');
    if (lblEl) lblEl.textContent = originalLabel;
  }
}
const _ERK_VERDICT_TXT = {
  'pass':         'würde Alarm auslösen',
  'belowthresh':  '',
  'filtered':     '',
};
function _renderErkSimResult(data){
  const wrap = byId('erkSimResult'); if (!wrap) return;
  const img  = byId('erkSimImg');
  const ovl  = byId('erkSimOverlay');
  const list = byId('erkSimList');
  const ttl  = byId('erkSimTitle');
  if (img) img.src = data.snapshot || '';
  // viewBox in absolute frame pixel coordinates so backend bbox values
  // (which are pixel-space) drop in unchanged. preserveAspectRatio in
  // the inline element default is xMidYMid meet — but since the wrapper
  // .erk-test-result-imgwrap forces a 16:9 aspect ratio and the <img>
  // uses object-fit:contain, the SVG and the image scale identically.
  // Cameras whose native aspect doesn't match 16:9 letterbox the same
  // way under both elements.
  const fs = data.frame_size || { w: 1920, h: 1080 };
  if (ovl) ovl.setAttribute('viewBox', `0 0 ${Math.max(1, fs.w)} ${Math.max(1, fs.h)}`);

  const dets = data.detections || [];
  const passCount = dets.filter(d => d.verdict === 'pass').length;
  if (ttl){
    ttl.textContent = passCount > 0
      ? `${passCount} Treffer würden Alarm auslösen`
      : (dets.length === 0 ? 'Keine Erkennung' : 'Kein Treffer würde Alarm auslösen');
  }
  // Boxes — paint-order=stroke on the label so the dark halo stays
  // readable above bright snapshot regions. font-size scales with the
  // viewBox; an absolute "10 px" on a 1920-wide viewBox shows up as
  // ~10 px in screen pixels regardless of how the wrapper scales.
  if (ovl){
    ovl.innerHTML = dets.map(d => {
      const cls = `erk-det-box is-${d.verdict}`;
      const labelText = `${d.label} ${Math.round(d.score * 100)}%`;
      const fontSize = Math.max(10, Math.round(fs.w / 100));
      const boxR = Math.max(2, Math.round(fs.w / 480));
      return `
        <rect class="${cls}" x="${d.bbox[0]}" y="${d.bbox[1]}" width="${d.bbox[2]}" height="${d.bbox[3]}" rx="${boxR}" vector-effect="non-scaling-stroke" />
        <text class="erk-det-label" x="${d.bbox[0] + 4}" y="${d.bbox[1] + fontSize + 2}" font-size="${fontSize}">${esc(labelText)}</text>
      `;
    }).join('');
  }
  // List of detections — empty → friendly message, otherwise one row
  // per det with a coloured dot, the label, the score, and a verdict
  // hint (the backend's reason field carries the threshold for
  // belowthresh and the filter reason for filtered).
  if (list){
    if (dets.length === 0){
      list.innerHTML = `<div class="erk-det-empty">Coral hat in diesem Frame nichts erkannt.</div>`;
    } else {
      list.innerHTML = dets.map(d => {
        const verdictText = d.reason || _ERK_VERDICT_TXT[d.verdict] || '';
        return `
          <div class="erk-det-row is-${esc(d.verdict)}">
            <span class="det-dot"></span>
            <span class="det-name">${esc(d.label)}</span>
            <span class="det-score">${Math.round(d.score * 100)}%</span>
            <span class="det-verdict">${esc(verdictText)}</span>
          </div>`;
      }).join('');
    }
  }
  wrap.hidden = false;
  // Smooth scroll except under reduced-motion.
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  wrap.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' });
}

// Per-camera object-filter pills (Person/Katze/Vogel/Auto/Hund). Same
// visual recipe as the Mediathek filter bar — active pill fills with the
// object colour via --cb. _camObjectFilterState is kept in sync with the
// hidden input so the existing save flow doesn't need to change.
const _CAM_OBJ_OPTIONS=[
  {k:'person',   label:'Person',       cb:'#a855f7'},
  {k:'cat',      label:'Katze',        cb:'#ec4899'},
  {k:'bird',     label:'Vogel',        cb:'#06b6d4'},
  {k:'car',      label:'Auto',         cb:'#f59e0b'},
  {k:'dog',      label:'Hund',         cb:'#7c2d12'},
  {k:'squirrel', label:'Eichhörnchen', cb:'#7c4a1f'},
];
let _camObjectFilterState=[];
function _renderCamObjectPills(){
  const host=byId('camObjectFilter'); if(!host) return;
  const active=new Set(_camObjectFilterState);
  host.innerHTML=_CAM_OBJ_OPTIONS.map(o=>{
    const on=active.has(o.k);
    return `<button type="button" class="cam-obj-pill${on?' active':''}" data-obj="${o.k}" style="--cb:${o.cb}"><span class="cop-ico">${objIconSvg(o.k,16)||''}</span><span>${o.label}</span></button>`;
  }).join('');
  host.querySelectorAll('.cam-obj-pill').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const k=btn.dataset.obj;
      if(active.has(k)){active.delete(k); btn.classList.remove('active');}
      else{active.add(k); btn.classList.add('active');}
      _camObjectFilterState=[..._CAM_OBJ_OPTIONS.map(o=>o.k).filter(x=>active.has(x))];
      const hidden=byId('cameraForm').elements['object_filter'];
      if(hidden) hidden.value=_camObjectFilterState.join(',');
    });
  });
}

const _ALARM_PROFILE_HINTS={
  hard:   'Telegram nur bei Person/Auto. Tiere & reine Bewegung werden ignoriert.',
  medium: 'Telegram bei Person/Auto (Alarm) und bei Tieren (Info-Meldung). Reine Bewegung still.',
  soft:   'Telegram bei jedem Event — Person, Tier oder reine Bewegung.',
  info:   'Telegram nur bei Tieren (Katze, Vogel, Fuchs …). Personen & Bewegung still.',
};
window._updateAlarmProfileHint=function(){
  const sel=byId('camAlarmProfileSelect'); const hint=byId('camAlarmProfileHint');
  if(!sel||!hint) return;
  hint.textContent=_ALARM_PROFILE_HINTS[sel.value]||'';
};

// Erkennung-tab status strip — slim row with a coloured dot, an inline
// Coral state label, the per-frame inference latency, and the seconds-
// since-last-good-frame as a relative time. Mutates the static markup
// already in the template (#camGlobalStatus.erk-status) rather than
// rendering full HTML, so the dot pulse animation isn't restarted on
// every state recompute. Called from editCamera() after the camera has
// been resolved so we can read its detection_mode / coral_available /
// inference_avg_ms / frame_age_s — falls back to camGlobalStatus's
// initial "Coral läuft" placeholder when no camera is in scope.
function _renderGlobalStatusRows(){
  const host=byId('camGlobalStatus'); if(!host) return;
  // Resolve the camera being edited, with fallback to the first cam in
  // state.cameras (the original behaviour). This also covers the brief
  // window between editCamera being entered and the form being fully
  // populated.
  const camId=byId('cameraForm')?.elements?.['id']?.value;
  const cam=(state.cameras||[]).find(x=>x.id===camId) || state.cameras?.[0];
  const proc=state.config?.processing||{};
  // Prefer the backend's explicit coral_mode (one of 'tpu' /
  // 'cpu_fallback' / 'off' — see camera_runtime.status). Fall back to
  // deriving from detection_mode + coral_available for older builds /
  // tests that don't surface coral_mode yet.
  let mode = cam?.coral_mode;
  if (!mode){
    const coralOn = !!(proc.coral_enabled ?? (cam?.detection_mode !== 'motion_only'));
    const coralAvail = !!cam?.coral_available;
    if (!coralOn) mode = 'off';
    else if (cam?.detection_mode === 'coral' && coralAvail) mode = 'tpu';
    else if (cam?.detection_mode === 'cpu') mode = 'cpu_fallback';
    else mode = 'off';
  }
  const variant = mode === 'tpu' ? 'is-ok'
                : mode === 'cpu_fallback' ? 'is-cpu'
                : 'is-off';
  const text = mode === 'tpu' ? 'Coral läuft'
             : mode === 'cpu_fallback' ? 'CPU-Notfall'
             : 'Coral aus';
  const dot=host.querySelector('.dot');
  if (dot){
    dot.classList.remove('is-ok','is-cpu','is-off');
    dot.classList.add(variant);
  }
  const txt=host.querySelector('#erkStatusText');
  if (txt) txt.textContent=text;
  // Inference latency — render '—' when the cam is offline / hasn't yet
  // returned a meaningful sample. _wsFmtRel is too heavy for the strip;
  // a single Math.round suffices.
  const ms=Number(cam?.inference_avg_ms);
  const msEl=byId('erkStatusMs');
  if (msEl){
    msEl.textContent = (Number.isFinite(ms) && ms > 0)
      ? `${Math.round(ms)} ms / Frame`
      : '— ms / Frame';
  }
  // "letztes Update" — frame_age_s is the seconds-since-last-good-frame
  // counter (see camera_runtime.status). null/undefined means the cam
  // never produced a frame.
  const age=Number(cam?.frame_age_s);
  const upEl=byId('erkStatusUpdated');
  if (upEl) upEl.textContent = _fmtRelativeAgeS(age);
}

// Formatter for "vor X Sek/Min/Std/Tagen" used by the Erkennung status
// strip. Anything older than 7 days collapses to "vor >1 Woche" so the
// strip doesn't spell out an obviously-stale interval.
function _fmtRelativeAgeS(s){
  if (s == null || !Number.isFinite(s)) return '—';
  if (s < 5)        return 'gerade eben';
  if (s < 60)       return `vor ${Math.round(s)} s`;
  if (s < 3600)     return `vor ${Math.round(s/60)} Min.`;
  if (s < 86400)    return `vor ${Math.round(s/3600)} Std.`;
  if (s < 7*86400)  return `vor ${Math.round(s/86400)} Tagen`;
  return 'vor >1 Woche';
}
window._scrollToCoralSettings=function(ev){
  ev?.preventDefault();
  // Navigate to the settings page then expand the Coral section.
  document.querySelector('a[href="#settings"]')?.click();
  setTimeout(()=>{
    const section=byId('set-coral');
    if(!section) return;
    if(!section.classList.contains('open')) window.toggleSetSection('set-coral');
    section.scrollIntoView({behavior:'smooth',block:'start'});
  },120);
};

// ── camera_id JS port — keep in lockstep with app/app/camera_id.py ──────────
// The backend treats the persisted id as authoritative; this preview shows
// the user what build_camera_id() will compute on save so there are no
// surprises when the storage_migration kicks in.
const _CAM_ID_TRANSLIT = {
  'ä':'ae','ö':'oe','ü':'ue','Ä':'ae','Ö':'oe','Ü':'ue',
  'ß':'ss','ñ':'n','ç':'c'
};
function _camIdSanitise(seg){
  if(seg == null) return '';
  let s = String(seg).replace(/./g, ch => _CAM_ID_TRANSLIT[ch] ?? ch);
  // NFKD decompose, drop combining marks (mirrors python unicodedata)
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return s;
}
function _camIdLastIpSegment(ip){
  if(!ip) return '';
  const s = String(ip).trim();
  if(s.indexOf('.') >= 0){
    const last = s.split('.').pop();
    const san = _camIdSanitise(last);
    if(san) return san;
  }
  if(s.indexOf(':') >= 0){
    const noZone = s.split('%')[0];
    const last = noZone.split(':').pop();
    const san = _camIdSanitise(last);
    if(san) return san;
  }
  return '';
}
function buildCameraId(manufacturer, model, name, ip){
  const parts = [manufacturer, model, name].map(raw => {
    const c = _camIdSanitise(raw);
    return c || 'unknown';
  });
  const ipSeg = _camIdLastIpSegment(ip);
  parts.push(ipSeg || 'unknown');
  return parts.join('_');
}

// Per-class fallbacks for the confirmation-window UI grid. Mirrors the
// settings_store._CONFIRMATION_WINDOW_DEFAULTS Python-side dict so the
// UI shows the same defaults the backend would apply.
const _CW_DEFAULTS = {
  person:   { n: 3, seconds: 5.0 },
  cat:      { n: 3, seconds: 5.0 },
  bird:     { n: 2, seconds: 4.0 },
  squirrel: { n: 2, seconds: 3.0 },
  dog:      { n: 3, seconds: 5.0 },
  car:      { n: 3, seconds: 5.0 },
  motion:   { n: 2, seconds: 4.0 },
};
function _renderCamConfirmGrid(c){
  const grid = byId('camConfirmGrid'); if (!grid) return;
  const filter = (c.object_filter || []).filter(Boolean);
  const cw = c.confirmation_window || {};
  if (!filter.length){
    grid.innerHTML = `<div class="field-help" style="margin:0">Wähle oben Objekte aus, um Bestätigungs-Filter pro Klasse zu konfigurieren.</div>`;
    return;
  }
  grid.innerHTML = filter.map(cls => {
    const fb = _CW_DEFAULTS[cls] || { n: 3, seconds: 5.0 };
    const cur = cw[cls] || {};
    const n = parseInt(cur.n, 10);
    const s = parseFloat(cur.seconds);
    const nVal = Number.isFinite(n) ? n : fb.n;
    const sVal = Number.isFinite(s) ? s : fb.seconds;
    const lbl = (typeof OBJ_LABEL === 'object' && OBJ_LABEL[cls]) ? OBJ_LABEL[cls] : cls;
    return `
      <div class="cam-confirm-row" data-cw-cls="${esc(cls)}">
        <span class="cam-confirm-cls">${esc(lbl)} bestätigen nach</span>
        <input type="number" class="cam-confirm-n" data-cw-n min="1" max="10" step="1" value="${nVal}" inputmode="numeric"/>
        <span class="cam-confirm-sep">Treffer in</span>
        <input type="number" class="cam-confirm-s" data-cw-s min="0.5" max="30" step="0.5" value="${sVal}" inputmode="decimal"/>
        <span class="cam-confirm-unit">Sek</span>
      </div>`;
  }).join('');
}

function _refreshCamIdPreview(){
  const el = byId('camIdPreview'); if(!el) return;
  const f = byId('cameraForm')?.elements; if(!f) return;
  const newId = buildCameraId(
    f['manufacturer']?.value || '',
    f['model']?.value || '',
    f['name']?.value || '',
    f['rtsp_ip']?.value || ''
  );
  el.textContent = newId;
}
function _bindCamIdPreviewListeners(){
  const form = byId('cameraForm'); if(!form || form.dataset.idPreviewWired) return;
  ['manufacturer','model','name','rtsp_ip'].forEach(n => {
    const el = form.elements[n]; if(el){
      el.addEventListener('input', _refreshCamIdPreview);
    }
  });
  form.dataset.idPreviewWired = '1';
}

function editCamera(camId){
  // DIAG:cam-edit-lock — entry, abort, toggle paths instrumented so we
  // can see whether the click handler actually fires and which branch
  // it follows.
  _erkDebugSet(`editCamera(${camId}) · _currentEditCamId=${_currentEditCamId} · _camFormInited=${_camFormInited}`);
  // Defensive: if the cam-edit form isn't in the DOM yet (rare but
  // happens on the first click during a page-load race, OR when the
  // wrapper has been detached by a previous renderCameraSettings()
  // and not re-created), wait one frame and retry once. After that,
  // tell the user to reload — there's no recoverable state at this
  // point. Without the guard, the next line crashes on .elements of
  // null and the toast fires every click forever.
  const formEl = byId('cameraForm');
  if (!formEl) {
    _erkDebugSet(`editCamera DEFER: cameraForm not yet in DOM`);  // DIAG:cam-edit-lock
    requestAnimationFrame(() => {
      if (byId('cameraForm')) editCamera(camId);
      else showToast('Bearbeitungs-Form nicht bereit — Seite neu laden (F5)', 'error');
    });
    return;
  }
  const c=(state.config?.cameras||[]).find(x=>x.id===camId)||(state.cameras||[]).find(x=>x.id===camId);
  if(!c){
    _erkDebugSet(`editCamera ABORTED: cam ${camId} not in state`);  // DIAG:cam-edit-lock
    // Camera not in current state → drop any half-set lock so the user
    // can retry once loadAll() refreshes state. Without this the lock
    // would stick if a stale camId (post-rename) raced through here.
    _currentEditCamId=null;
    console.error('editCamera: not found',camId); return;
  }
  // Toggle: clicking same camera closes the panel
  if(_currentEditCamId===camId){
    _erkDebugSet(`editCamera TOGGLE-CLOSE same camId`);  // DIAG:cam-edit-lock
    _closeEditPanel(); return;
  }
  // From here on, ANY exception in the hydration helpers below would
  // historically leave _currentEditCamId stale and the wrapper detached
  // from #cameras — every future click then matched the stale lock and
  // bailed via the toggle-close branch. The try/catch resets state to a
  // known-good baseline so the next click can re-open cleanly.
  try {
  // Switch camera: restore immediately then open new
  _restoreEditWrapper();
  _initCameraFormListeners();
  initCameraEditTabs();
  initRtspBuilder();
  // formEl was captured + null-checked at the top of editCamera; reuse
  // it instead of paying for another byId lookup that could race with
  // a mid-flight wrapper detach.
  const f=formEl.elements;
  f['id'].value=c.id||''; f['id'].dataset.autoGen='0';
  f['name'].value=c.name||'';
  if(f['manufacturer']) f['manufacturer'].value = c.manufacturer || '';
  if(f['model']) f['model'].value = c.model || '';
  if(f['icon']) f['icon'].value=c.icon||getCameraIcon(c.name||c.id);
  // Live preview of the canonical id derived from manufacturer/model/name/IP.
  _bindCamIdPreviewListeners();
  // Reolink GetDevInfo rescan button — wires once per session.
  _bindCamProbeDeviceInfo();
  // Reset the auto-detected hints — a fresh open should not retain a
  // hint left over from a previous session's save.
  byId('cameraForm')?.querySelectorAll('.cam-autodetected-hint').forEach(el=>{el.hidden=true});
  byId('cameraEditTitle').textContent=`Kamera bearbeiten · ${c.name||c.id}`;
  const p=parseRtspUrl(c.rtsp_url||'');
  f['rtsp_ip'].value=p.host||''; f['rtsp_user'].value=p.user||''; f['rtsp_pass'].value=p.pass||''; f['rtsp_port'].value=p.port||'554';
  const matchedPath=RTSP_PATH_OPTS.find(o=>o.value===p.path);
  if(f['rtsp_path']) {
    const def=_defaultRtspPathForManufacturer(c.manufacturer||'');
    // Existing cam with a path → use it; fresh cam with no path → fall
    // back to the manufacturer-derived default so manual='0' from the
    // start instead of flagging the legacy RTSP_PATH_OPTS[0] as custom.
    f['rtsp_path'].value = matchedPath ? matchedPath.value : def;
    f['rtsp_path'].dataset.manual = (f['rtsp_path'].value !== def) ? '1' : '0';
    _updateRtspErweitertVisuals();
  }
  f['rtsp_url'].value=c.rtsp_url||'';
  f['snapshot_url'].value=c.snapshot_url||'';
  // Apply password masking to the URL display fields. Eye toggle reveals.
  delete f['rtsp_url'].dataset.real; delete f['snapshot_url'].dataset.real;
  _applyUrlMask(f['rtsp_url']);
  _applyUrlMask(f['snapshot_url']);
  // Reset eye buttons to masked-state icon
  byId('cameraForm').querySelectorAll('.url-eye').forEach(b=>{b.classList.remove('revealed'); b.textContent='👁';});
  // Telegram/MQTT toggles are populated in the Alerting-tab hydration
  // block below alongside the severity matrix and channel switches.
  // Populate global status rows on the Erkennung tab
  _renderGlobalStatusRows();
  // Object filter is now rendered as a pill bar; keep the hidden input in
  // sync so the existing save flow (reads from f['object_filter'].value)
  // still works unchanged.
  _camObjectFilterState=[...(c.object_filter||['person','cat','bird'])];
  f['object_filter'].value=_camObjectFilterState.join(',');
  _renderCamObjectPills();
  // Legacy alarm_profile is now a hidden bridge field — the source of
  // truth is the per-class severity matrix. Carry the camera's stored
  // alarm_profile through the form so back-end code that still reads
  // it on save keeps working until the cutover commit.
  if (f['alarm_profile']) f['alarm_profile'].value = (c.alarm_profile || 'soft');
  // Per-class severity matrix — render after the form's id is set so
  // event handlers reference the right camera. Also wire the
  // conflict-banner watcher (idempotent) and run an initial check
  // against the freshly-populated form values.
  _renderSeverityMatrix(byId('cameraForm'), c);
  _bindAlertingConflictWatch(byId('cameraForm'));
  _checkAlertingConflicts(byId('cameraForm'));
  // Telegram bot health strip — fire-and-forget; the function handles
  // its own error states and never throws.
  _renderAlertStatusStrip();
  // Test-Push button — wires once per session; result panel resets on
  // every reopen so a stale "✓ Telegram angekommen" from the previous
  // edit doesn't linger.
  _bindAlertTestButton();
  const alertTestResult = byId('alertTestResult');
  if (alertTestResult) alertTestResult.hidden = true;
  // Per-class cooldown drilldown — populate sliders + bind disclosure
  // toggle. Drilldown stays hidden by default so the matrix is the
  // first impression; user opens it when fine-tuning.
  _renderAlertCooldownGrid(byId('cameraForm'), c);
  _bindAlertCooldownToggle();
  const alertCooldownGrid = byId('alertCooldownGrid');
  if (alertCooldownGrid) alertCooldownGrid.hidden = true;
  if(f['enabled']) f['enabled'].checked=!!c.enabled; f['armed'].checked=!!c.armed;
  // Two independent schedules — schedule_notify for Telegram/MQTT,
  // schedule_record for the on-disk archive. Either can be enabled or
  // disabled without affecting the other. JS keeps a hidden legacy
  // schedule field in sync below so older backend gates that still
  // read it (commit 3 retires those) keep working.
  const _legacySch = c.schedule || {};
  const _legacyAct = _legacySch.actions || {};
  const _schN = c.schedule_notify || {
    enabled: !!_legacySch.enabled && _legacyAct.telegram !== false,
    from: _legacySch.from || '21:00',
    to:   _legacySch.to   || '06:00',
  };
  const _schR = c.schedule_record || {
    enabled: !!_legacySch.enabled && _legacyAct.record !== false,
    from: _legacySch.from || '00:00',
    to:   _legacySch.to   || '23:59',
  };
  if (f['schedule_notify_enabled']) f['schedule_notify_enabled'].checked = !!_schN.enabled;
  if (f['schedule_notify_from'])    f['schedule_notify_from'].value      = _schN.from || '21:00';
  if (f['schedule_notify_to'])      f['schedule_notify_to'].value        = _schN.to   || '06:00';
  if (f['schedule_record_enabled']) f['schedule_record_enabled'].checked = !!_schR.enabled;
  if (f['schedule_record_from'])    f['schedule_record_from'].value      = _schR.from || '00:00';
  if (f['schedule_record_to'])      f['schedule_record_to'].value        = _schR.to   || '23:59';
  // Channel toggles + recording archive toggle.
  if (f['telegram_enabled']) f['telegram_enabled'].checked = (c.telegram_enabled !== false);
  if (f['mqtt_enabled'])     f['mqtt_enabled'].checked     = (c.mqtt_enabled !== false);
  if (f['recording_enabled']) f['recording_enabled'].checked = (c.recording_enabled !== false);
  if(f['bottom_crop_px']) f['bottom_crop_px'].value=c.bottom_crop_px||0;
  if(f['motion_sensitivity']){
    const ms=c.motion_sensitivity!=null?c.motion_sensitivity:0.5;
    f['motion_sensitivity'].value=ms;
  }
  if(f['wildlife_motion_sensitivity']){
    const raw=c.wildlife_motion_sensitivity;
    // 0.0 = "auto" → display the derived 1.4× motion_sensitivity preview
    // (capped at 1.0). The actual value persisted on save is whatever
    // the slider shows after the user touches it.
    const ms=parseFloat(c.motion_sensitivity)||0.5;
    const auto=Math.min(1.0, ms*1.4);
    const v=(raw!=null && parseFloat(raw)>0) ? parseFloat(raw) : auto;
    f['wildlife_motion_sensitivity'].value=v.toFixed(1);
    const lbl=byId('wildlifeMotionLabel'); if(lbl) lbl.textContent=Math.round(v*100)+'%';
  }
  if(f['detection_min_score']){
    const globalMs=state.config?.processing?.detection?.min_score ?? 0.55;
    const cms=(c.detection_min_score && c.detection_min_score>0) ? c.detection_min_score : globalMs;
    f['detection_min_score'].value=cms;
  }
  if(f['label_threshold_person']){
    const lt=(c.label_thresholds||{}).person;
    const v=(lt!=null && !Number.isNaN(parseFloat(lt))) ? parseFloat(lt) : 0.72;
    f['label_threshold_person'].value=v;
  }
  // Confirmation-window step 3 sliders — confirm_n/confirm_seconds carry
  // the new global entry. Existing per-class entries (cw[person] etc.)
  // stay in storage untouched; Phase 2 surfaces them via a "Pro Klasse
  // anpassen" drilldown into #erkConfirmPerClass.
  if(f['confirm_n']){
    const g=(c.confirmation_window||{}).global||{};
    const n=parseInt(g.n,10);
    f['confirm_n'].value=Number.isFinite(n)?n:3;
  }
  if(f['confirm_seconds']){
    const g=(c.confirmation_window||{}).global||{};
    const s=parseFloat(g.seconds);
    f['confirm_seconds'].value=Number.isFinite(s)?Math.round(s):5;
  }
  // Legacy per-class grid is no longer rendered as visible UI but the
  // function is null-safe (returns early when #camConfirmGrid is hidden
  // via [hidden]). Phase 2 reactivates the drilldown.
  _renderCamConfirmGrid(c);
  // detection_trigger lives as a hidden input on the Erkennung tab during
  // this transition; the follow-up commit moves it to a visible select on
  // the Allgemein tab. Either way we set the value so save preserves it.
  if(f['detection_trigger']) f['detection_trigger'].value=c.detection_trigger||'motion_and_objects';
  if(f['post_motion_tail_s']){
    // Normalise: 0 or null → "0" (Standard / Global-Wert), otherwise pick
    // closest preset. Save handler stores 0 when "Standard" is selected,
    // preserving the use-global-default sentinel.
    const tail=c.post_motion_tail_s||0;
    const presets=['0','3','5','8','10','15'];
    f['post_motion_tail_s'].value=presets.includes(String(tail))?String(tail):'0';
  }
  // frame_interval_ms is now the slider in step 4 of the Erkennung flow.
  if(f['frame_interval_ms']){
    const fi=c.frame_interval_ms||350;
    f['frame_interval_ms'].value=fi;
  }
  // motion_enabled, resolution, snapshot_interval_s, bottom_crop_px,
  // wildlife_motion_sensitivity have no UI in the new Erkennung layout;
  // their persisted values are preserved via existingCam fallback in the
  // form-submit handler so saves don't silently flip them to defaults.
  // Re-bind all step-1/2/3/4/5 slider value labels now that the form
  // values have been populated.
  _initErkSliders(byId('cameraForm'));
  // Step 2 + step 3 drilldowns — populate per-class confidence and
  // confirmation-window sliders, bind their "Pro Klasse anpassen ▾"
  // toggles. Both wraps stay hidden by default so a user reopening
  // cam-edit isn't shown the drilldown unless they ask for it.
  _renderErkPerClassConfidence(byId('cameraForm'), c);
  _bindErkPerClassToggle();
  _renderErkPerClassConfirm(byId('cameraForm'), c);
  _bindErkConfirmPerClassToggle();
  // "Erkennung jetzt simulieren" — bind once per session. Result panel
  // starts hidden; reopens automatically on each successful run.
  _bindErkSimulate();
  const simResult = byId('erkSimResult');
  if (simResult) simResult.hidden = true;
  _whitelistState=[...(c.whitelist_names||[])]; _updateWhitelistHidden();
  shapeState.camera=camId; shapeState.zones=JSON.parse(JSON.stringify(c.zones||[])); shapeState.masks=JSON.parse(JSON.stringify(c.masks||[])); shapeState.points=[]; shapeState.pulse=null;
  f['zones_json'].value=JSON.stringify(shapeState.zones); f['masks_json'].value=JSON.stringify(shapeState.masks);
  // Keep the editor's auxiliary UI (polygon list, drawing-bar, mode
  // buttons) in sync with shapeState whenever a camera is opened.
  _renderShapeList(); _updateShapeDrawingBar(); _updateShapeModeButtons();
  byId('deleteCameraBtn').dataset.camId=camId;
  loadMaskSnapshot(camId); drawShapes();
  // Slide down inside the clicked camera card.
  const camRow=byId('cameraSettingsList')?.querySelector(`[data-camid="${camId}"]`);
  const wrapper=byId('cameraEditWrapper');
  // DIAG:cam-edit-lock — confirm row + wrapper both exist at this point.
  // If wrapper is null here, the form will fail to render.
  _erkDebugSet(`editCamera mount · camRow=${camRow?'ok':'NULL'} · wrapper=${wrapper?'ok':'NULL'}`);
  if(camRow){ camRow.appendChild(wrapper); camRow.classList.add('editing'); }
  requestAnimationFrame(()=>wrapper?.classList.add('slide-open'));
  _currentEditCamId=camId;
  setTimeout(()=>wrapper.scrollIntoView({behavior:'smooth',block:'nearest'}),120);
  // Populate connection diagnostics panel
  _loadCamDiagnostics(camId);
  // Tab-bar recovery indicator + field highlights — replaces the old
  // full-width "Verbindungsdaten unvollständig" banner. Drives off the
  // live form values, not the persisted cam dict, so it reacts to
  // edits (rebuild() in setupRtspBuilder calls _refreshConnectionWarn
  // on every input). Run AFTER all fields have been populated above
  // so the historical "race during _applyUrlMask" can't fire a false
  // positive on cards that already have valid creds.
  _refreshConnectionWarn();
  // Initial render of the live ID preview now that every input is populated.
  _refreshCamIdPreview();
  } catch(e) {
    // Any hydration helper threw — restore the lock to a clean state
    // so the next click can re-attempt without the toggle-close branch
    // mistakenly firing on the stale _currentEditCamId. Surface the
    // failure to the user via toast so they know to retry; rethrow so
    // the original stack remains visible in DevTools for diagnosis.
    _erkDebugSet(`editCamera THREW: ${e?.message||e}`);  // DIAG:cam-edit-lock
    _currentEditCamId=null;
    _restoreEditWrapper();
    showToast('Kamera-Bearbeitung konnte nicht öffnen — bitte erneut versuchen','warn');
    throw e;
  }
}

// Compute the "connection warn" state from the live form and reflect it
// on (a) the tab-bar ↺ indicator and (b) the specific .field-wrap blocks
// for the inputs that are still empty. Single source — the listeners
// attached by initRtspBuilder + the one-shot calls from editCamera /
// post-save go through here.
function _refreshConnectionWarn(){
  const indicator = byId('camTabRecoveryBtn'); if (!indicator) return;
  const f = byId('cameraForm')?.elements;
  if (!f){
    indicator.classList.remove('is-warn', 'is-pulsing');
    return;
  }
  // 1. Resolve the effective rtsp_url. Order:
  //    (a) the unmasked real value (set by initRtspBuilder.setMaskable),
  //    (b) the visible field value,
  //    (c) a synthesised URL built from the parts (mirrors rebuild()
  //        in setupRtspBuilder so a half-typed form behaves consistently),
  //    (d) "".
  const rawReal = f['rtsp_url']?.dataset?.real;
  const rawVis = f['rtsp_url']?.value;
  const ip   = (f['rtsp_ip']?.value || '').trim();
  const user = (f['rtsp_user']?.value || '').trim();
  const pass = (f['rtsp_pass']?.value || '').trim();
  const port = (f['rtsp_port']?.value || '554').trim();
  const path = f['rtsp_path']?.value || '';
  let effective = '';
  if (rawReal && rawReal.trim()) effective = rawReal.trim();
  else if (rawVis && rawVis.trim()) effective = rawVis.trim();
  else if (ip) {
    const auth = user ? (user + (pass ? ':' + (typeof _rtspEnc==='function'?_rtspEnc(pass):encodeURIComponent(pass)) : '') + '@') : '';
    const portPart = (port && port !== '554') ? ':' + port : '';
    effective = `rtsp://${auth}${ip}${portPart}${path}`;
  }
  // 2. Parse it and combine with the dedicated user field.
  let parsed = {};
  if (effective) {
    try { parsed = parseRtspUrl(effective) || {}; } catch { parsed = {}; }
  }
  const hasHost  = !!(parsed.host && parsed.host.trim()) || !!ip;
  const hasCreds = !!(parsed.user && parsed.user.trim()) || !!user;
  const warn = !hasHost || !hasCreds;
  // 3. Reflect on the tab-bar indicator.
  if (warn){
    if (!indicator.classList.contains('is-warn')){
      indicator.classList.add('is-warn', 'is-pulsing');
      // Pulse runs 4 iterations (~5.6s) then stays solid; strip the
      // pulse class so the box-shadow animation doesn't loop forever.
      setTimeout(() => indicator.classList.remove('is-pulsing'), 5600);
    }
    indicator.setAttribute('title',
      'Verbindungsdaten unvollständig — klicken zum Wiederherstellen');
  } else {
    indicator.classList.remove('is-warn', 'is-pulsing');
    indicator.setAttribute('title', 'Verbindung wiederherstellen');
  }
  // 4. Field-level highlights — only when the indicator is in WARN mode,
  //    and only on the specific wraps that are missing input.
  const setWarn = (input, on) => {
    const wrap = input?.closest?.('.field-wrap');
    if (!wrap) return;
    wrap.classList.toggle('cam-field-warn', !!on);
  };
  setWarn(f['rtsp_ip'],   warn && !hasHost);
  setWarn(f['rtsp_user'], warn && !hasCreds);
  setWarn(f['rtsp_pass'], warn && !hasCreds);
}

// ── Connection-recovery modal (Verbindung tab "Wiederherstellen ↺") ──────────
// Two paths, in priority order:
//   A) Sicherung — settings.json.bak / .bak2 + storage/backups/*.json. Restores
//      the four connection fields server-side and triggers an immediate
//      reconnect via /api/settings/cameras/<id>/restore-connection.
//   B) Auto-Erkennung — calls the existing /api/discover and lets the user
//      pick a device; only IP + suggested RTSP path are written into the
//      form. The user enters credentials and uses the normal Save button.
window.openCamRecoveryModal=function(){
  if(!_currentEditCamId) return;
  const m=byId('camRecoveryModal'); if(!m) return;
  m.classList.remove('hidden');
  // Default to the Sicherung tab.
  _switchCamRecoveryTab('rec-backup');
  loadCamRecoveryBackups();
  // Wire tab clicks once.
  if(!m.dataset.wired){
    m.querySelectorAll('.cam-recovery-tab').forEach(b=>{
      b.addEventListener('click',()=>_switchCamRecoveryTab(b.dataset.tab));
    });
    m.dataset.wired='1';
  }
};
window.closeCamRecoveryModal=function(){
  const m=byId('camRecoveryModal'); if(!m) return;
  m.classList.add('hidden');
};
function _switchCamRecoveryTab(tabId){
  const m=byId('camRecoveryModal'); if(!m) return;
  m.querySelectorAll('.cam-recovery-tab').forEach(b=>{
    b.classList.toggle('active', b.dataset.tab===tabId);
  });
  m.querySelectorAll('.cam-recovery-tab-content').forEach(c=>{
    c.hidden=(c.id!==tabId);
  });
}
async function loadCamRecoveryBackups(){
  const wrap=byId('camRecoveryBackupList'); if(!wrap) return;
  wrap.innerHTML=`<div class="muted small">Lade Sicherungen…</div>`;
  let items=[];
  try{
    const r=await fetch(`/api/settings/backups?cam_id=${encodeURIComponent(_currentEditCamId)}`);
    items=(await r.json()).items||[];
  }catch(e){
    wrap.innerHTML=`<div class="cam-recovery-empty">Sicherungen nicht abrufbar (${esc(String(e))}).</div>`;
    return;
  }
  if(!items.length){
    wrap.innerHTML=`<div class="cam-recovery-empty">Noch keine Sicherungen vorhanden. Sicherungen werden ab dem nächsten Speichern automatisch angelegt — solange ist nur die Auto-Erkennung verfügbar.</div>`;
    return;
  }
  wrap.innerHTML=items.map(it=>{
    const dt=it.mtime_iso? it.mtime_iso.replace('T',' ').slice(0,16) : '?';
    const sizeKb=(it.size/1024).toFixed(1);
    let usable='', btn='';
    if(!it.has_cam){
      usable=`<span class="cam-recovery-tag cam-recovery-tag--off">Kamera nicht enthalten</span>`;
    }else if(!it.has_connection){
      usable=`<span class="cam-recovery-tag cam-recovery-tag--off">Verbindungsfelder leer</span>`;
    }else{
      usable=`<span class="cam-recovery-tag cam-recovery-tag--on">Verbindung gespeichert</span>`;
      btn=`<button type="button" class="btn-action" onclick="applyCamRecoveryBackup('${esc(it.filename)}')">Übernehmen</button>`;
    }
    return `<div class="cam-recovery-row">
      <div class="cam-recovery-row-meta">
        <div class="cam-recovery-row-title">${esc(it.filename)}</div>
        <div class="cam-recovery-row-sub">${dt} · ${it.n_cameras} Kameras · ${sizeKb} KB</div>
      </div>
      <div class="cam-recovery-row-actions">${usable}${btn}</div>
    </div>`;
  }).join('');
}
window.applyCamRecoveryBackup=async function(filename){
  const camId=_currentEditCamId; if(!camId) return;
  try{
    const r=await fetch(`/api/settings/cameras/${encodeURIComponent(camId)}/restore-connection`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({filename}),
    });
    const d=await r.json();
    if(!r.ok||!d.ok){
      showToast(`Wiederherstellen fehlgeschlagen: ${d.error||r.statusText}`,'error');
      return;
    }
    showToast(`Verbindung aus ${filename} wiederhergestellt — Kamera startet neu`,'success');
    closeCamRecoveryModal();
    // Refresh state + re-open the edit panel so the user sees the restored fields.
    await loadAll();
    if(_currentEditCamId===camId){_closeEditPanel();}
    // Was: setTimeout(()=>editCamera(camId),250); — 250 ms was a guess
    // and sometimes fired before the cam-edit form had rendered into
    // the DOM. _whenFormReady polls until #rtspPathSelect appears (or
    // gives up after 1 s) so editCamera never races with the post-
    // loadAll render cycle. This is the TimerOut path that previously
    // triggered the lock cascade via initRtspBuilder's TypeError.
    _whenFormReady(()=>editCamera(camId));
  }catch(e){
    showToast(`Wiederherstellen fehlgeschlagen: ${String(e)}`,'error');
  }
};

// Defer a callback until the cam-edit form is rendered into the DOM —
// detected by the presence of #rtspPathSelect, which is the deepest
// element editCamera's hydration touches first. Caps at 20 attempts ×
// 50 ms = 1 s so a stuck render never leaves the recovery flow
// silently waiting forever; the next manual click retries.
function _whenFormReady(callback, attempts = 20){
  if (byId('rtspPathSelect')) {
    callback();
    return;
  }
  if (attempts <= 0) return;
  requestAnimationFrame(() => {
    setTimeout(() => _whenFormReady(callback, attempts - 1), 50);
  });
}
window.loadCamRecoveryDiscovery=async function(){
  const wrap=byId('camRecoveryDiscoveryList');
  const status=byId('camRecoveryDiscoverStatus');
  if(!wrap) return;
  wrap.innerHTML='';
  if(status) status.textContent='Scanne Subnetz…';
  let items=[];
  try{
    const r=await fetch('/api/discover');
    items=(await r.json()).devices||[];
  }catch(e){
    if(status) status.textContent='Scan fehlgeschlagen';
    return;
  }
  if(status) status.textContent=`${items.length} Geräte gefunden`;
  if(!items.length){
    wrap.innerHTML=`<div class="cam-recovery-empty">Keine Geräte im Subnetz erkannt.</div>`;
    return;
  }
  wrap.innerHTML=items.map((d,idx)=>{
    const guess=d.guess||'Unknown';
    const host=d.hostname?` · ${esc(d.hostname)}`:'';
    const ports=(d.open_ports||[]).join(', ')||'—';
    const path=d.reolink_hints?.suggested_path||'';
    const canApply=!!path;
    const btn=canApply
      ? `<button type="button" class="btn-action" onclick="applyCamRecoveryDiscovery(${idx})">In Formular übernehmen</button>`
      : `<span class="cam-recovery-tag cam-recovery-tag--off">Kein RTSP-Pfad erkannt</span>`;
    return `<div class="cam-recovery-row" data-idx="${idx}">
      <div class="cam-recovery-row-meta">
        <div class="cam-recovery-row-title">${esc(d.ip)} · ${esc(guess)}${host}</div>
        <div class="cam-recovery-row-sub">Ports ${esc(ports)}${path?` · Pfad ${esc(path)}`:''}</div>
      </div>
      <div class="cam-recovery-row-actions">${btn}</div>
    </div>`;
  }).join('');
  // Cache the device list so the apply handler can find it without re-fetching.
  byId('camRecoveryModal').__discoveryCache=items;
};
window.applyCamRecoveryDiscovery=function(idx){
  const cache=(byId('camRecoveryModal')||{}).__discoveryCache||[];
  const d=cache[idx]; if(!d) return;
  const f=byId('cameraForm').elements;
  if(f['rtsp_ip']) f['rtsp_ip'].value=d.ip||'';
  const path=d.reolink_hints?.suggested_path||'';
  if(path && f['rtsp_path']){
    // The select holds canonical Reolink paths; pick the option whose value
    // matches, otherwise leave the existing default alone.
    const opt=Array.from(f['rtsp_path'].options).find(o=>o.value===path);
    if(opt) f['rtsp_path'].value=opt.value;
  }
  // Nudge the existing rtsp_url builder by dispatching an input event on
  // any of the fields it listens to — that rebuild closure is private to
  // initRtspBuilder so we trigger it via the DOM rather than calling it.
  if(f['rtsp_ip']) f['rtsp_ip'].dispatchEvent(new Event('input',{bubbles:true}));
  closeCamRecoveryModal();
  showToast(`IP ${d.ip} übernommen — bitte Benutzer & Passwort ergänzen, dann speichern`,'success');
};

async function _loadCamDiagnostics(camId){
  const panel=byId('camDiagnostics'); if(!panel) return;
  panel.style.display='none';
  try{
    const s=await j(`/api/camera/${encodeURIComponent(camId)}/status`);
    if(!s||s.ok===false) return;
    // Frame age
    const ageEl=byId('diagFrameAge');
    if(ageEl){
      const age=s.frame_age_s;
      if(age==null){ageEl.textContent='—'; ageEl.className='cam-diag-val';}
      else if(age<5){ageEl.textContent=age.toFixed(1)+'s'; ageEl.className='cam-diag-val ok';}
      else if(age<30){ageEl.textContent=age.toFixed(1)+'s'; ageEl.className='cam-diag-val warn';}
      else{ageEl.textContent=age.toFixed(1)+'s'; ageEl.className='cam-diag-val bad';}
    }
    // Reconnect count
    const rcEl=byId('diagReconnects');
    if(rcEl){
      const rc=s.reconnect_count||0;
      rcEl.textContent=rc; rcEl.className='cam-diag-val '+(rc===0?'ok':rc<5?'warn':'bad');
    }
    // Stale incidents
    const stEl=byId('diagStale');
    if(stEl){
      const st=s.stale_incidents||0;
      stEl.textContent=st; stEl.className='cam-diag-val '+(st===0?'ok':st<10?'warn':'bad');
    }
    // Error streak
    const esEl=byId('diagErrorStreak');
    if(esEl){
      const es=s.error_streak||0;
      esEl.textContent=es; esEl.className='cam-diag-val '+(es===0?'ok':es<5?'warn':'bad');
    }
    // Stale streak
    const ssEl=byId('diagStaleStreak');
    if(ssEl){
      const ss=s.stale_streak||0;
      ssEl.textContent=ss; ssEl.className='cam-diag-val '+(ss===0?'ok':ss<5?'warn':'bad');
    }
    // Preview FPS
    const fpsDiagEl=byId('diagPreviewFps');
    if(fpsDiagEl){
      const pfps=s.preview_fps||0;
      fpsDiagEl.textContent=pfps>0?pfps+' fps':'—';
      fpsDiagEl.className='cam-diag-val '+(pfps>=8?'ok':pfps>=2?'warn':'');
    }
    // Stream mode
    const modeEl=byId('diagStreamMode');
    if(modeEl){
      const mode=s.stream_mode||'baseline';
      modeEl.textContent=mode==='live'?'Live':'Vorschau';
      modeEl.className='cam-diag-val '+(mode==='live'?'ok':'');
    }
    // Live viewers
    const viewEl=byId('diagLiveViewers');
    if(viewEl){
      const v=s.live_viewers||0;
      viewEl.textContent=v; viewEl.className='cam-diag-val '+(v>0?'ok':'');
    }
    // Last error
    const errEl=byId('diagLastError');
    if(errEl){
      if(s.last_error){errEl.textContent=s.last_error; errEl.style.display='';}
      else errEl.style.display='none';
    }
    // Compute collapsible summary + auto-open on problems.
    const reconnects=s.reconnect_count||0;
    const errStreak=s.error_streak||0;
    const hasErr=!!s.last_error;
    const problem=errStreak>0 || reconnects>5 || hasErr;
    const sumEl=byId('camDiagSummary');
    if(sumEl){
      sumEl.textContent = problem
        ? `${reconnects} Reconnects · ${errStreak} Fehler${hasErr?' · Stream-Fehler':''}`
        : 'Verbindung stabil';
    }
    // data-problem toggles the red/green CSS tinting on the entire block.
    panel.dataset.problem = problem ? '1' : '0';
    // Auto-open on problems; collapsed otherwise.
    panel.classList.toggle('open', problem);
    panel.style.display='';
  }catch(e){/* no diagnostics available — stay hidden */}
}
window._toggleCamDiag=function(){
  const panel=byId('camDiagnostics'); if(!panel) return;
  panel.classList.toggle('open');
};
window.editCamera=editCamera;

byId('deleteCameraBtn').onclick=async()=>{
  const camId=byId('deleteCameraBtn').dataset.camId;
  if(!camId) return;
  if(!await showConfirm(`Kamera "${camId}" wirklich löschen?\n\nDieser Vorgang entfernt die Kamera aus der Konfiguration. Ereignisse und Medien bleiben im Speicher erhalten.`)) return;
  const r=await j(`/api/settings/cameras/${encodeURIComponent(camId)}`,{method:'DELETE'});
  if(r.event_count>0) showToast(`Hinweis: Für diese Kamera existieren noch ${r.event_count} gespeicherte Ereignisse im Storage. Sie wurden NICHT gelöscht.`,'warn');
  // Clear form so deleted camera's data doesn't linger
  byId('cameraForm').reset();
  byId('deleteCameraBtn').dataset.camId='';
  byId('maskSnapshot').src='';
  shapeState.camera=null; shapeState.zones=[]; shapeState.masks=[]; shapeState.points=[];
  const ctx=getCanvasCtx(); ctx.clearRect(0,0,byId('maskCanvas').width,byId('maskCanvas').height);
  _restoreEditWrapper();
  await loadAll();
};

async function renderProfiles(){
  const cats=await j('/api/cats'); const persons=await j('/api/persons');
  const catEl=byId('catList'); const perEl=byId('personList');
  if(catEl) catEl.innerHTML=cats.profiles.map(p=>`<div style="padding:3px 0;font-size:13px">${esc(p.name)}</div>`).join('')||'<span class="muted small">—</span>';
  if(perEl) perEl.innerHTML=persons.profiles.map(p=>`<div style="padding:3px 0;font-size:13px">${esc(p.name)}${p.whitelisted?' <span class="muted small">(Whitelist)</span>':''}</div>`).join('')||'<span class="muted small">—</span>';
}
async function renderAudit(){ const actions=await j('/api/telegram/actions'); byId('auditPanel').innerHTML=actions.items.map(a=>`<div class="audit-item"><strong>${esc(a.action)}</strong><div class="small">${esc(a.time)}${a.camera_id?` · ${esc(a.camera_id)}`:''}</div></div>`).join('')||'<div class="audit-item">Noch keine Telegram-Aktionen.</div>'; }

async function toggleArm(camId,armed){ await fetch(`/api/camera/${camId}/arm`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({armed})}); await loadAll(); }
window.toggleArm=toggleArm;
window._cvCardClick=function(e,camId){
  const cam=(state.cameras||[]).find(c=>c.id===camId);
  if(!cam) return;
  openLiveView(camId, cam.name||camId);
};
async function loadTimelapse(camId){
  const res=await fetch(`/api/camera/${encodeURIComponent(camId)}/timelapse`);
  const r=await res.json();
  if(r.ok&&r.url){window.open(r.url,'_blank');return;}
  if(r.error==='building'){showToast('Timelapse wird gerade gebaut – bitte in ~15 Sekunden nochmal klicken.','info');return;}
  if(r.error==='no_frames'){showToast('Noch keine Bilder für heute aufgezeichnet.','warn');return;}
  if(r.error==='timelapse disabled'){showToast('Timelapse ist für diese Kamera deaktiviert. Bitte in den Kamera-Einstellungen aktivieren.','warn');return;}
  showToast('Kein Zeitraffer verfügbar für '+(r.day||'heute')+'.','warn');
}
window.loadTimelapse=loadTimelapse;

// ── Live View Modal ───────────────────────────────────────────────────────────
let _liveViewCamId=null;
let _liveViewHd=false;
function openLiveView(camId,camName){
  const modal=byId('liveViewModal'); if(!modal) return;
  _liveViewCamId=camId;
  _liveViewHd=_hdCards.has(camId); // inherit shared HD state
  byId('liveViewTitle').textContent=camName||camId;
  _setLiveViewStream(_liveViewHd);
  const imgEl=byId('liveViewImg');
  // Image click no longer toggles fullscreen — the dedicated FS button owns that.
  if(imgEl) imgEl.onclick=null;
  modal.classList.remove('hidden');
  document.body.style.overflow='hidden';
}
function _setLiveViewStream(hd){
  _liveViewHd=hd;
  const img=byId('liveViewImg'); if(!img||!_liveViewCamId) return;
  img.src=''; // disconnect current stream first
  const url=hd?`/api/camera/${encodeURIComponent(_liveViewCamId)}/stream_hd.mjpg`
               :`/api/camera/${encodeURIComponent(_liveViewCamId)}/stream.mjpg`;
  img.src=url;
  // Shared state: keep the card's HD badge + img in sync
  if(hd) _hdCards.add(_liveViewCamId); else _hdCards.delete(_liveViewCamId);
  const cardBadge=document.querySelector(`.cv-card[data-camid="${CSS.escape(_liveViewCamId)}"] .cv-hd-badge`);
  if(cardBadge) cardBadge.classList.toggle('active',hd);
  const cardImg=document.querySelector(`.cv-card[data-camid="${CSS.escape(_liveViewCamId)}"] .cv-img`);
  if(cardImg){
    if(hd && cardImg.dataset.hdMode!=='1'){
      cardImg.dataset.hdMode='1';
      cardImg.src=`/api/camera/${encodeURIComponent(_liveViewCamId)}/stream_hd.mjpg`;
    } else if(!hd && cardImg.dataset.hdMode==='1'){
      cardImg.dataset.hdMode='0';
      cardImg.src=`/api/camera/${encodeURIComponent(_liveViewCamId)}/snapshot.jpg?t=${Date.now()}`;
    }
  }
  const hdBtn=byId('liveViewHdBtn');
  if(hdBtn){
    hdBtn.textContent='HD';
    hdBtn.style.border='none';
    if(hd){
      hdBtn.style.background='rgba(255,255,255,0.85)';
      hdBtn.style.color='#0a0e1a';
      hdBtn.style.fontWeight='800';
    } else {
      hdBtn.style.background='rgba(255,255,255,0.08)';
      hdBtn.style.color='rgba(255,255,255,0.35)';
      hdBtn.style.fontWeight='700';
    }
  }
}
function closeLiveView(){
  const modal=byId('liveViewModal'); if(!modal) return;
  const img=byId('liveViewImg'); if(img) img.src=''; // disconnect MJPEG stream → remove_viewer
  if(document.fullscreenElement||document.webkitFullscreenElement){
    (document.exitFullscreen||document.webkitExitFullscreen||function(){}).call(document).catch(()=>{});
  }
  const wrap=byId('liveViewWrap'); if(wrap) wrap.classList.remove('fake-fullscreen');
  modal.classList.add('hidden');
  document.body.style.overflow='';
  _liveViewCamId=null;
}
window.openLiveView=openLiveView;
window.closeLiveView=closeLiveView;

// ── Fullscreen helpers ────────────────────────────────────────────────────────
const _FS_EXPAND=`<svg viewBox="0 0 24 24" width="18" height="18" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`;
const _FS_COMPRESS=`<svg viewBox="0 0 24 24" width="18" height="18" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 0 2-2h3M3 16h3a2 2 0 0 0 2 2v3"/></svg>`;
function _fsToggle(wrapEl,targetEl){
  const fsEl=document.fullscreenElement||document.webkitFullscreenElement;
  if(fsEl){
    if(document.exitFullscreen) document.exitFullscreen().catch(()=>{});
    else if(document.webkitExitFullscreen) document.webkitExitFullscreen();
  }else{
    const req=targetEl.requestFullscreen||targetEl.webkitRequestFullscreen||targetEl.mozRequestFullScreen;
    if(req) req.call(targetEl).catch(()=>{wrapEl.classList.add('fake-fullscreen');});
    else wrapEl.classList.add('fake-fullscreen');
  }
}
function _initFsBtn(btnId,wrapEl,getTarget){
  const btn=byId(btnId); if(!btn||!wrapEl) return;
  btn.innerHTML=_FS_EXPAND;
  btn.addEventListener('click',e=>{e.stopPropagation();_fsToggle(wrapEl,getTarget());});
  const update=()=>{
    const fsEl=document.fullscreenElement||document.webkitFullscreenElement;
    const isFs=!!(fsEl&&(fsEl===wrapEl||wrapEl.contains(fsEl)));
    btn.innerHTML=isFs?_FS_COMPRESS:_FS_EXPAND;
    if(!fsEl) wrapEl.classList.remove('fake-fullscreen');
  };
  document.addEventListener('fullscreenchange',update);
  document.addEventListener('webkitfullscreenchange',update);
}

async function toggleTimelapse(camId,currentlyEnabled){
  const cam=(state.config?.cameras||[]).find(c=>c.id===camId)||(state.cameras||[]).find(c=>c.id===camId);
  if(!cam) return;
  const newEnabled=!currentlyEnabled;
  const payload={...cam,timelapse:{...(cam.timelapse||{}),enabled:newEnabled}};
  try{
    const res=await fetch('/api/settings/cameras',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const r=await res.json();
    if(!r.ok){showToast('Error: '+(r.error||'unknown'),'error');return;}
    showToast(newEnabled?'Timelapse enabled.':'Timelapse disabled.','success');
    await loadAll();
  }catch(e){showToast('Save failed: '+e.message,'error');}
}
window.toggleTimelapse=toggleTimelapse;

function hydrateSettings(){
  const mqtt=state.config.mqtt||{};
  const proc=state.config.processing||{}, coral=state.config.coral||{};
  // App section — Public Base URL + Discovery-Subnet now render read-only
  // inside updateSystemPanel(); no inputs to hydrate here.
  updateSystemPanel();
  // MQTT section
  const mqttEn=byId('mqtt_enabled'); if(mqttEn) mqttEn.checked=!!mqtt.enabled;
  const mqttH=byId('mqtt_host'); if(mqttH) mqttH.value=mqtt.host||'';
  const mqttP=byId('mqtt_port'); if(mqttP) mqttP.value=mqtt.port||1883;
  const mqttU=byId('mqtt_username'); if(mqttU) mqttU.value=mqtt.username||'';
  const mqttPw=byId('mqtt_password'); if(mqttPw) mqttPw.value=mqtt.password||'';
  const mqttT=byId('mqtt_base_topic'); if(mqttT) mqttT.value=mqtt.base_topic||'tam-spy';
  // MQTT badge
  const mqttBadge=byId('mqttStatusBadge');
  if(mqttBadge){mqttBadge.textContent=mqtt.enabled?'aktiv':'aus';mqttBadge.className='set-status-badge '+(mqtt.enabled?'set-status-badge--on':'set-status-badge--off');}
  // Coral section — unified .switch toggles (checkbox-driven)
  const coralActive   = !!(proc.coral_enabled ?? coral.mode==='coral');
  const birdActive    = !!(proc.bird_species_enabled ?? coral.bird_species_enabled);
  const wildlifeActive= !!proc.wildlife_enabled;
  const coralInp   = byId('coralTpuEnabled');   if(coralInp)    coralInp.checked=coralActive;
  const birdInp    = byId('birdSpeciesEnabled'); if(birdInp)     birdInp.checked=birdActive;
  const wildInp    = byId('wildlifeEnabled');   if(wildInp)     wildInp.checked=wildlifeActive;
  // Wildlife toggle stays fully interactive even when the model file is
  // missing — the warning beneath the row tells the user what's wrong;
  // we never want to gate the checkbox itself.
  const wildRow = byId('wildlifeEnabledRow');
  if(wildRow){
    wildRow.classList.remove('toggle-row--disabled');
  }
  if(wildInp) wildInp.disabled = false;
  const cam0=state.cameras[0];
  const coralAvail=!!cam0?.coral_available;
  const detMode=cam0?.detection_mode||null;
  const chip=byId('coralStatusChip');
  if(chip){
    // Four states. CPU fallback is now orange (warn-orange) instead of
    // the prior yellow — green/yellow/grey was visually too soft for what
    // is in practice a degraded mode the user should notice.
    let label='aus', cls='set-status-badge--off';
    if(coralActive){
      if(detMode==='coral' && coralAvail){label='Coral TPU aktiv';cls='set-status-badge--on';}
      else if(detMode==='cpu'){label='⚠ CPU-Fallback aktiv';cls='set-status-badge--warn-orange';}
      else{label='✗ KI nicht verfügbar';cls='set-status-badge--off';}
    } else {
      label='KI-Objekterkennung aus';
    }
    chip.textContent=label;
    chip.className='set-status-badge '+cls;
  }
  const hint=byId('coralStatusHint');
  if(hint){
    const reason=cam0?.coral_reason||'—';
    // Happy-path "Coral TPU erkannt und aktiv" line was a duplicate of the
    // status chip in the section header — only WARNING/ERROR lines stay.
    const lines=[];
    if(!coralAvail && coralActive){
      lines.push(`💻 CPU Fallback aktiv (${esc(reason)})`);
    } else if(!coralActive){
      lines.push('⏸ Erkennung deaktiviert');
    }
    if(birdActive && proc.bird_model_available===false){
      const p=proc.bird_model_path||'inat_bird_quant.tflite';
      lines.push(`⚠️ Vogelarten-Modell nicht gefunden. Bitte <code>${esc(p.split('/').pop())}</code> in <code>models/</code> ablegen.`);
    } else if(birdActive && cam0?.bird_species_available===false && cam0?.bird_species_reason){
      lines.push(`⚠️ Vogelarten-Klassifikation: ${esc(cam0.bird_species_reason)}`);
    }
    // Warn whenever the model is missing, even if the user hasn't enabled
    // wildlife yet — the missing-file hint is what tells them WHY enabling
    // does nothing useful right now.
    if(proc.wildlife_model_available===false){
      const p=proc.wildlife_model_path||'mobilenet_v2_1.0_224_quant.tflite';
      lines.push(`⚠️ Modell nicht gefunden: <code>${esc(p.split('/').pop())}</code> — bitte in <code>models/</code> ablegen.`);
    }
    hint.innerHTML=lines.join('<br>');
    hint.style.display=lines.length?'':'none';
  }
  // Coral device info from /api/system (async, non-blocking)
  _updateCoralDeviceInfo();
  _renderCoralPipelineTree();
  _populateCoralTestCameras();
  // Models list is now behind the Modelle sub-tab; load it lazily on
  // first open via toggleCoralTab, so hydrate doesn't spin up a request
  // users aren't looking at.
  // Hydrate media settings form
  const storageSec=state.config.storage||{};
  const rdVal=storageSec.retention_days||14;
  const rdEl=byId('ms_retention_days'); if(rdEl) rdEl.value=rdVal;
  const rdLbl=byId('ms_retention_days_val'); if(rdLbl) rdLbl.textContent=rdVal+' Tage';
  const acEl=byId('ms_auto_cleanup'); if(acEl) acEl.checked=!!storageSec.auto_cleanup_enabled;
}

async function updateSystemPanel(){
  const panel=byId('systemInfoPanel'); if(!panel) return;
  const storagePath=state.config?.storage?.root||'storage/';
  try{
    const s=await j('/api/system');
    const b=s.build||{};
    const commit=b.commit||'dev';
    const date=b.date||'—';
    const count=b.count||'—';
    // Letzter Neustart — the Flask process start time, NOT the build date.
    let restartShort='—';
    if(s.process_start){
      try{
        const d=new Date(s.process_start);
        const pad=n=>String(n).padStart(2,'0');
        restartShort=`${pad(d.getDate())}.${pad(d.getMonth()+1)}. ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }catch{}
    }
    const heroEl=byId('heroBuildInfo');
    if(heroEl){
      const url='https://github.com/premiumcola/cam-manager/commits/main/';
      const shortCommit=commit.length>7?commit.slice(0,7):commit;
      const countPart=(b.count&&b.count!=='—')?`<a href="${url}" target="_blank" class="hero-build-count">Build #${esc(String(b.count))}</a>`:`<span class="hero-build-count hero-build-count--dev">Build · dev</span>`;
      const commitPart=`<code class="hero-build-commit" title="Git commit">${esc(shortCommit)}</code>`;
      const restartPart=s.process_start?`<span class="hero-build-date" title="Letzter Neustart: ${esc(s.process_start)}">⟳ ${esc(restartShort)}</span>`:'';
      heroEl.innerHTML=`${countPart}<span class="hero-build-sep">·</span>${commitPart}${restartPart?`<span class="hero-build-sep">·</span>${restartPart}`:''}`;
    }
    const memUsed=s.mem_used_mb||0;
    const memTotal=s.mem_total_mb||0;
    const procMem=s.proc_mem_mb||0;
    const uptime=s.uptime_s||0;
    const uptimeStr=uptime>3600?`${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`:uptime>60?`${Math.floor(uptime/60)}m`:`${Math.round(uptime)}s`;
    const shortCommit=commit.length>7?commit.slice(0,7):commit;
    const publicUrl=state.config?.server?.public_base_url||'';
    const subnet=state.config?.default_discovery_subnet||'';
    panel.innerHTML=`
      <div class="app-info-block">
        <div class="app-info-section-title">Build &amp; System</div>
        <div class="app-info-row"><span class="app-info-row-label">Build</span><span class="app-info-row-val"><code>${esc(shortCommit)}</code> · ${esc(date)}</span></div>
        <div class="app-info-row"><span class="app-info-row-label">Commits</span><span class="app-info-row-val">${esc(String(count))}</span></div>
        ${s.process_start?`<div class="app-info-row"><span class="app-info-row-label">Letzter Neustart</span><span class="app-info-row-val" title="${esc(s.process_start)}">${esc(restartShort)}</span></div>`:''}
        ${uptime?`<div class="app-info-row"><span class="app-info-row-label">Container-Uptime</span><span class="app-info-row-val">${uptimeStr}</span></div>`:''}
        ${s.camera_count!==undefined?`<div class="app-info-row"><span class="app-info-row-label">Aktive Kameras</span><span class="app-info-row-val">${s.camera_count}</span></div>`:''}

        <div class="app-info-section-title">Ressourcen</div>
        ${procMem?`<div class="app-info-row"><span class="app-info-row-label">RAM (App)</span><span class="app-info-row-val">${procMem} MB</span></div>`:''}
        ${memTotal?`<div class="app-info-row"><span class="app-info-row-label">RAM (System)</span><span class="app-info-row-val">${memUsed} / ${memTotal} MB</span></div>`:''}
        <div class="app-info-row"><span class="app-info-row-label">Storage</span><span class="app-info-row-val"><code>${esc(storagePath)}</code></span></div>

        <div class="app-info-section-title">Netzwerk</div>
        <div class="app-info-row"><span class="app-info-row-label">Public Base URL</span><span class="app-info-row-val">${publicUrl?`<code>${esc(publicUrl)}</code>`:'—'}</span></div>
        <div class="app-info-row"><span class="app-info-row-label">Discovery-Subnet</span><span class="app-info-row-val">${subnet?`<code>${esc(subnet)}</code>`:'—'}</span></div>
      </div>`;
  }catch(e){/* silent — system info optional */}
}

// ── Telegram page hydrate & logic ─────────────────────────────────────────────

function hydrateTelegram(){
  const tg=state.config?.telegram||{};
  const el=byId('tg_enabled'); if(el) el.checked=!!tg.enabled;
  // Initial badge from config — immediately overwritten by the live polling
  // status fetch below, so the user sees the actual updater state, not just
  // the "enabled" flag.
  const tgBadge=byId('tgStatusBadge');
  if(tgBadge){tgBadge.textContent=tg.enabled?'aktiv':'aus';tgBadge.className='set-status-badge '+(tg.enabled?'set-status-badge--on':'set-status-badge--off');}
  const tok=byId('tg_token'); if(tok) tok.value=tg.token||'';
  const cid=byId('tg_chat_id'); if(cid) cid.value=tg.chat_id||'';
  const fmt=tg.format||'photo';
  document.querySelectorAll('[name="tg_format"]').forEach(r=>r.checked=r.value===fmt);
  renderTgFormatPreview(fmt);
  refreshTelegramPollingStatus();
}

let _tgPollStatusTimer=null;
async function refreshTelegramPollingStatus(){
  const badge=byId('tgStatusBadge'); if(!badge) return;
  try{
    const r=await fetch('/api/telegram/status');
    const d=await r.json();
    const s=d.state||'off';
    if(s==='active'){
      const mins=Math.floor((d.since_seconds||0)/60);
      const lbl=mins>0?`aktiv (seit ${mins} min)`:'aktiv';
      badge.textContent=lbl;
      badge.className='set-status-badge set-status-badge--on';
    }else if(s==='conflict'){
      badge.textContent='Conflict (Backoff)';
      badge.className='set-status-badge set-status-badge--warn';
    }else if(s==='starting'){
      badge.textContent='startet…';
      badge.className='set-status-badge set-status-badge--warn';
    }else{
      badge.textContent=d.enabled?'aus':'aus';
      badge.className='set-status-badge set-status-badge--off';
    }
  }catch(e){/* leave the existing badge alone on transient fetch errors */}
  clearTimeout(_tgPollStatusTimer);
  _tgPollStatusTimer=setTimeout(refreshTelegramPollingStatus, 10000);
}

function initCameraEditTabs(){
  const bar=document.querySelector('.cam-tab-bar'); if(!bar) return;
  // Reset to first tab
  bar.querySelectorAll('.cam-tab-btn').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.cam-tab-panel').forEach(p=>p.classList.remove('active'));
  const first=bar.querySelector('.cam-tab-btn[data-tab="cam-tab-allgemein"]');
  if(first) first.classList.add('active');
  const firstPanel=byId('cam-tab-allgemein'); if(firstPanel) firstPanel.classList.add('active');
  bar.querySelectorAll('.cam-tab-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      bar.querySelectorAll('.cam-tab-btn').forEach(b=>b.classList.remove('active'));
      document.querySelectorAll('.cam-tab-panel').forEach(p=>p.classList.remove('active'));
      btn.classList.add('active');
      const panel=byId(btn.dataset.tab); if(panel) panel.classList.add('active');
    });
  });
}
function initTelegramTabs(){
  const bar=document.querySelector('.tg-tab-bar'); if(!bar) return;
  const allPanels=['tg-panel-verbindung','tg-panel-wann','tg-panel-was','tg-panel-tree','tg-panel-presets'];
  bar.querySelectorAll('.set-tab').forEach(btn=>{
    btn.addEventListener('click',()=>{
      bar.querySelectorAll('.set-tab').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const target=btn.dataset.tab;
      allPanels.forEach(id=>{const p=byId(id); if(p) p.hidden=(id!==target);});
    });
  });
}

// ── Push-Settings UI (Phase 2) ───────────────────────────────────────────────

// Order in the "Was senden" list — matches the spec's reading order
// (Person first, animals + person before motion).
const _PUSH_LABEL_ORDER = ['person','squirrel','dog','car','cat','bird','motion'];

// Schema-default block — used by the "Standard"-Preset and as a fallback when
// the backend hasn't shipped the keys yet. Mirror of _TELEGRAM_PUSH_DEFAULTS
// in settings_store.py — keep the two in sync.
function _pushDefaults(){
  return {
    enabled:true, rate_limit_seconds:30,
    quiet_hours:{start:'22:00',end:'07:00'},
    night_alert:{enabled:true,armed_only:true,use_sun:true,lat:null,lon:null,start:'22:00',end:'07:00'},
    labels:{
      person:{push:true,threshold:0.85},
      cat:{push:false,threshold:0.80},
      dog:{push:true,threshold:0.80},
      bird:{push:false,threshold:0.90},
      car:{push:true,threshold:0.85},
      squirrel:{push:true,threshold:0.80},
      motion:{push:false,threshold:0.0},
    },
    daily_report:{enabled:true,time:'22:00'},
    highlight:{enabled:true,time:'19:00'},
    system:{enabled:true},
    timelapse:{enabled:true},
  };
}

// Pull current push config from loaded state with safe fallbacks.
function _pushCfg(){
  const tg = state.config?.telegram || {};
  // Deep merge defaults under user values so the UI never gets undefined.
  const def = _pushDefaults();
  const cur = tg.push || {};
  const merge = (d, c) => {
    const out = {...d};
    for (const k of Object.keys(c||{})) {
      if (c[k] && typeof c[k]==='object' && !Array.isArray(c[k]) && d[k] && typeof d[k]==='object') {
        out[k] = merge(d[k], c[k]);
      } else {
        out[k] = c[k];
      }
    }
    return out;
  };
  return merge(def, cur);
}

let _pushSaveTimer = null;
async function savePushCfg(partial){
  // Always send through telegram.push.* so the deep-merge in
  // SettingsStore.update_section preserves sibling keys.
  const payload = {telegram:{push:partial}};
  try{
    await fetch('/api/settings/app',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    // Reflect the change locally so the next read sees it without reloading.
    state.config = state.config || {};
    state.config.telegram = state.config.telegram || {};
    state.config.telegram.push = _mergeDeep(state.config.telegram.push||{}, partial);
  }catch(e){
    showToast('Speichern fehlgeschlagen.','error');
  }
}
function _mergeDeep(t,s){
  for (const k of Object.keys(s||{})){
    if(s[k] && typeof s[k]==='object' && !Array.isArray(s[k]) && t[k] && typeof t[k]==='object'){
      _mergeDeep(t[k], s[k]);
    } else { t[k] = s[k]; }
  }
  return t;
}
function _debouncedPushSave(partial, ms=600){
  // Coalesce slider drags into one save. The merged payload is rebuilt from
  // the form on every fire so the latest values win.
  clearTimeout(_pushSaveTimer);
  _pushSaveTimer = setTimeout(()=>savePushCfg(partial), ms);
}

function hydratePushUI(){
  const cfg = _pushCfg();
  // ── "Wann senden" ─────────────────────────────────────────────────────────
  const set = (id, prop, val) => { const el=byId(id); if(el) el[prop]=val; };
  set('push_enabled','checked', !!cfg.enabled);
  set('push_daily_enabled','checked', !!cfg.daily_report?.enabled);
  set('push_daily_time','value', cfg.daily_report?.time || '22:00');
  set('push_highlight_enabled','checked', !!cfg.highlight?.enabled);
  set('push_highlight_time','value', cfg.highlight?.time || '19:00');
  set('push_quiet_enabled','checked', !!cfg.quiet_hours?.start && !!cfg.quiet_hours?.end);
  set('push_quiet_start','value', cfg.quiet_hours?.start || '22:00');
  set('push_quiet_end','value', cfg.quiet_hours?.end || '07:00');
  set('push_night_enabled','checked', !!cfg.night_alert?.enabled);
  set('push_night_armed','checked', !!cfg.night_alert?.armed_only);
  const useSun = cfg.night_alert?.use_sun !== false;
  document.querySelectorAll('input[name="push_night_mode"]').forEach(r=>{
    r.checked = (r.value === (useSun ? 'sun' : 'time'));
  });
  set('push_night_start','value', cfg.night_alert?.start || '22:00');
  set('push_night_end','value', cfg.night_alert?.end || '07:00');
  _updatePushNightModeUI();

  // ── "Was senden" — labels list + bottom toggles ───────────────────────────
  _renderPushLabelsList(cfg.labels || {});
  set('push_timelapse_enabled','checked', !!cfg.timelapse?.enabled);
  set('push_system_enabled','checked', !!cfg.system?.enabled);

  // ── "Abhängigkeiten" ─────────────────────────────────────────────────────
  hydratePushDeps();
  if (!_pushDepsTimer) _pushDepsTimer = setInterval(hydratePushDeps, 30000);

  _bindPushHandlers();
}

let _pushDepsTimer = null;

function _renderPushLabelsList(labels){
  const wrap = byId('pushLabelsList'); if(!wrap) return;
  const colorMap = (typeof colors==='object') ? colors : {};
  const labelMap = (typeof OBJ_LABEL==='object') ? OBJ_LABEL : {};
  wrap.innerHTML = _PUSH_LABEL_ORDER.map(lbl=>{
    const l = labels[lbl] || {push:false, threshold:0.8};
    const color = colorMap[lbl] || '#5bc8f5';
    const name = labelMap[lbl] || lbl;
    const pct = Math.round((l.threshold||0) * 100);
    return `
      <div class="push-label-row" data-label="${esc(lbl)}">
        <span class="push-label-chip" style="background:${esc(color)}22;border:1px solid ${esc(color)}55;color:${esc(color)}">${esc(name)}</span>
        <label class="switch push-label-toggle"><input type="checkbox" ${l.push?'checked':''} data-push-toggle/><span class="slider"></span></label>
        <input type="range" class="push-label-slider" min="0.5" max="1.0" step="0.05" value="${l.threshold||0.8}" ${l.push?'':'disabled'} data-push-slider/>
        <span class="push-label-pct">${pct}%</span>
      </div>`;
  }).join('');
}

function _updatePushNightModeUI(){
  const useSun = document.querySelector('input[name="push_night_mode"][value="sun"]')?.checked;
  const sunInfo = byId('push_night_sun_info');
  const timeRow = byId('push_night_time_row');
  if(timeRow) timeRow.style.display = useSun ? 'none' : 'grid';
  if(!sunInfo) return;
  if(useSun){
    const cfg = _pushCfg();
    const lat = cfg.night_alert?.lat, lon = cfg.night_alert?.lon;
    if(lat==null || lon==null){
      sunInfo.innerHTML = '<span style="color:#ef4444">Standort in App &amp; Server festlegen, sonst fällt der Nacht-Alarm auf die feste Uhrzeit zurück.</span>';
    } else {
      sunInfo.textContent = `Standort gesetzt (lat ${lat}, lon ${lon}). Nacht-Erkennung über Sonnenstand (Civil Dusk = elev < −6°).`;
    }
  } else {
    sunInfo.textContent = '';
  }
}

function _bindPushHandlers(){
  // Top-level master switch
  byId('push_enabled')?.addEventListener('change', e => savePushCfg({enabled: e.target.checked}));
  // Daily / highlight: toggle + time
  for (const [id, key] of [['push_daily_enabled','daily_report'],['push_highlight_enabled','highlight']]){
    byId(id)?.addEventListener('change', e => savePushCfg({[key]:{enabled:e.target.checked}}));
  }
  byId('push_daily_time')?.addEventListener('change', e => savePushCfg({daily_report:{time:e.target.value}}));
  byId('push_highlight_time')?.addEventListener('change', e => savePushCfg({highlight:{time:e.target.value}}));
  // Quiet hours
  byId('push_quiet_enabled')?.addEventListener('change', e => {
    // "off" ≈ start==end. We simply leave start/end as-is and treat the toggle
    // as a UI cue; backend doesn't have a separate enabled flag. To actually
    // disable, blank out start/end (backend's is_quiet_now returns false).
    if(e.target.checked){
      savePushCfg({quiet_hours:{start:byId('push_quiet_start').value||'22:00', end:byId('push_quiet_end').value||'07:00'}});
    } else {
      savePushCfg({quiet_hours:{start:'00:00', end:'00:00'}});
    }
  });
  byId('push_quiet_start')?.addEventListener('change', e => savePushCfg({quiet_hours:{start:e.target.value}}));
  byId('push_quiet_end')?.addEventListener('change',   e => savePushCfg({quiet_hours:{end:e.target.value}}));
  // Night alert
  byId('push_night_enabled')?.addEventListener('change', e => savePushCfg({night_alert:{enabled:e.target.checked}}));
  byId('push_night_armed')?.addEventListener('change',   e => savePushCfg({night_alert:{armed_only:e.target.checked}}));
  document.querySelectorAll('input[name="push_night_mode"]').forEach(r=>{
    r.addEventListener('change', () => {
      const useSun = document.querySelector('input[name="push_night_mode"][value="sun"]').checked;
      savePushCfg({night_alert:{use_sun:useSun}});
      _updatePushNightModeUI();
    });
  });
  byId('push_night_start')?.addEventListener('change', e => savePushCfg({night_alert:{start:e.target.value}}));
  byId('push_night_end')?.addEventListener('change',   e => savePushCfg({night_alert:{end:e.target.value}}));
  // Per-label rows (delegated)
  byId('pushLabelsList')?.addEventListener('change', e => {
    const row = e.target.closest('.push-label-row'); if(!row) return;
    const lbl = row.dataset.label;
    if(e.target.matches('[data-push-toggle]')){
      const on = e.target.checked;
      // Enable/disable the slider visually + functionally.
      const slider = row.querySelector('[data-push-slider]'); if(slider) slider.disabled = !on;
      savePushCfg({labels:{[lbl]:{push:on}}});
    }
    if(e.target.matches('[data-push-slider]')){
      // Saved on input event below; this 'change' fires on release too.
    }
  });
  byId('pushLabelsList')?.addEventListener('input', e => {
    if(!e.target.matches('[data-push-slider]')) return;
    const row = e.target.closest('.push-label-row');
    const lbl = row.dataset.label;
    const v = parseFloat(e.target.value) || 0;
    const pctEl = row.querySelector('.push-label-pct');
    if(pctEl) pctEl.textContent = Math.round(v*100) + '%';
    _debouncedPushSave({labels:{[lbl]:{threshold:v}}});
  });
  // Bottom toggles
  byId('push_timelapse_enabled')?.addEventListener('change', e => savePushCfg({timelapse:{enabled:e.target.checked}}));
  byId('push_system_enabled')?.addEventListener('change',    e => savePushCfg({system:{enabled:e.target.checked}}));
  // Presets
  document.querySelectorAll('.push-preset-btn').forEach(btn=>{
    btn.addEventListener('click', async () => {
      if(!confirm('Aktuelle Push-Einstellungen überschreiben?')) return;
      const preset = btn.dataset.preset;
      const block = _buildPushPreset(preset);
      await savePushCfg(block);
      hydratePushUI();
      showToast('Preset angewendet.', 'success');
    });
  });
}

function _buildPushPreset(name){
  const def = _pushDefaults();
  if(name === 'standard') return def;
  if(name === 'quiet'){
    return {
      enabled:true, quiet_hours:{start:'22:00',end:'08:00'},
      highlight:{enabled:false},
      labels:{
        person:{push:true,threshold:0.90},
        car:{push:true,threshold:0.90},
        squirrel:{push:false,threshold:0.80},
        dog:{push:false,threshold:0.80},
        cat:{push:false,threshold:0.80},
        bird:{push:false,threshold:0.90},
        motion:{push:false,threshold:0.0},
      },
    };
  }
  if(name === 'all'){
    return {
      enabled:true, quiet_hours:{start:'00:00',end:'00:00'},
      labels:{
        person:{push:true,threshold:0.70},
        car:{push:true,threshold:0.70},
        squirrel:{push:true,threshold:0.70},
        dog:{push:true,threshold:0.70},
        cat:{push:true,threshold:0.70},
        bird:{push:true,threshold:0.70},
        motion:{push:false,threshold:0.0},
      },
    };
  }
  return def;
}

function hydratePushDeps(){
  const wrap = byId('pushDepsList'); if(!wrap) return;
  const tg = state.config?.telegram || {};
  const proc = state.config?.processing || {};
  const srv = state.config?.server || {};
  const cams = state.cameras || [];
  const someCoral = cams.some(c => c.coral_available);
  const someBird  = cams.some(c => c.bird_species_available);
  const hasLoc = !!(srv.location?.lat || (tg.push?.night_alert?.lat));
  const tgConn = !!(tg.enabled && tg.token && tg.chat_id);
  const rows = [
    [someCoral, 'Coral TPU aktiv',          'Wildlife-Erkennung verfügbar'],
    [someBird,  'iNaturalist-Modell vorhanden', 'Vogelarten-Klassifikation'],
    [hasLoc,    'Standort gesetzt',          'Sonnenstand-basierter Nacht-Alarm'],
    [tgConn,    'Telegram-Bot verbunden',    'Push-System sendet Nachrichten'],
  ];
  wrap.innerHTML = rows.map(([ok, title, desc]) => `
    <div class="push-dep-row">
      <span class="push-dep-dot ${ok?'ok':'off'}"></span>
      <div class="push-dep-text">
        <div class="push-dep-title">${esc(title)}</div>
        <div class="push-dep-desc">${esc(desc)}</div>
      </div>
    </div>
  `).join('');
}

function renderTgFormatPreview(fmt){
  const preview=byId('tgFormatPreview'); if(!preview) return;
  const cam=state.cameras?.[0];
  const ts=new Date().toLocaleString('de-DE',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  let html=`<div class="tg-bubble">
    <div class="tg-bubble-meta">🚨 motion, person · 📷 ${esc(cam?.name||'Kamera')} · 📍 Einfahrt · 🕒 ${ts}</div>`;
  if(fmt==='photo'||fmt==='video'){
    const snap=cam?.snapshot_url||'';
    html+=`<div class="tg-bubble-img">${snap?`<img src="${esc(snap)}" alt="snapshot"/>`:'<div class="tg-bubble-img-ph">📷 Snapshot</div>'}</div>`;
  }
  if(fmt==='video') html+=`<div class="tg-bubble-vid">🎬 Video-Clip angehängt (wenn verfügbar)</div>`;
  html+=`<div class="tg-bubble-btns">[ 📷 Live ] [ 🎥 Clip ] [ 🖥 Dashboard ]</div></div>`;
  preview.innerHTML=html;
}

byId('telegramForm')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const existingToken=state.config?.telegram?.token||'';
  const token=byId('tg_token')?.value||existingToken;
  const payload={telegram:{
    enabled:!!byId('tg_enabled')?.checked,
    token,
    chat_id:byId('tg_chat_id')?.value||'',
    format:(state.config?.telegram||{}).format||'photo',
  }};
  await fetch('/api/settings/app',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  showToast('Telegram-Verbindung gespeichert.','success');
  await loadAll();
});

document.querySelectorAll('[name="tg_format"]').forEach(r=>{
  r.addEventListener('change',()=>renderTgFormatPreview(r.value));
});

byId('saveTgFormatBtn')?.addEventListener('click',async()=>{
  const fmt=[...document.querySelectorAll('[name="tg_format"]')].find(r=>r.checked)?.value||'photo';
  const existing=state.config?.telegram||{};
  const payload={telegram:{...existing,format:fmt}};
  await fetch('/api/settings/app',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  showToast('Format gespeichert.','success');
  await loadAll();
});

function getCanvasCtx(){ return byId('maskCanvas').getContext('2d'); }
// If the snapshot fails (camera offline, no recent frame, etc.) we still
// want a usable drawing surface — set the canvas to a fixed 1280×720 gray
// placeholder so clicks are mapped to a real coordinate space and the
// user can draw zones blind.
function _maskCanvasFallback(){
  const canvas=byId('maskCanvas');
  if(!canvas) return;
  // No image loaded → no wrap aspect either. Set the wrap's aspect ratio
  // inline so the canvas (inset:0) gets a proportional CSS box. Without
  // this the wrap would collapse to min-height and the placeholder would
  // be unusable.
  canvas.width=1280; canvas.height=720;
  canvas.style.width=''; canvas.style.height='';
  const wrap=canvas.parentElement;
  if(wrap) wrap.style.aspectRatio='1280/720';
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='#222222';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle='#64748b';
  ctx.font='14px system-ui,sans-serif';
  ctx.textAlign='center';
  ctx.fillText('Snapshot nicht verfügbar — Zonen können trotzdem gezeichnet werden.', canvas.width/2, canvas.height/2);
  ctx.textAlign='left';
}
function loadMaskSnapshot(camId){
  if(!camId) return;
  const img=byId('maskSnapshot');
  if(!img) return;
  // Wire one-shot handlers so a failed load still leaves us with a
  // usable canvas instead of a 0×0 surface that swallows clicks.
  img.onload=()=>{
    // A real snapshot is back — drop any aspect-ratio lock left behind by
    // a previous fallback render so the wrap follows the image again.
    const wrap=byId('maskCanvas')?.parentElement;
    if(wrap) wrap.style.aspectRatio='';
    drawShapes();
    _logMaskCanvasReady(camId,'snapshot');
  };
  img.onerror=()=>{ _maskCanvasFallback(); drawShapes(); _logMaskCanvasReady(camId,'fallback'); };
  img.src=`/api/camera/${camId}/snapshot.jpg?t=${Date.now()}`;
}
function _logMaskCanvasReady(camId, source){
  const c=byId('maskCanvas');
  if(!c) return;
  console.log('[mask-editor] camera=%s source=%s canvas=%dx%d', camId, source, c.width, c.height);
}
function scaleForCanvas(el,img){
  // Internal canvas resolution = source resolution. canvasPoint() rescales
  // pointer events from CSS pixels (rect.width/height) to canvas pixels
  // (canvas.width/height) so polygon coordinates stay stable across any
  // display size. CSS handles the *display* sizing via inset:0 + the wrap's
  // natural-aspect height — no inline style.width/height needed here.
  const naturalW=img.naturalWidth||el.width||1280;
  const naturalH=img.naturalHeight||el.height||720;
  el.width=naturalW;
  el.height=naturalH;
  // Clear any stale inline styles set by previous fallback or resize logic
  // — let the CSS rule be authoritative again.
  el.style.width='';
  el.style.height='';
}
// Polygon shape: {points:[{x,y},...], label:"Zone 1"}. Raw arrays of
// points (legacy pre-label format) are still accepted — _polyPoints
// unwraps both shapes transparently.
function _polyPoints(p){ return Array.isArray(p)?p:(p?.points||[]); }
function _polyLabel(p,fallback){ return (p&&p.label)||fallback; }
function _nextPolyName(kind){
  const list = kind==='zone' ? (shapeState.zones||[]) : (shapeState.masks||[]);
  const base = kind==='zone' ? 'Zone' : 'Maske';
  const used = new Set();
  for(const p of list){
    const lbl = (p && p.label) || '';
    const m = lbl.match(new RegExp('^'+base+'\\s+(\\d+)$','i'));
    if(m) used.add(parseInt(m[1],10));
  }
  let n=1; while(used.has(n)) n++;
  return `${base} ${n}`;
}
function drawPoly(ctx,poly,color,fillAlpha,emphasised,kind,idx){
  const pts=_polyPoints(poly); if(!pts.length) return;
  ctx.beginPath(); ctx.moveTo(pts[0].x,pts[0].y);
  pts.slice(1).forEach(p=>ctx.lineTo(p.x,p.y));
  ctx.closePath();
  ctx.fillStyle=color.replace('1)', `${fillAlpha})`);
  ctx.strokeStyle=color;
  ctx.lineWidth=emphasised?5:3;
  ctx.fill(); ctx.stroke();
  // Vertex handles — filled circles in the polygon colour with a white
  // border. The currently-hovered vertex gets a larger radius so the user
  // sees what they're about to grab. The DRAW position is clamped to keep
  // the full circle inside the canvas; the underlying coordinate is left
  // alone, so hit-testing still uses the real point. With the canvas now
  // matching the image bounds 1:1, the clamp only kicks in for vertices
  // placed at the very edge — they shift inward by ≤r so the marker stays
  // fully visible instead of being half-clipped.
  const hov = shapeState.hoverVertex;
  const isHov = (j) => hov && hov.kind===kind && hov.polyIdx===idx && hov.ptIdx===j;
  const cw = ctx.canvas.width, chh = ctx.canvas.height;
  for(let j=0; j<pts.length; j++){
    const r = isHov(j) ? 13 : 10;
    const dx = Math.max(r, Math.min(cw - r, pts[j].x));
    const dy = Math.max(r, Math.min(chh - r, pts[j].y));
    ctx.beginPath();
    ctx.arc(dx, dy, r, 0, Math.PI*2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  if(poly && poly.label){
    const minX=Math.min(...pts.map(p=>p.x)), minY=Math.min(...pts.map(p=>p.y));
    const labelY=Math.max(20, minY);
    ctx.fillStyle='rgba(0,0,0,.6)';
    ctx.fillRect(minX, labelY-22, Math.max(70, poly.label.length*9), 20);
    ctx.fillStyle='#fff';
    ctx.font='600 13px system-ui,sans-serif';
    ctx.fillText(poly.label, minX+6, labelY-7);
    // Second badge below: which labels this polygon scopes (or "Alle").
    // Lets the user see at a glance whether a polygon is restricted.
    const lbls=_polyLabels(poly);
    const txt=lbls.length ? lbls.map(L=>{
      const o=_SHAPE_LABEL_OPTS.find(x=>x.k===L);
      return o?o.l:L;
    }).join(', ') : 'Alle Labels';
    ctx.font='500 11px system-ui,sans-serif';
    const w=Math.max(60, ctx.measureText(txt).width+12);
    ctx.fillStyle='rgba(0,0,0,.55)';
    ctx.fillRect(minX, labelY, w, 18);
    ctx.fillStyle=lbls.length?'#fbbf24':'rgba(255,255,255,.85)';
    ctx.fillText(txt, minX+6, labelY+13);
  }
}
function drawShapes(){
  const img=byId('maskSnapshot'), canvas=byId('maskCanvas');
  if(!canvas) return;
  // Only re-scale to the snapshot when it actually loaded; if the image
  // is missing or broken we keep the placeholder dims set by the fallback.
  const snapReady = img && img.src && img.complete && img.naturalWidth>0;
  if(snapReady) scaleForCanvas(canvas,img);
  const ctx=getCanvasCtx();
  if(snapReady){ ctx.clearRect(0,0,canvas.width,canvas.height); }
  // (when not ready, the gray placeholder already drawn by
  //  _maskCanvasFallback stays in the background)
  const pulseId=shapeState.pulse;
  (shapeState.zones||[]).forEach((p,i)=>drawPoly(ctx,p,'rgba(75,163,255,1)',0.17,pulseId===`zone:${i}`,'zone',i));
  (shapeState.masks||[]).forEach((p,i)=>drawPoly(ctx,p,'rgba(255,107,107,1)',0.18,pulseId===`mask:${i}`,'mask',i));
  if(shapeState.points.length){
    ctx.beginPath();
    ctx.moveTo(shapeState.points[0].x,shapeState.points[0].y);
    shapeState.points.slice(1).forEach(p=>ctx.lineTo(p.x,p.y));
    ctx.strokeStyle='#ffffff'; ctx.lineWidth=2;
    ctx.setLineDash([7,6]); ctx.stroke(); ctx.setLineDash([]);
    // In-progress vertex handles. The first point gets a pulsing ring
    // once we have ≥3 points so the user knows clicking it closes the
    // polygon. The pulse is driven by Date.now() — drawShapes is called
    // by the rAF loop in _ensureShapePulseRaf while we're in that state.
    const closable = shapeState.points.length >= 3;
    const cw = canvas.width, chh = canvas.height;
    const clamp = (v, r, max) => Math.max(r, Math.min(max - r, v));
    shapeState.points.forEach((p,i)=>{
      const r = 10;
      const dx = clamp(p.x, r, cw);
      const dy = clamp(p.y, r, chh);
      ctx.beginPath();
      ctx.arc(dx, dy, r, 0, Math.PI*2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
    if(closable){
      const first = shapeState.points[0];
      const t = (Date.now() % 1200) / 1200;            // 0..1 over 1.2s
      const phase = 0.5 - 0.5*Math.cos(t * Math.PI*2); // smooth 0..1..0
      const ringR = 16 + phase*8;                       // 16..24 px (max for clamp)
      const alpha = 0.7 - phase*0.5;                    // 0.7..0.2
      const cx = clamp(first.x, 24, cw);
      const cy = clamp(first.y, 24, chh);
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, Math.PI*2);
      ctx.strokeStyle = `rgba(34,197,94,${alpha.toFixed(2)})`;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    _ensureShapePulseRaf(closable);
  } else {
    _ensureShapePulseRaf(false);
  }
}
// rAF loop — runs only while a closable in-progress polygon is on screen.
// Redraws drawShapes() ~30 fps so the closing-point ring pulses smoothly.
let _shapePulseRaf = null;
function _ensureShapePulseRaf(active){
  if(active && !_shapePulseRaf){
    const tick = () => {
      // Stop if the editor closed or the in-progress polygon is gone.
      if(!shapeState.camera || (shapeState.points||[]).length < 3){
        _shapePulseRaf = null;
        return;
      }
      drawShapes();
      _shapePulseRaf = requestAnimationFrame(tick);
    };
    _shapePulseRaf = requestAnimationFrame(tick);
  } else if(!active && _shapePulseRaf){
    cancelAnimationFrame(_shapePulseRaf);
    _shapePulseRaf = null;
  }
}
function canvasPoint(evt){
  const canvas=byId('maskCanvas'); const rect=canvas.getBoundingClientRect();
  // Support both mouse and touch events. Touch coords live on .touches
  // (move/start) or .changedTouches (end).
  const src = (evt.touches && evt.touches[0]) || (evt.changedTouches && evt.changedTouches[0]) || evt;
  const x=(src.clientX-rect.left)*(canvas.width/rect.width);
  const y=(src.clientY-rect.top)*(canvas.height/rect.height);
  return {x:Math.round(x),y:Math.round(y)};
}
function saveShapesIntoForm(){
  const f=byId('cameraForm').elements;
  f['zones_json'].value=JSON.stringify(shapeState.zones||[]);
  f['masks_json'].value=JSON.stringify(shapeState.masks||[]);
}

// ── Shape-editor UI updaters (drawing bar, polygon list, mode buttons) ──
function _updateShapeDrawingBar(){
  const bar=byId('shapeDrawingBar'); if(!bar) return;
  const n=shapeState.points.length;
  bar.hidden = n===0;
  const count=byId('shapeDrawingCount');
  if(count){
    if(n<3) count.textContent=`${n} Punkt${n===1?'':'e'} gesetzt · Mindestens 3 für ein Polygon`;
    else count.textContent=`${n} Punkte gesetzt · Übernehmen möglich`;
  }
  const save=byId('saveShapeBtn'); if(save) save.disabled = n<3;
}
function _updateShapeModeButtons(){
  document.querySelectorAll('.shape-mode-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.mode===shapeState.mode);
  });
}
// Labels available for per-polygon scoping. Mirrors KNOWN_OBJECT_LABELS
// in schema.py — keep in sync if a new class joins the detector.
const _SHAPE_LABEL_OPTS=[
  {k:'person',   l:'Person'},
  {k:'cat',      l:'Katze'},
  {k:'bird',     l:'Vogel'},
  {k:'car',      l:'Auto'},
  {k:'dog',      l:'Hund'},
  {k:'squirrel', l:'Eichhörnchen'},
];
function _polyLabels(p){
  if(!p || typeof p!=='object') return [];
  return Array.isArray(p.labels) ? p.labels.slice() : [];
}
// Tracks which row's trigger options panel is currently expanded.
// Keyed as `${kind}:${idx}`. Auto-expands the row that gets selected via
// canvas click (see onUp in the editor).
shapeState.expandedRows = shapeState.expandedRows || new Set();
function _renderShapeList(){
  const host=byId('shapeList'); if(!host) return;
  const zones=shapeState.zones||[]; const masks=shapeState.masks||[];
  const clearRow=byId('shapeClearRow'); if(clearRow) clearRow.hidden = (zones.length+masks.length)===0;
  if(zones.length+masks.length===0){
    host.innerHTML='<div class="field-help" style="padding:8px 2px">Noch keine Polygone. Wähle oben einen Modus und klicke Punkte auf den Snapshot.</div>';
    return;
  }
  const row=(p,i,kind)=>{
    const pts=_polyPoints(p);
    const label=_polyLabel(p, kind==='zone'?`Zone ${i+1}`:`Maske ${i+1}`);
    const pulseKey=`${kind}:${i}`;
    const polyLabels=new Set(_polyLabels(p));
    const allOn=polyLabels.size===0;
    const expanded=shapeState.expandedRows.has(pulseKey);
    const checks=`<label class="shape-lbl-chip${allOn?' shape-lbl-chip--on':''}"><input type="checkbox" ${allOn?'checked':''} onclick="event.stopPropagation();_setShapeAllLabels('${kind}',${i},this.checked)"><span>Alle</span></label>`
      +_SHAPE_LABEL_OPTS.map(o=>{
        const on=polyLabels.has(o.k);
        return `<label class="shape-lbl-chip${on?' shape-lbl-chip--on':''}"><input type="checkbox" ${on?'checked':''} onclick="event.stopPropagation();_toggleShapeLabel('${kind}',${i},'${o.k}',this.checked)"><span>${o.l}</span></label>`;
      }).join('');
    // Trigger flags are zone-only: masks just exclude motion/detection so
    // there's nothing to trigger from. The chevron button is suppressed
    // for masks; the whole trigger panel block stays out of their markup.
    let triggerHtml='';
    if(kind==='zone'){
      const sp=p?.save_photo!==false;
      const sv=p?.save_video!==false;
      const st=p?.send_telegram!==false;
      triggerHtml=`<div class="shape-trig-row${expanded?' shape-trig-row--open':''}">
        <label class="shape-trig-chip${sp?' shape-trig-chip--on':''}"><input type="checkbox" ${sp?'checked':''} onclick="event.stopPropagation();_toggleShapeOption('${kind}',${i},'save_photo',this.checked)"><span>📸 Foto</span></label>
        <label class="shape-trig-chip${sv?' shape-trig-chip--on':''}"><input type="checkbox" ${sv?'checked':''} onclick="event.stopPropagation();_toggleShapeOption('${kind}',${i},'save_video',this.checked)"><span>🎥 Video</span></label>
        <label class="shape-trig-chip${st?' shape-trig-chip--on':''}"><input type="checkbox" ${st?'checked':''} onclick="event.stopPropagation();_toggleShapeOption('${kind}',${i},'send_telegram',this.checked)"><span>📨 Telegram</span></label>
      </div>`;
    }
    const chev = (kind==='zone')
      ? `<button type="button" class="shape-row-chev${expanded?' shape-row-chev--open':''}" title="Aufnahme-Optionen" onclick="event.stopPropagation();_toggleShapeExpanded('${kind}',${i})"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5,3 11,8 5,13"/></svg></button>`
      : '';
    return `<div class="shape-row${shapeState.pulse===pulseKey?' pulse':''}" data-kind="${kind}" data-idx="${i}" id="shapeRow_${kind}_${i}" onclick="_pulseShape('${kind}',${i})">
      <div class="shape-row-head">
        <span class="shape-row-dot shape-row-dot--${kind}"></span>
        <span class="shape-row-label">${esc(label)}</span>
        <span class="shape-row-count">${pts.length} Punkte</span>
        ${chev}
        <button type="button" class="shape-row-del" title="Löschen" onclick="event.stopPropagation();_deleteShape('${kind}',${i})"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,4 14,4"/><path d="M5 4V2h6v2"/><path d="M3 4l1 10h8l1-10"/></svg></button>
      </div>
      <div class="shape-lbl-row">${checks}</div>
      ${triggerHtml}
    </div>`;
  };
  host.innerHTML =
      zones.map((p,i)=>row(p,i,'zone')).join('')
    + masks.map((p,i)=>row(p,i,'mask')).join('');
}
window._toggleShapeExpanded=function(kind,idx){
  const key=`${kind}:${idx}`;
  if(shapeState.expandedRows.has(key)) shapeState.expandedRows.delete(key);
  else shapeState.expandedRows.add(key);
  _renderShapeList();
};
window._toggleShapeOption=function(kind,idx,key,on){
  const arr = kind==='zone' ? shapeState.zones : shapeState.masks;
  const poly = arr[idx]; if(!poly) return;
  poly[key]=!!on;
  saveShapesIntoForm(); _renderShapeList();
};
window._toggleShapeLabel=function(kind,idx,labelKey,on){
  const arr = kind==='zone' ? shapeState.zones : shapeState.masks;
  const poly = arr[idx]; if(!poly) return;
  const set=new Set(_polyLabels(poly));
  if(on) set.add(labelKey); else set.delete(labelKey);
  poly.labels=[...set];
  saveShapesIntoForm(); drawShapes(); _renderShapeList();
};
window._setShapeAllLabels=function(kind,idx,allOn){
  const arr = kind==='zone' ? shapeState.zones : shapeState.masks;
  const poly = arr[idx]; if(!poly) return;
  // "Alle" checked → empty labels list (= applies to every label, legacy
  // semantics). Unchecking it leaves the existing labels untouched.
  if(allOn) poly.labels=[];
  saveShapesIntoForm(); drawShapes(); _renderShapeList();
};
window._pulseShape=function(kind,idx){
  shapeState.pulse = shapeState.pulse===`${kind}:${idx}` ? null : `${kind}:${idx}`;
  drawShapes(); _renderShapeList();
};
window._deleteShape=function(kind,idx){
  const arr = kind==='zone' ? shapeState.zones : shapeState.masks;
  arr.splice(idx,1);
  if(shapeState.pulse===`${kind}:${idx}`) shapeState.pulse=null;
  saveShapesIntoForm(); drawShapes(); _renderShapeList();
};

function openWizard(){ byId('wizard').classList.remove('hidden'); showWizardStep(1); }
function closeWizard(){ byId('wizard').classList.add('hidden'); }
window.openWizard=openWizard;
function showWizardStep(step){ document.querySelectorAll('.wiz-step').forEach(n=>n.classList.toggle('active', Number(n.dataset.step)===step)); document.querySelectorAll('.wiz-tab').forEach(n=>n.classList.toggle('active', Number(n.dataset.step)===step)); byId('wizPrev').style.visibility=step===1?'hidden':'visible'; byId('wizNext').classList.toggle('hidden', step===4); byId('wizFinish').classList.toggle('hidden', step!==4); byId('wizard').dataset.step=step; }

async function finishWizard(){
  const camId=byId('wiz_cam_id').value.trim();
  const payload={
    app:{name:byId('wiz_app_name').value||'TAM-spy',tagline:byId('wiz_tagline').value||'',logo:byId('wiz_logo').value||'🐈‍⬛'},
    server:{default_discovery_subnet:byId('wiz_subnet').value||'192.168.1.0/24'},
    telegram:{enabled:byId('wiz_tg_enabled').checked,token:byId('wiz_tg_token').value||'',chat_id:byId('wiz_tg_chat_id').value||''},
    mqtt:{enabled:byId('wiz_mqtt_enabled').checked,host:byId('wiz_mqtt_host').value||'',port:Number(byId('wiz_mqtt_port').value||1883),username:byId('wiz_mqtt_username').value||'',password:byId('wiz_mqtt_password').value||'',base_topic:byId('wiz_mqtt_topic').value||'tam-spy'},
    cameras: camId ? [{id:camId,name:byId('wiz_cam_name').value||camId,manufacturer:byId('wiz_cam_manufacturer')?.value||'',model:byId('wiz_cam_model')?.value||'',location:byId('wiz_cam_location').value||'',rtsp_url:byId('wiz_cam_rtsp').value||'',snapshot_url:byId('wiz_cam_snapshot').value||'',enabled:true,armed:true,object_filter:['person','cat','bird'],timelapse:{enabled:false,fps:25},zones:[],masks:[],schedule:{enabled:false,start:'22:00',end:'06:00'},telegram_enabled:true,mqtt_enabled:true,whitelist_names:[]}] : []
  };
  await fetch('/api/wizard/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  closeWizard();
  await loadAll();
}

byId('reloadConfigBtn').onclick=()=>loadAll();

// Slider feedback is decoupled from the network: input events update
// state.tlHours, the label, and re-render the timeline against whatever
// data is already cached in state.timeline (instant). The actual fetch
// is debounced and cancellable so a fast drag spawns at most one
// in-flight request, and stale responses can never overwrite a newer
// selection (token check at resolution time).
let _tlFetchTimer=null;
let _tlFetchAbort=null;
let _tlFetchToken=0;
function _tlFetchTimeline(hours){
  if(_tlFetchAbort){try{_tlFetchAbort.abort();}catch{}}
  const ctrl=new AbortController();
  _tlFetchAbort=ctrl;
  const myToken=++_tlFetchToken;
  const url=`/api/timeline?hours=${hours}${state.label?`&label=${encodeURIComponent(state.label)}`:''}`;
  j(url,{signal:ctrl.signal}).then(data=>{
    if(myToken!==_tlFetchToken) return;
    if(state.tlHours!==hours) return;
    state.timeline=data;
    renderTimeline();
  }).catch(()=>{/* abort or error: keep current data */});
}
byId('tlRangeSlider').addEventListener('input',e=>{
  state.tlHours=parseInt(e.target.value);
  renderTimeline();
  clearTimeout(_tlFetchTimer);
  const hours=state.tlHours;
  _tlFetchTimer=setTimeout(()=>_tlFetchTimeline(hours),250);
});
byId('tlRangeSlider').addEventListener('change',e=>{
  state.tlHours=parseInt(e.target.value);
  clearTimeout(_tlFetchTimer);
  _tlFetchTimeline(state.tlHours);
});
// alias so discovery modal code still works
const RTSP_PATHS=RTSP_PATH_OPTS;

function closeDiscoveryModal(){
  byId('discoveryModal').classList.add('hidden');
  document.body.style.overflow='';
}
let _discoveryItems=[];
function _hostnameToId(h){return h.toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40);}
function _defaultRtspPath(x){
  const g=(x.guess||'').toLowerCase();
  if(g.includes('reolink')) return '/h264Preview_01_main';
  if(g.includes('hikvision')) return '/Streaming/Channels/101';
  if(g.includes('dahua')||g.includes('amcrest')) return '/cam/realmonitor?channel=1&subtype=0';
  return RTSP_PATH_OPTS[0].value;
}
function _renderDiscoveryResults(){
  const hideConfigured=!!byId('discoveryHideConfigured')?.checked;
  const pathOpts=RTSP_PATHS.map(p=>`<option value="${esc(p.value)}">${esc(p.label)}</option>`).join('');
  // Collect IPs that already belong to a configured camera. Source of truth
  // is the rtsp_url / snapshot_url hostname — we never mix in camera IDs
  // (those are slugs like "cam-werkstatt", not IPs, and only added noise
  // to the lookup set).
  const allConfigured=new Set();
  for(const list of [state.config?.cameras||[], state.cameras||[]]){
    for(const c of list){
      for(const k of ['rtsp_url','snapshot_url']){
        const raw=c?.[k];
        if(!raw) continue;
        try{
          const u=new URL(raw.replace(/^rtsp:/,'http:'));
          if(u.hostname) allConfigured.add(u.hostname);
        }catch{}
      }
    }
  }

  // Unchecked → show every found IP, including configured ones (they get a
  // green "✓ Bereits konfiguriert" badge but the card still renders).
  const visible=hideConfigured?_discoveryItems.filter(x=>!allConfigured.has(x.ip)):_discoveryItems.slice();
  const alreadyCount=_discoveryItems.filter(x=>allConfigured.has(x.ip)).length;

  // Hint shown when fewer than two candidates were found — covers the
  // common case where Reolink HTTP/RTSP/ONVIF was disabled in the camera
  // network settings.
  const reolinkHint=`<div class="field-help" style="margin-top:10px;padding:8px 10px;border-left:3px solid #38bdf8">
    <strong>Reolink:</strong> HTTP (80), RTSP (554), ONVIF (8000) müssen in den Kamera-Netzwerkeinstellungen aktiviert sein.
  </div>`;

  if(!visible.length){
    byId('discoveryResults').innerHTML=`<div class="item">Keine Kamera-Kandidaten${hideConfigured&&alreadyCount?' ('+alreadyCount+' bereits konfiguriert ausgeblendet)':''}</div>${reolinkHint}`;
    return;
  }
  const showFewHint=_discoveryItems.length<2;
  byId('discoveryResults').innerHTML=visible.map(x=>{
    const ports=(x.open_ports||[]).join(', ')||'—';
    const uid=x.ip.replace(/\./g,'_');
    const already=allConfigured.has(x.ip);
    const vendor=x.guess==='Unbekannte Kamera'?`Unbekannte Kamera (${x.ip})`:esc(x.guess||'Unbekannte Kamera');
    const computedId=x.hostname?_hostnameToId(x.hostname):'cam-'+x.ip.replace(/\./g,'-');
    const displayName=x.hostname?esc(x.hostname.charAt(0).toUpperCase()+x.hostname.slice(1)):'';
    const defaultPath=_defaultRtspPath(x);
    const pathOptsForCam=RTSP_PATHS.map(p=>`<option value="${esc(p.value)}"${p.value===defaultPath?' selected':''}>${esc(p.label)}</option>`).join('');
    const reolinkNote=x.reolink_hints?`<div class="field-help" style="padding:3px 6px;margin-top:2px">Reolink: H.264-Main für RLC-810A / ältere FW · H.265-Main für CX810 / neuere FW · Sub immer H.264</div>`:'';
    return `<div class="item" data-disc-ip="${esc(x.ip)}">
      <div class="item-head">
        <div>
          <strong>${esc(x.ip)}</strong>${x.hostname?` <span class="muted small">${esc(x.hostname)}</span>`:''}
          ${already?'<span class="badge good" style="margin-left:8px;font-size:11px">✓ Bereits konfiguriert</span>':''}
        </div>
        <span class="small muted">Ports: ${esc(ports)}</span>
      </div>
      <div class="small" style="color:${already?'var(--good)':'var(--muted)'};margin-bottom:6px">${vendor}</div>
      ${already?'':(`<div id="disc_form_wrap_${uid}">
        ${reolinkNote}
        <div class="discovery-creds">
          <input id="disc_user_${uid}" class="disc-input" placeholder="Benutzer" value="admin" />
          <input id="disc_pass_${uid}" class="disc-input" type="password" placeholder="Passwort" />
          <select id="disc_path_${uid}" class="disc-select">${pathOptsForCam}</select>
        </div>
        <div id="disc_add_form_${uid}" class="disc-add-form hidden">
          <div class="discovery-creds" style="margin-top:8px">
            <input id="disc_name_${uid}" class="disc-input" placeholder="${x.hostname?'Kameraname':esc(vendor)}" value="${displayName}" style="flex:1.5"/>
          </div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button class="btn-action accent" style="flex:1;min-height:40px" onclick="saveDiscoveryCamera('${esc(x.ip)}')"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3,8 7,12 13,4"/></svg> Kamera speichern</button>
            <button class="btn-action ghost" style="min-height:40px" onclick="byId('disc_add_form_${uid}').classList.add('hidden')">Abbrechen</button>
          </div>
        </div>
        <div style="margin-top:8px">
          <button class="btn-action action-green" style="width:100%" onclick="openDiscoveryAddForm('${esc(x.ip)}')"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="5" width="13" height="9" rx="2"/><path d="M5.5 5L6.5 3h3l1 2"/><circle cx="8" cy="9.5" r="2.2"/><line x1="8" y1="8.2" x2="8" y2="10.8"/><line x1="6.7" y1="9.5" x2="9.3" y2="9.5"/></svg> Kamera hinzufügen</button>
        </div>
      </div>`)}
    </div>`;
  }).join('');
  if(showFewHint){
    byId('discoveryResults').insertAdjacentHTML('beforeend',reolinkHint);
  }
}

byId('discoverBtn')?.addEventListener('click',async()=>{
  byId('discoveryModal').classList.remove('hidden');
  document.body.style.overflow='hidden';
  byId('discoveryStatus').textContent='Suche läuft …';
  byId('discoveryResults').innerHTML='';
  _discoveryItems=[];
  try{
    const r=await j('/api/discover');
    _discoveryItems=r.results||[];
    const total=r.total_scanned||'?';
    const found=_discoveryItems.length;
    byId('discoveryStatus').innerHTML=`Subnetz <strong>${esc(r.subnet)}</strong> · ${total} Hosts · <strong>Gefundene Geräte (${found})</strong>`;
    _renderDiscoveryResults();
  }catch(err){
    byId('discoveryStatus').textContent='Discovery fehlgeschlagen';
    byId('discoveryResults').innerHTML=`<div class="item">${esc(err.message||err)}</div>`;
  }
});
byId('discoveryHideConfigured')?.addEventListener('change',_renderDiscoveryResults);
byId('closeDiscoveryBtn').onclick=()=>closeDiscoveryModal();
byId('discoveryModal').onclick=(e)=>{if(e.target===byId('discoveryModal')) closeDiscoveryModal();};
byId('openWizardBtn').onclick=()=>openWizard();
window.openDiscoveryAddForm=(ip)=>{
  const uid=ip.replace(/\./g,'_');
  byId(`disc_add_form_${uid}`)?.classList.remove('hidden');
};
window.saveDiscoveryCamera=async(ip)=>{
  const uid=ip.replace(/\./g,'_');
  const user=byId(`disc_user_${uid}`)?.value||'admin';
  const pass=byId(`disc_pass_${uid}`)?.value||'';
  const path=byId(`disc_path_${uid}`)?.value||'/Streaming/Channels/101';
  const name=byId(`disc_name_${uid}`)?.value||ip;
  const rtsp=`rtsp://${user}:${_rtspEnc(pass)}@${ip}:554${path}`;
  const snap=`http://${user}:${_rtspEnc(pass)}@${ip}/cgi-bin/snapshot.cgi`;
  const _item=_discoveryItems.find(x=>x.ip===ip);
  const camId=_item?.hostname?_hostnameToId(_item.hostname):'cam-'+ip.replace(/\./g,'-');
  const payload={id:camId,name,location:'',rtsp_url:rtsp,snapshot_url:snap,
    enabled:true,armed:true,
    object_filter:['person','cat','bird'],
    timelapse:{enabled:false,fps:25},zones:[],masks:[],
    schedule:{enabled:false,start:'22:00',end:'06:00'},
    telegram_enabled:true,mqtt_enabled:true,whitelist_names:[]};
  try{
    await j('/api/settings/cameras',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    closeDiscoveryModal();
    await loadAll();
  }catch(e){showToast('Fehler beim Speichern: '+e.message,'error');}
};
// Legacy alias – wizard still uses this
window.applyDiscoveryRtsp=(ip)=>{
  const uid=ip.replace(/\./g,'_');
  const user=byId(`disc_user_${uid}`)?.value||'admin';
  const pass=byId(`disc_pass_${uid}`)?.value||'';
  const path=byId(`disc_path_${uid}`)?.value||'/Streaming/Channels/101';
  const rtsp=`rtsp://${user}:${_rtspEnc(pass)}@${ip}:554${path}`;
  const snap=`http://${user}:${_rtspEnc(pass)}@${ip}/cgi-bin/snapshot.cgi`;
  const wizRtsp=byId('wiz_cam_rtsp'); if(wizRtsp) wizRtsp.value=rtsp;
  const wizSnap=byId('wiz_cam_snapshot'); if(wizSnap) wizSnap.value=snap;
  closeDiscoveryModal();
};
byId('cameraForm').onsubmit=async(e)=>{
  e.preventDefault(); const f=e.target.elements;
  // Resolve masked URL inputs back to their real values before we read
  // .value into the payload, otherwise we'd persist dot-masked URLs.
  _unmaskUrlsForSubmit(e.target);
  const existingCam=(state.cameras||[]).find(x=>x.id===f['id'].value);
  const payload={id:f['id'].value,name:f['name'].value,
    manufacturer:f['manufacturer']?.value||'',
    model:f['model']?.value||'',
    icon:f['icon']?.value||getCameraIcon(f['name'].value),
    rtsp_url:f['rtsp_url'].value,snapshot_url:f['snapshot_url'].value,
    username:f['rtsp_user']?.value||'',password:f['rtsp_pass']?.value||'',
    object_filter:f['object_filter'].value.split(',').map(x=>x.trim()).filter(Boolean),
    enabled:f['enabled']?f['enabled'].checked:(existingCam?.enabled??true),
    armed:f['armed'].checked,
    // Prefer the live Alerting tab toggle state; fall back to persisted value.
    telegram_enabled:f['telegram_enabled']?f['telegram_enabled'].checked:(existingCam?.telegram_enabled??true),
    mqtt_enabled:f['mqtt_enabled']?f['mqtt_enabled'].checked:(existingCam?.mqtt_enabled??true),
    whitelist_names:_whitelistState.filter(Boolean),
    timelapse:existingCam?.timelapse||{enabled:false,fps:25,period:'day',daily_target_seconds:60,weekly_target_seconds:180,telegram_send:false},
    // Two independent schedules — schedule_notify gates Telegram/MQTT,
    // schedule_record gates the on-disk archive. The legacy `schedule`
    // dict is kept in sync below as a derived bridge field so back-end
    // gating that still reads it (commit 3 retires those reads) keeps
    // working through the cutover.
    schedule_notify: {
      enabled: !!f['schedule_notify_enabled']?.checked,
      from:    f['schedule_notify_from']?.value || '21:00',
      to:      f['schedule_notify_to']?.value   || '06:00',
    },
    schedule_record: {
      enabled: !!f['schedule_record_enabled']?.checked,
      from:    f['schedule_record_from']?.value || '00:00',
      to:      f['schedule_record_to']?.value   || '23:59',
    },
    // Legacy bridge — derive from the new fields for back-compat. The
    // 4-action shape (record/telegram/hard) collapses into the new
    // two-schedule split as: telegram = schedule_notify, record =
    // schedule_record, hard = always true (now driven by class_severity
    // alarm rows). enabled = OR of the two so any active window keeps
    // the legacy gate live.
    schedule: (() => {
      const n = !!f['schedule_notify_enabled']?.checked;
      const r = !!f['schedule_record_enabled']?.checked;
      // Use the notify window when notify is on, otherwise the record
      // window — preserves the most-restrictive bound back-compat
      // checks would have applied.
      const useNotify = n || !r;
      return {
        enabled: n || r,
        from: useNotify ? (f['schedule_notify_from']?.value || '21:00') : (f['schedule_record_from']?.value || '00:00'),
        to:   useNotify ? (f['schedule_notify_to']?.value   || '06:00') : (f['schedule_record_to']?.value   || '23:59'),
        actions: { record: r || !n, telegram: n || !r, hard: true },
      };
    })(),
    // Per-class severity matrix — replaces alarm_profile as the source
    // of truth. Legacy alarm_profile is preserved via existingCam
    // fallback below so older code paths that still read it (e.g. the
    // class_severity migration on subsequent loads) keep working.
    class_severity: _collectClassSeverity(e.target),
    recording_enabled: f['recording_enabled'] ? !!f['recording_enabled'].checked : (existingCam?.recording_enabled !== false),
    // Per-class notification cooldown (seconds). Empty when the
    // drilldown was never opened — runtime falls back to
    // _NOTIFY_COOLDOWN_DEFAULTS in that case so behaviour is
    // unchanged.
    notification_cooldown: _collectAlertCooldown(e.target),
    // Fields whose UI was removed in the Erkennung-tab refactor — fall
    // back to the camera's currently-stored value so a save doesn't
    // silently flip them to the schema default. Schema defaults still
    // apply for fresh cameras (existingCam is undefined → "" / 0 / etc.
    // → backend coerces to schema default).
    bottom_crop_px:parseInt(f['bottom_crop_px']?.value ?? existingCam?.bottom_crop_px ?? 0),
    motion_sensitivity:parseFloat(f['motion_sensitivity']?.value||0.5),
    wildlife_motion_sensitivity:parseFloat(f['wildlife_motion_sensitivity']?.value ?? existingCam?.wildlife_motion_sensitivity ?? 0),
    motion_enabled:f['motion_enabled']?f['motion_enabled'].checked:(existingCam?.motion_enabled!==false),
    detection_trigger:f['detection_trigger']?.value||existingCam?.detection_trigger||'motion_and_objects',
    post_motion_tail_s:parseFloat(f['post_motion_tail_s']?.value||0),
    // alarm_profile is now a hidden bridge field — its value is the
    // camera's previously-stored value (set by editCamera). Persist
    // unchanged so the class_severity migration on next load still
    // sees the same source if needed.
    alarm_profile: f['alarm_profile']?.value || existingCam?.alarm_profile || 'soft',
    detection_min_score:parseFloat(f['detection_min_score']?.value||0),
    label_thresholds: _collectLabelThresholds(e.target),
    confirmation_window: _collectConfirmationWindow(e.target, existingCam),
    resolution:f['resolution']?.value||existingCam?.resolution||'auto',
    frame_interval_ms:parseInt(f['frame_interval_ms']?.value||350),
    snapshot_interval_s:parseInt(f['snapshot_interval_s']?.value ?? existingCam?.snapshot_interval_s ?? 3),
    zones:JSON.parse(f['zones_json'].value||'[]'),masks:JSON.parse(f['masks_json'].value||'[]')};
  const _savedId=payload.id; _restoreEditWrapper();
  // Backend rebuilds the canonical id when manufacturer/model/name/rtsp_url
  // change (storage_migration). Read the response so we re-open the panel
  // under the NEW id rather than the stale one we sent.
  let _newId=_savedId, _renamed=false, _autoDetected=[];
  try{
    const r=await fetch('/api/settings/cameras',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(r.ok){
      const d=await r.json();
      if(d&&d.id){ _newId=d.id; _renamed=!!d.id_renamed_from; }
      if(Array.isArray(d?.auto_detected)) _autoDetected=d.auto_detected;
    }
  }catch(_){/* fall back to old id */}
  await loadAll();
  if(_renamed) showToast('Kamera-ID aktualisiert · '+_newId,'success');
  editCamera(_newId);
  // After editCamera re-renders the form, surface "automatisch erkannt"
  // hints for the fields the backend filled via Reolink GetDevInfo on
  // this save. Hint hides itself on the next manual input.
  if(_autoDetected.length) _markAutoDetectedFields(_autoDetected);
};

// Show the "automatisch erkannt" hint under each named field, then wire
// it to clear on the next user edit. Called by the cam-edit save flow
// when /api/settings/cameras returns auto_detected: ['manufacturer', …].
function _markAutoDetectedFields(fields){
  const form=byId('cameraForm'); if(!form) return;
  for(const name of fields){
    const hint=form.querySelector(`.cam-autodetected-hint[data-for="${name}"]`);
    if(!hint) continue;
    hint.hidden=false;
    const input=form.elements[name];
    if(!input) continue;
    const clear=()=>{ hint.hidden=true; input.removeEventListener('input',clear); };
    input.addEventListener('input',clear);
  }
}

// Manual rescan via Reolink GetDevInfo. Confirms before overwriting
// existing manuf/model values; updates the form fields in place when
// confirmed. Touch target stays at 44 px even during the busy state.
function _bindCamProbeDeviceInfo(){
  const btn=byId('camProbeDeviceInfo'); if(!btn || btn.dataset.wired) return;
  btn.dataset.wired='1';
  btn.addEventListener('click', async ()=>{
    const f=byId('cameraForm')?.elements; if(!f) return;
    const camId=f['id']?.value; if(!camId) return;
    btn.classList.add('is-busy');
    let d=null, ok=false;
    try{
      const r=await fetch(`/api/cameras/${encodeURIComponent(camId)}/probe-device-info`,{method:'POST'});
      d=await r.json().catch(()=>null);
      ok=r.ok && d && d.ok;
    }catch(_){ /* network — handled below */ }
    btn.classList.remove('is-busy');
    if(!ok){
      const msg=(d&&d.error)?d.error:'Erkennung fehlgeschlagen';
      showToast('Erkennung fehlgeschlagen · '+msg,'error');
      return;
    }
    const cur=d.current||{};
    const same=(cur.manufacturer===d.manufacturer)&&(cur.model===d.model);
    if(same){
      showToast(`Bereits aktuell: ${d.manufacturer} ${d.model}`,'info');
      return;
    }
    if(cur.manufacturer || cur.model){
      const msg=`Mit erkanntem Wert überschreiben?\n\n`+
                `Aktuell: '${cur.manufacturer||'—'}' / '${cur.model||'—'}'\n`+
                `Neu: '${d.manufacturer}' / '${d.model}'`;
      if(!confirm(msg)) return;
    }
    if(f['manufacturer']){ f['manufacturer'].value=d.manufacturer; f['manufacturer'].dispatchEvent(new Event('input',{bubbles:true})); }
    if(f['model']){ f['model'].value=d.model; f['model'].dispatchEvent(new Event('input',{bubbles:true})); }
    showToast(`Erkannt: ${d.manufacturer} ${d.model}`,'success');
  });
}
byId('closeCameraEdit')?.addEventListener('click',()=>_closeEditPanel());
// ── Section-level save functions ──────────────────────────────────────────────
window.saveMqttSettings=async function(){
  const existingPass=(state.config?.mqtt?.password||'');
  const payload={
    mqtt:{
      enabled:byId('mqtt_enabled')?.checked||false,
      host:byId('mqtt_host')?.value||'',
      port:Number(byId('mqtt_port')?.value||1883),
      username:byId('mqtt_username')?.value||'',
      password:byId('mqtt_password')?.value||existingPass,
      base_topic:byId('mqtt_base_topic')?.value||'tam-spy'
    }
  };
  await fetch('/api/settings/app',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  showToast('MQTT gespeichert · Verbindungen werden neu gestartet.','success');
  await loadAll();
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
    out.innerHTML=imgBlock+reasonRow+usbRow+errRow;
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
// Category metadata — headings shown for each group of models.
const _MODEL_CATEGORIES=[
  {id:'detection',    title:'Objekt-Erkennung (COCO)',           desc:'Erkennt 80 Alltagsobjekte: Personen, Autos, Vögel, Katzen, Hunde etc.'},
  {id:'bird_species', title:'Vogelarten-Klassifikation (iNaturalist)', desc:'Bestimmt ~960 Vogelarten weltweit. Läuft als zweite Stufe nach COCO-Erkennung.'},
  {id:'wildlife',     title:'Wildtier-Erkennung (ImageNet)',     desc:'1000 ImageNet-Klassen inkl. Eichhörnchen, Fuchs, Igel, Reh. Zweite Stufe für Tiere außerhalb COCO.'},
  {id:'other',        title:'Sonstige Modelle',                  desc:'Eigene .tflite-Modelle, die keiner der obigen Kategorien zuzuordnen sind.'},
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
      html+=`<div class="mcat"><div class="mcat-head">${esc(cat.title)}</div><div class="mcat-desc">${esc(cat.desc)}</div>`;
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
        const labelPill=labelInfo.filename
          ? (labelInfo.exists
              ? `<span class="mpair-labels" title="${esc(labelInfo.path||'')}">Labels: ${esc(labelInfo.filename)}${labelInfo.count?` (${labelInfo.count} Einträge)`:''}</span>`
              : `<span class="mpair-labels mpair-labels--missing">⚠ Labels fehlen: ${esc(labelInfo.filename)}</span>`)
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
        // Title row: model stem + description
        const anyVar=cpu||tpu;
        html+=`<div class="mpair">
          <div class="mpair-head">
            <span class="mpair-name" title="${esc(anyVar.filename)}">${esc(stem)}</span>
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
            showToast('Modell aktiviert · Coral wird neu gestartet','success');
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
// ── Camera card placeholders ─────────────────────────────────────────────────
// Two states share a full-bleed monitoring-UI look: grid pattern, four corner
// brackets, state-specific animation in the centre. The surrounding card
// overlays (name, pills, etc.) are hidden by the renderer when offline, so
// the placeholder owns the full frame without duplicate chrome.
function _placeholderShell(accent, centerHtml, bracketKeyframe){
  // Opposite corners get slightly different stroke widths (2.5 / 2) so the
  // bracket set reads as a deliberate asymmetric viewfinder instead of a
  // perfectly uniform rectangle. 30-unit arms on a 100-unit viewBox.
  return `<div class="cv-ph cv-ph--${accent}">
    <div class="cv-ph-grid"></div>
    <svg class="cv-ph-brackets" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <g fill="none" style="animation:${bracketKeyframe} 2s ease-in-out infinite">
        <polyline points="0,30 0,0 30,0"  stroke-width="2.5" class="cv-ph-br cv-ph-br--tl"/>
        <polyline points="70,0 100,0 100,30" stroke-width="2"   class="cv-ph-br cv-ph-br--tr" style="animation-delay:.5s"/>
        <polyline points="100,70 100,100 70,100" stroke-width="2.5" class="cv-ph-br cv-ph-br--br" style="animation-delay:1s"/>
        <polyline points="30,100 0,100 0,70"    stroke-width="2"   class="cv-ph-br cv-ph-br--bl" style="animation-delay:1.5s"/>
      </g>
    </svg>
    <div class="cv-ph-center">${centerHtml}</div>
  </div>`;
}

// Structured SVG so the camera body, viewfinder cone, lens circle and strike
// line each carry their own opacity/stroke — the old single-path Feather
// icon had everything at one alpha and fell apart visually at small sizes.
const _CAM_OFF_SVG=`<svg viewBox="0 0 48 48" width="72" height="72" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block">
  <rect x="8" y="14" width="24" height="20" rx="2.5" stroke="rgba(255,255,255,0.35)" stroke-width="2"/>
  <path d="M32 20 L40 14 V34 L32 28 Z" stroke="rgba(255,255,255,0.35)" stroke-width="2"/>
  <circle cx="20" cy="24" r="4.5" stroke="rgba(255,255,255,0.25)" stroke-width="1.5"/>
  <line x1="4" y1="4" x2="44" y2="44" stroke="rgba(239,68,68,0.55)" stroke-width="2.5"/>
</svg>`;
const _CAM_SM_SVG=`<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="rgba(59,130,246,0.5)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:block">
  <rect x="8" y="14" width="24" height="20" rx="2.5"/>
  <path d="M32 20 L40 14 V34 L32 28 Z"/>
  <circle cx="20" cy="24" r="5"/>
</svg>`;

function _makeOfflinePlaceholder(){
  // Red: four expanding rings + crosshair + struck-through camera icon.
  // All three visual layers (rings, crosshair, icon) live in .cv-ph-stage
  // so they truly share one center regardless of container aspect ratio.
  const rings=[0, 1, 2, 3].map(i=>
    `<span class="cv-ph-ring" style="animation-delay:${i}s"></span>`
  ).join('');
  const center=`
    <div class="cv-ph-stage">
      <div class="cv-ph-crosshair"></div>
      ${rings}
      <div class="cv-ph-icon cv-ph-icon--glitch cv-ph-icon--red">${_CAM_OFF_SVG}</div>
    </div>
    <div class="cv-ph-label cv-ph-label--flicker cv-ph-label--red">KEIN SIGNAL</div>
  `;
  return _placeholderShell('red', center, 'bracketPulseRed');
}

function _makeConnectingPlaceholder(){
  // Blue: rotating radar cone + orbiting dots + small camera icon, all
  // inside the same stage so they share one center.
  const center=`
    <div class="cv-ph-stage">
      <svg class="cv-ph-guides" viewBox="-100 -100 200 200" aria-hidden="true">
        <circle cx="0" cy="0" r="30" fill="none" stroke="rgba(59,130,246,0.1)" stroke-width="1"/>
        <circle cx="0" cy="0" r="55" fill="none" stroke="rgba(59,130,246,0.1)" stroke-width="1"/>
        <circle cx="0" cy="0" r="80" fill="none" stroke="rgba(59,130,246,0.1)" stroke-width="1"/>
      </svg>
      <svg class="cv-ph-radar" viewBox="-100 -100 200 200" aria-hidden="true">
        <path d="M0,0 L85,-49 A98,98 0 0 1 85,49 Z" fill="rgba(59,130,246,0.12)"/>
        <line x1="0" y1="0" x2="85" y2="49" stroke="rgba(59,130,246,0.5)" stroke-width="1.5"/>
        <circle cx="85" cy="49" r="3" fill="rgba(59,130,246,0.9)"/>
      </svg>
      <span class="cv-ph-orbit cv-ph-orbit--1"></span>
      <span class="cv-ph-orbit cv-ph-orbit--2"></span>
      <span class="cv-ph-orbit cv-ph-orbit--3"></span>
      <div class="cv-ph-icon">${_CAM_SM_SVG}</div>
    </div>
    <div class="cv-ph-label cv-ph-label--blue">VERBINDE…</div>
  `;
  return _placeholderShell('blue', center, 'bracketPulseBlue');
}

function _restorePlaceholder(card){
  const placeholder=card.querySelector('.cv-loading-placeholder');
  if(placeholder) placeholder.innerHTML=_makeOfflinePlaceholder();
  const img=card.querySelector('.cv-img');
  if(img){const base=img.src.split('?')[0];img.src=base+'?t='+Date.now();}
}
function showCameraReloadAnimation(camId){
  const cameraCards=byId('cameraCards');
  const cards=camId
    ?[cameraCards?.querySelector(`[data-camid="${CSS.escape(camId)}"]`)]
    :[...(cameraCards?.querySelectorAll('[data-camid]')||[])];
  cards.filter(Boolean).forEach(card=>{
    const placeholder=card.querySelector('.cv-loading-placeholder');
    const img=card.querySelector('.cv-img');
    if(placeholder && !placeholder.querySelector('.cv-ph--blue'))
      placeholder.innerHTML=_makeConnectingPlaceholder();
    if(img){img.classList.remove('loaded');img.style.opacity='0';}
    const targetCamId=card.dataset.camid;
    let attempts=0;
    const poll=setInterval(async()=>{
      attempts++;
      if(attempts>15){clearInterval(poll);_restorePlaceholder(card);return;}
      try{
        const r=await j('/api/cameras');
        const cam=(r.cameras||[]).find(c=>c.id===targetCamId);
        if(cam?.status==='active'){
          clearInterval(poll);
          // Full re-render so the cv-tr / cv-br overlay nodes appear in the
          // DOM — they weren't rendered while the camera was offline and
          // simply toggling their parent's class wouldn't add them back.
          state.cameras=r.cameras||state.cameras;
          renderDashboard();
        }
      }catch{}
    },2000);
  });
}
async function reloadCamera(camId){
  // DIAG:cam-edit-lock — log entry/exit so we can see whether the POST
  // returns at all and at what wall-clock moment the cam-edit lock is
  // first observed.
  _erkDebugSet(`reloadCamera(${camId}) start`);
  showCameraReloadAnimation(camId);
  await fetch(`/api/camera/${encodeURIComponent(camId)}/reload`,{method:'POST'}).catch(()=>{});
  _erkDebugSet(`reloadCamera(${camId}) POST done`);  // DIAG:cam-edit-lock
}
window.reloadCamera=reloadCamera;

byId('exportJsonBtn').onclick=()=>download('/api/settings/export?format=json');
byId('exportYamlBtn').onclick=()=>download('/api/settings/export?format=yaml');
byId('clearImportBtn').onclick=()=>{byId('importBox').value='';};
byId('importJsonBtn').onclick=async()=>{await importConfig('json');};
byId('importYamlBtn').onclick=async()=>{await importConfig('yaml');};
async function importConfig(format){ const content=byId('importBox').value.trim(); if(!content){showToast('Bitte Inhalt einfügen.','warn');return;} const r=await j('/api/settings/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({format,content})}); byId('importBox').value=''; await loadAll(); showToast('Import erfolgreich.','success'); }

// ── Timelapse Settings ────────────────────────────────────────────────────────
const _TL_PROFILES_DEF=[
  {key:'daily',     label:'Täglich',          defaultPeriod:86400,    defaultTarget:60,  minTarget:10, maxTarget:180,  step:5},
  {key:'weekly',    label:'Wöchentlich',       defaultPeriod:604800,   defaultTarget:120, minTarget:30, maxTarget:360,  step:10},
  {key:'monthly',   label:'Monatlich',         defaultPeriod:2592000,  defaultTarget:300, minTarget:60, maxTarget:600,  step:15},
  {key:'quarterly', label:'Quartal',           defaultPeriod:7776000,  defaultTarget:600, minTarget:120,maxTarget:1800, step:30},
  {key:'yearly',    label:'Jährlich',          defaultPeriod:31536000, defaultTarget:900, minTarget:300,maxTarget:2700, step:60},
  {key:'custom',    label:'Benutzerdefiniert', defaultPeriod:3600,     defaultTarget:30,  minTarget:10, maxTarget:2700, step:10},
];
const _TL_PERIOD_OPTIONS=[
  {v:900,      l:'15 Min'},
  {v:3600,     l:'1 Stunde'},
  {v:21600,    l:'6 Stunden'},
  {v:43200,    l:'12 Stunden'},
  {v:86400,    l:'1 Tag'},
  {v:259200,   l:'3 Tage'},
  {v:604800,   l:'1 Woche'},
  {v:1209600,  l:'2 Wochen'},
  {v:2592000,  l:'1 Monat'},
  {v:7776000,  l:'1 Quartal'},
  {v:31536000, l:'1 Jahr'},
];
// Period+target presets for the "Benutzerdefiniert" profile — the user picks
// one tuple rather than two independent controls. Value is "<periodS>,<targetS>".
const _TL_CUSTOM_PRESETS=[
  {period:900,   target:60,  label:'15 Min → 1 Min Video'},
  {period:1800,  target:60,  label:'30 Min → 1 Min Video'},
  {period:3600,  target:30,  label:'1 Std → 30 Sek Video'},
  {period:3600,  target:60,  label:'1 Std → 1 Min Video'},
  {period:10800, target:60,  label:'3 Std → 1 Min Video'},
  {period:21600, target:60,  label:'6 Std → 1 Min Video'},
  {period:21600, target:120, label:'6 Std → 2 Min Video'},
  {period:43200, target:60,  label:'12 Std → 1 Min Video'},
  {period:43200, target:120, label:'12 Std → 2 Min Video'},
  {period:86400, target:30,  label:'24 Std → 30 Sek Video'},
  {period:86400, target:60,  label:'24 Std → 1 Min Video'},
  {period:86400, target:120, label:'24 Std → 2 Min Video'},
];
function _tlClosestCustomPreset(periodS,targetS){
  const pN=parseInt(periodS)||3600, tN=parseInt(targetS)||60;
  let best=_TL_CUSTOM_PRESETS[0], bd=Infinity;
  for(const p of _TL_CUSTOM_PRESETS){
    // rank exact period match above exact target match
    const d=Math.abs(Math.log(p.period/pN))*2 + Math.abs(Math.log(p.target/tN));
    if(d<bd){bd=d;best=p;}
  }
  return `${best.period},${best.target}`;
}
function _tlClosestPeriod(v){
  const n=parseInt(v)||3600;
  return _TL_PERIOD_OPTIONS.reduce((a,b)=>Math.abs(b.v-n)<Math.abs(a.v-n)?b:a).v;
}
const _TL_FPS_OPTIONS=[20,25];
function _tlFmtInterval(secs){
  const s=Number(secs);
  if(!isFinite(s)||s<=0) return '—';
  if(s<10){
    // 0.6 → "0,6s"  ·  5 → "5s"  ·  5.5 → "5,5s"
    const r=Math.round(s*10)/10;
    const str=(r===Math.floor(r))?String(Math.floor(r)):r.toFixed(1).replace('.',',');
    return `${str}s`;
  }
  if(s<60) return `${Math.round(s)}s`;
  if(s<3600) return `${Math.round(s/60)}min`;
  if(s<86400) return `${Math.round(s/3600)}h`;
  return `${Math.round(s/86400)}d`;
}
function _tlSpeedupLabel(v){
  if(v>=10000) return (Math.round(v/100)/10).toFixed(1)+'k×';
  return v+'×';
}
/* Custom inline SVG icon set for timelapse compact cards — black/white/violet only */
const _TL_ICO_SPAN=`<svg width="16" height="14" viewBox="0 0 14 12" fill="none" aria-hidden="true"><rect x="0.75" y="0.75" width="2" height="10.5" rx="1" fill="currentColor"/><line x1="3.5" y1="6" x2="7" y2="6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><polygon points="7,3 13.5,6 7,9" fill="currentColor"/></svg>`;
const _TL_ICO_FRAMES=`<svg width="15" height="13" viewBox="0 0 13 11" fill="none" aria-hidden="true"><rect x="2.5" y="0.75" width="8" height="9.5" rx="1.2" stroke="currentColor" stroke-width="1.5"/><rect x="0.5" y="2.25" width="2" height="1.75" rx="0.5" fill="currentColor"/><rect x="0.5" y="7" width="2" height="1.75" rx="0.5" fill="currentColor"/><rect x="10.5" y="2.25" width="2" height="1.75" rx="0.5" fill="currentColor"/><rect x="10.5" y="7" width="2" height="1.75" rx="0.5" fill="currentColor"/></svg>`;
const _TL_ICO_SPEED=`<svg width="14" height="13" viewBox="0 0 12 11" fill="none" aria-hidden="true"><path d="M1 1.25L5 5.5L1 9.75" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 1.25L10 5.5L6 9.75" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
function _tlIntervalLabel(interval_s){
  if(interval_s<60) return interval_s+'s';
  if(interval_s<3600) return Math.round(interval_s/60)+'min';
  if(interval_s<86400) return Math.round(interval_s/3600)+'h';
  return Math.round(interval_s/86400)+'d';
}
function _tlTargetLabel(secs){
  const n=parseInt(secs)||0;
  if(n<60) return n+'s';
  return Math.round(n/60)+'min';
}
function _tlCalcInterval(periodS,targetS,fps){
  return Math.max(2, Math.round((parseInt(periodS)||86400) / Math.max(1,(parseInt(targetS)||60)*(parseInt(fps)||30))));
}
function _updateTlActiveTags(cameras){
  const wrap=byId('tlActiveTags'); if(!wrap) return;
  const active=(cameras||[]).filter(cam=>_TL_PROFILES_DEF.some(p=>(cam.timelapse||{}).profiles?.[p.key]?.enabled));
  if(!active.length){wrap.innerHTML='';return;}
  wrap.innerHTML=active.map(cam=>`<span class="tl-cam-tag">${getCameraIcon(cam.name)} ${esc(cam.name)}</span>`).join('');
}
window.loadTlSettings=async function(){
  const content=byId('tlSettingsContent'); if(!content) return;
  content.innerHTML='<div class="small muted" style="padding:10px 2px">Lade...</div>';
  try{
    const cameras=state.cameras||[];
    _updateTlActiveTags(cameras);
    content.innerHTML=_renderTlCameraList(cameras);
  }catch(e){content.innerHTML=`<div class="small muted" style="padding:10px 2px">Fehler: ${esc(e.message)}</div>`;}
};
function _renderTlCameraList(cameras){
  if(!cameras.length) return '<div class="small muted" style="padding:10px 2px">Keine Kameras konfiguriert.</div>';
  const firstCam=cameras[0];
  const tabs=cameras.map((cam,i)=>{
    const profs=(cam.timelapse||{}).profiles||{};
    const anyOn=_TL_PROFILES_DEF.some(p=>profs[p.key]?.enabled);
    return `<button type="button" class="set-tab${i===0?' active':''}" id="tlTab_${esc(cam.id)}" onclick="selectTlCam('${esc(cam.id)}')">
      ${getCameraIcon(cam.name)} ${esc(cam.name)}
    </button>`;
  }).join('');
  return `<div class="set-tabs" id="tlCamTabs">${tabs}</div>
    <div class="sec-content" id="tlCamContent">${_renderTlModesGrid(firstCam)}</div>`;
}
function _renderTlModesGrid(cam){
  const tl=cam.timelapse||{};
  const profs=tl.profiles||{};
  const camFps=parseInt(tl.fps)||25;
  const cols=_TL_PROFILES_DEF.map(p=>{
    const prof=profs[p.key]||{};
    const enabled=!!prof.enabled;
    const targetS=prof.target_seconds??p.defaultTarget;
    const periodS=prof.period_seconds??p.defaultPeriod;
    // Snap the loaded fps to a valid dropdown option so the <select>
    // selection and the description always agree. Legacy configs with
    // fps=12 (no longer offered) snap to the closest option, e.g. 20.
    const rawProfFps=parseInt(prof.fps)||camFps;
    const profFps=_TL_FPS_OPTIONS.includes(rawProfFps)
      ? rawProfFps
      : _TL_FPS_OPTIONS.reduce((a,b)=>Math.abs(b-rawProfFps)<Math.abs(a-rawProfFps)?b:a);
    const isCustom=p.key==='custom';
    const minT=p.minTarget||10, maxT=p.maxTarget||900;
    const clampedTarget=Math.max(minT,Math.min(maxT,targetS));
    const cid=esc(cam.id);
    const pk=p.key;
    const fpsSelectHtml=`<div class="field-wrap">
        <select id="tlProfFps_${cid}_${pk}" style="width:100%"
          onchange="_tlRefreshDesc('${cid}','${pk}')">
          ${_TL_FPS_OPTIONS.map(v=>`<option value="${v}"${v===profFps?' selected':''}>${v} fps</option>`).join('')}
        </select>
        <span class="field-label">Video-Framerate</span>
      </div>`;
    let controlHtml;
    if(isCustom){
      const currentKey=`${periodS},${clampedTarget}`;
      const closestKey=_tlClosestCustomPreset(periodS,clampedTarget);
      const selectedKey=_TL_CUSTOM_PRESETS.some(pp=>`${pp.period},${pp.target}`===currentKey)?currentKey:closestKey;
      controlHtml=`<div class="field-wrap">
        <select id="tlProfPreset_${cid}_${pk}" style="width:100%"
          onchange="_tlApplyCustomPreset('${cid}','${pk}',this.value)">
          ${_TL_CUSTOM_PRESETS.map(pp=>{const k=`${pp.period},${pp.target}`;return `<option value="${k}"${k===selectedKey?' selected':''}>${esc(pp.label)}</option>`;}).join('')}
        </select>
        <span class="field-label">Timelapse-Profil</span>
      </div>
      <input type="hidden" id="tlProfTarget_${cid}_${pk}" value="${clampedTarget}" />
      <input type="hidden" id="tlProfPeriod_${cid}_${pk}" value="${periodS}" />`;
    } else {
      controlHtml=`<div class="field-wrap">
        <div style="display:flex;align-items:center;gap:8px">
          <input type="range" id="tlProfTarget_${cid}_${pk}" min="${minT}" max="${maxT}" step="${p.step||10}" value="${clampedTarget}" style="flex:1;accent-color:#a855f7"
            oninput="_tlRefreshDesc('${cid}','${pk}')" />
          <span id="tlProfTargetLbl_${cid}_${pk}" style="font-size:11px;color:#a855f7;font-weight:700;min-width:36px;text-align:right">${_tlTargetLabel(clampedTarget)}</span>
        </div>
        <span class="field-label">Zieldauer Video</span>
      </div>
      <input type="hidden" id="tlProfPeriod_${cid}_${pk}" value="${periodS}" />`;
    }
    return `<div class="tl-mode-col${enabled?' tl-mode-col--on':''}" id="tlProfCard_${cid}_${pk}">
      <div class="tl-mode-col-head">
        <div>
          <div class="tl-mode-col-name">${esc(p.label)}</div>
        </div>
        <label class="switch switch-sm" onclick="event.stopPropagation()">
          <input type="checkbox" id="tlProf_${cid}_${pk}" ${enabled?'checked':''}
            onchange="byId('tlProfCard_${cid}_${pk}').classList.toggle('tl-mode-col--on',this.checked);_tlRefreshDesc('${cid}','${pk}')" />
          <span class="slider"></span>
        </label>
      </div>
      <div class="tl-mode-col-desc" id="tlProfDesc_${cid}_${pk}">${_tlResultDesc(periodS,clampedTarget,profFps)}</div>
      ${controlHtml}
      ${fpsSelectHtml}
    </div>`;
  }).join('');
  return `<div class="tl-modes-grid">${cols}</div>
    <div style="display:flex;justify-content:flex-end;margin-top:8px">
      <button class="btn btn-save" onclick="saveTlCameraProfiles('${esc(cam.id)}')"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 2.5h8L13.5 5v8.5h-11z"/><polyline points="5,2.5 5,6.5 10,6.5 10,2.5"/><polyline points="4.5,13.5 4.5,9 11.5,9 11.5,13.5"/></svg>Speichern</button>
    </div>`;
}
window._tlApplyCustomPreset=function(camId,profKey,val){
  const [periodS,targetS]=(val||'').split(',').map(x=>parseInt(x)||0);
  const pEl=byId(`tlProfPeriod_${camId}_${profKey}`);
  const tEl=byId(`tlProfTarget_${camId}_${profKey}`);
  if(pEl) pEl.value=periodS;
  if(tEl) tEl.value=targetS;
  _tlRefreshDesc(camId,profKey);
};
window.selectTlCam=function(camId){
  document.querySelectorAll('#tlCamTabs .set-tab').forEach(b=>b.classList.toggle('active',b.id===`tlTab_${camId}`));
  const cam=(state.cameras||[]).find(c=>c.id===camId);
  const content=byId('tlCamContent');
  if(cam&&content) content.innerHTML=_renderTlModesGrid(cam);
};
// Renamed from _tlPeriodLabel — the original name collided with the
// item-shaped _tlPeriodLabel below at line ~5966. As a regular
// <script> the duplicate function declaration silently overrode this
// one, leaving "Timelapse" as the period label everywhere this was
// called; in module mode the duplicate is a SyntaxError. Restoring
// the original numeric→German-duration intent fixes a long-latent UI
// bug as a side effect of the rename.
function _tlDurationLabel(s){
  const n=parseInt(s)||0;
  if(n>=31536000) return Math.round(n/31536000)+' Jahr'+(Math.round(n/31536000)!==1?'e':'');
  if(n>=2592000) return Math.round(n/2592000)+' Monat'+( Math.round(n/2592000)!==1?'e':'');
  if(n>=604800)  return Math.round(n/604800)+' Woche'+( Math.round(n/604800)!==1?'n':'');
  if(n>=86400)   return Math.round(n/86400)+' Tag'+( Math.round(n/86400)!==1?'e':'');
  if(n>=3600)    return Math.round(n/3600)+' Stunde'+( Math.round(n/3600)!==1?'n':'');
  return Math.round(n/60)+' Min';
}
function _tlResultDesc(periodS,targetS,fps){
  const pN=parseInt(periodS)||86400, tN=parseInt(targetS)||60, fN=parseInt(fps)||25;
  const totalFrames=Math.max(1, Math.round(tN*fN));
  const intervalS=pN/totalFrames;
  const periodLabel=_tlDurationLabel(pN);
  const intervalLabel=_tlFmtInterval(intervalS);
  const compression=Math.round(pN/Math.max(1,tN));
  // ~40 KB per JPEG at q≈72; sub-1s interval drops to q=50 ≈ 26 KB.
  const perFrameKb=intervalS<1?26:40;
  const diskMb=Math.max(1, Math.round(totalFrames*perFrameKb/1024));
  return `<div class="tl-drow"><span class="tl-drow-ico">⏱</span><span class="tl-drow-text">${periodLabel} → ${tN}s Video</span></div><div class="tl-drow"><span class="tl-drow-ico">📸</span><span class="tl-drow-text">${totalFrames} Frames · Alle ${intervalLabel} ein Foto</span></div><div class="tl-drow tl-drow-accent"><span class="tl-drow-ico">⚡</span><span class="tl-drow-text">${compression}× Zeitraffer · ~${diskMb} MB Speicher</span></div>`;
}
// _renderTlProfileCards replaced by _renderTlModesGrid (4-column grid)
window._tlRefreshDesc=function(camId,profKey){
  const targetEl=byId(`tlProfTarget_${camId}_${profKey}`);
  const periodEl=byId(`tlProfPeriod_${camId}_${profKey}`);
  const fpsEl=byId(`tlProfFps_${camId}_${profKey}`);
  const descEl=byId(`tlProfDesc_${camId}_${profKey}`);
  const lblEl=byId(`tlProfTargetLbl_${camId}_${profKey}`);
  if(!targetEl||!periodEl) return;
  const fps=parseInt(fpsEl?.value)||25;
  if(lblEl) lblEl.textContent=_tlTargetLabel(parseInt(targetEl.value)||10);
  if(descEl) descEl.innerHTML=_tlResultDesc(periodEl.value,targetEl.value,fps);
};
// toggleTlCamCard replaced by selectTlCam (tab-based camera selector)
window.saveTlCameraProfiles=async function(camId){
  const cam=(state.cameras||[]).find(c=>c.id===camId);
  if(!cam) return;
  const profiles={};
  const tl=cam.timelapse||{};
  const camFps=parseInt(tl.fps)||25;
  let latestFps=camFps;
  for(const p of _TL_PROFILES_DEF){
    const enabledEl=byId(`tlProf_${camId}_${p.key}`);
    const targetEl=byId(`tlProfTarget_${camId}_${p.key}`);
    const periodEl=byId(`tlProfPeriod_${camId}_${p.key}`);
    const fpsEl=byId(`tlProfFps_${camId}_${p.key}`);
    const profFps=parseInt(fpsEl?.value)||camFps;
    latestFps=profFps;
    profiles[p.key]={
      enabled:!!(enabledEl?.checked),
      target_seconds:parseInt(targetEl?.value)||p.defaultTarget,
      period_seconds:parseInt(periodEl?.value)||p.defaultPeriod,
      fps:profFps,
    };
  }
  const anyEnabled=Object.values(profiles).some(p=>p.enabled);
  // Keep a camera-level fps too (most recently edited) for legacy readers.
  const payload={...cam,timelapse:{...(cam.timelapse||{}),enabled:anyEnabled,fps:latestFps,profiles}};
  await fetch('/api/settings/cameras',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  showToast(`Timelapse für ${esc(cam.name)} gespeichert.`,'success');
  await loadAll();
  _updateTlActiveTags(state.cameras||[]);
  const content=byId('tlSettingsContent');
  if(content){content.innerHTML=_renderTlCameraList(state.cameras||[]);selectTlCam(camId);}
};

// ── Timelapse Status Bar (Dashboard in Cameras section) ───────────────────────
window._tlStatus=null;
async function loadTlStatus(){
  try{
    window._tlStatus=await j('/api/timelapse/status');
    renderTlStatusBar();
  }catch(e){ /* silent */ }
}
function renderTlStatusBar(){
  const bar=byId('tlStatusBar'); if(!bar) return;
  const s=window._tlStatus;
  if(!s||s.active_count===0){bar.innerHTML='';return;}
  const activeCams=(s.cameras||[]).filter(c=>c.any_active);
  const panelId='tlSbPanel';
  bar.innerHTML=`
    <div class="tl-sb-pill" onclick="byId('${panelId}').classList.toggle('hidden')">
      ${_TL_FILMSTRIP}
      <span>Timelapse aktiv</span>
      <span class="tl-sb-count">${activeCams.length}</span>
    </div>
    <div class="tl-sb-panel hidden" id="${panelId}">
      ${activeCams.map(cam=>`
        <div class="tl-sb-cam">
          <div class="tl-sb-cam-name">${esc(cam.name)}</div>
          <div class="tl-sb-profiles">
            ${_TL_PROFILES_DEF.map(p=>{
              const prof=cam.profiles[p.key]; if(!prof?.enabled) return '';
              return `<div class="tl-sb-profile">
                <span class="tl-sb-prof-name">${esc(p.label)}</span>
                <span class="tl-sb-prof-frames">${prof.frame_count} Frames heute</span>
                <span class="tl-sb-prof-interval">alle ~${_tlIntervalLabel(prof.interval_s)}</span>
              </div>`;
            }).join('')}
          </div>
        </div>`).join('')}
      <div class="tl-sb-footer small muted">Stand: ${esc(s.today||'—')}</div>
    </div>`;
}

// ── Settings collapsible sections ────────────────────────────────────────────
window.toggleSetSection=function(id){
  const el=byId(id); if(!el){console.warn('[toggleSetSection] not found:',id);return;}
  // Propagate the per-section accent (stored as "R,G,B" on data-accent) into
  // a CSS custom property so the accent-tinted border + header rules can pick
  // it up. Cheap to set unconditionally.
  if(el.dataset.accent) el.style.setProperty('--sa',el.dataset.accent);
  const opening=!el.classList.contains('open');
  el.classList.toggle('open',opening);
};
// Seed --sa on page load so even closed sections render with the correct
// accent once opened (without waiting for the first click to set it).
// Top-level panels (#achievements, #weather) get the same RGB triplet on
// --acc so accent-driven rules like the section-head icon and
// .ach-progress-fill resolve to the panel's own colour.
document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('.set-section[data-accent]').forEach(el=>{
    el.style.setProperty('--sa',el.dataset.accent);
  });
  document.querySelectorAll('.panel.section[data-accent]').forEach(el=>{
    el.style.setProperty('--acc',el.dataset.accent);
  });
});

// ── Sidebar settings: scroll-link + chevron-toggle (separate handlers) ───────
// The Einstellungen row is now two elements: an <a> that scrolls only and a
// small <button> that toggles the sub-list only. Hover never reveals the
// sub-list — it is shown only when the chevron has been clicked.
const _NAV_OPEN_KEY='nav_settings_open';
function _setSettingsNavOpen(isOpen){
  const group=byId('navSettingsGroup');
  const chev=group?.querySelector('.nav-settings-chev');
  const sub=byId('navSettingsSub');
  if(!group||!chev||!sub) return;
  group.classList.toggle('nav--open',isOpen);
  chev.setAttribute('aria-expanded',isOpen?'true':'false');
  sub.classList.toggle('open',isOpen);
  // Drive max-height in pixels so the transition is smooth without
  // committing to a hardcoded ceiling. Measured from scrollHeight at
  // toggle time so adding/removing sub-items keeps animating cleanly.
  sub.style.maxHeight = isOpen ? (sub.scrollHeight + 'px') : '0px';
  try{localStorage.setItem(_NAV_OPEN_KEY,isOpen?'1':'0');}catch{}
}
// Chevron click → toggle sub-list, never scroll.
window.toggleSettingsNav=function(ev){
  if(ev){ ev.preventDefault?.(); ev.stopPropagation?.(); }
  const isOpen=!byId('navSettingsGroup')?.classList.contains('nav--open');
  _setSettingsNavOpen(isOpen);
  return false;
};
// Main link click → scroll to #settings, never toggle the accordion.
window.navScrollToSettings=function(ev){
  ev?.preventDefault?.();
  const sec=byId('settings');
  if(sec) sec.scrollIntoView({behavior:'smooth',block:'start'});
  if(typeof _setActiveNav==='function') _setActiveNav('settings');
  return false;
};
// Sub-item click → scroll AND open the matching set-section. Accordion
// stays open (we never close it from sub-item interactions).
window.navJumpToSetting=function(ev,secId){
  ev?.preventDefault?.();
  const sec=byId(secId); if(!sec) return false;
  if(!sec.classList.contains('open')&&typeof window.toggleSetSection==='function'){
    window.toggleSetSection(secId);
    if(secId==='set-timelapse'&&typeof loadTlSettings==='function') loadTlSettings();
  }
  sec.scrollIntoView({behavior:'smooth',block:'start'});
  _setActiveNav('settings');
  return false;
};
document.addEventListener('DOMContentLoaded',()=>{
  let open=false;
  try{open=localStorage.getItem(_NAV_OPEN_KEY)==='1';}catch{}
  _setSettingsNavOpen(open);
});

// ── Sidebar active-nav state ─────────────────────────────────────────────────
// Tracks which top-level section is currently visible and applies the
// section's accent color via the --na CSS variable. Click sets it eagerly,
// scroll keeps it honest. Logs/Settings stay sticky once opened — neither
// has a useful "scrolled past" signal.
function _setActiveNav(targetId){
  document.querySelectorAll('.nav [data-target]').forEach(el=>{
    const isActive=el.dataset.target===targetId;
    el.classList.toggle('nav-active',isActive);
    if(isActive && el.dataset.accent){
      el.style.setProperty('--na',el.dataset.accent);
    }
  });
}
window._setActiveNav=_setActiveNav;
function _initSidebarNav(){
  // Click: set active immediately so the highlight tracks the user's intent
  // before the scroll animation finishes. Skip the Einstellungen button —
  // it doesn't represent a navigable section, only the accordion toggle.
  document.querySelectorAll('.nav a[data-target]').forEach(a=>{
    a.addEventListener('click',()=>{
      _setActiveNav(a.dataset.target);
    });
  });
  // Scrollspy: pick the section whose top is closest to the viewport top
  // without going past it. Cheap enough to run on every scroll tick.
  const sectionIds=['dashboard','statistik','media','achievements','weather','cameras','settings','logs'];
  let raf=0;
  const tick=()=>{
    raf=0;
    const top=80; // account for sticky header / hero offset
    let bestId=null, bestY=-Infinity;
    for(const id of sectionIds){
      const el=byId(id); if(!el) continue;
      const r=el.getBoundingClientRect();
      if(r.top<=top && r.top>bestY){ bestY=r.top; bestId=id; }
    }
    if(bestId) _setActiveNav(bestId);
  };
  window.addEventListener('scroll',()=>{ if(!raf) raf=requestAnimationFrame(tick); },{passive:true});
  tick();
}
document.addEventListener('DOMContentLoaded',_initSidebarNav);

// ── Password field visibility toggle ─────────────────────────────────────────
// Eye glyphs — single source of truth, used by .pw-eye AND .url-eye buttons
// across the app. SVG (not emoji) so size + centring stay pixel-stable.
const EYE_SVG=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF_SVG=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.66 18.66 0 0 1 4.16-4.93"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.66 18.66 0 0 1-1.66 2.66"/><path d="M14.12 14.12a3 3 0 0 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
function _setEyeState(btn,revealed){
  if(!btn) return;
  btn.innerHTML=revealed?EYE_OFF_SVG:EYE_SVG;
  btn.classList.toggle('revealed',revealed);
  btn.setAttribute('aria-label',revealed?'Passwort verbergen':'Passwort anzeigen');
}
window.togglePwField=function(btn,fieldName){
  const f=btn.closest('form');
  const input=f?.elements[fieldName]; if(!input) return;
  input.type=input.type==='password'?'text':'password';
  _setEyeState(btn,input.type==='text');
};
window.togglePwFieldById=function(id){
  const input=byId(id); if(!input) return;
  input.type=input.type==='password'?'text':'password';
  const btn=input.parentElement?.querySelector('.pw-eye');
  _setEyeState(btn,input.type==='text');
};

// ── Media storage stats ───────────────────────────────────────────────────────
// Single source of truth for state.mediaStats. Every caller that mutates the
// archive (delete, bulk-delete, rescan, fix-thumbnails completion, processing
// poll completion) funnels through here so chips, size badges, and filter
// pills always reflect server reality.
async function loadMediaStorageStats(){
  const bar=byId('mediaStorageBar'); if(!bar) return;
  try{
    const r=await j('/api/media/storage-stats');
    state.mediaStats=r.cameras||[];
    state.mediaArchived=r.archived||[];
    bar.innerHTML='';
    // renderMediaOverview rebuilds the overview cards AND calls
    // renderMediaFilterPills('overview') internally.
    renderMediaOverview();
    // Drilldown pill bar reads from the same state.mediaStats — keep it
    // in sync if the user is currently inside a drilldown.
    if(byId('mediaDrilldown')?.style.display!=='none'){
      if(_pruneEmptyMediaFilters()) _seedTopMediaLabel();
      renderMediaFilterPills('drilldown');
    }
  }catch{bar.innerHTML=''; state.mediaStats=[]; state.mediaArchived=[];}
}

// Targeted refresh after a delete/retag — keeps timeline dots and media-overview
// badges in sync without paying for a full loadAll().
async function refreshTimelineAndStats(){
  const url=`/api/timeline?hours=${state.tlHours||168}${state.label?`&label=${encodeURIComponent(state.label)}`:''}`;
  try{
    const [tl]=await Promise.all([j(url),loadMediaStorageStats()]);
    state.timeline=tl;
    renderTimeline();
  }catch(_){ /* non-critical: leave previous render in place */ }
}

byId('cleanupNowBtn').onclick=async()=>{
  if(!await showConfirm('Jetzt bereinigen? Alle Dateien älter als die konfigurierte Aufbewahrungszeit werden gelöscht.')) return;
  const rdEl=byId('ms_retention_days');
  const payload=rdEl?.value?{retention_days:Number(rdEl.value)}:{};
  try{
    const r=await j('/api/media/cleanup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    showToast(`Bereinigung abgeschlossen. ${r.removed||0} Dateien entfernt.`,'success');
    await loadMediaStorageStats();
  }catch(e){showToast('Fehler: '+e.message,'error');}
};

byId('purgeOrphansBtn').onclick=async()=>{
  if(!await showConfirm('Verwaiste Events löschen? Alle Event-Einträge ohne zugehörige Mediendatei werden entfernt.')) return;
  try{
    const r=await j('/api/media/purge-orphans',{method:'POST'});
    showToast(`${r.removed||0} verwaiste Events entfernt.`,'success');
    await loadAll();
  }catch(e){showToast('Fehler: '+e.message,'error');}
};

byId('mediaSettingsForm').onsubmit=async(e)=>{
  e.preventDefault();
  const f=e.target.elements;
  const payload={storage:{retention_days:Number(f['retention_days'].value||14),auto_cleanup_enabled:!!(f['auto_cleanup_enabled']?.checked)}};
  await fetch('/api/settings/app',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  await loadAll();
};

// ── Shape editor wiring (canvas drag + touch + toolbar) ─────────────────
// Hit-test radius for vertex-grab and close-polygon detection. 12px is
// generous on mouse, comfortable on touch.
const _SHAPE_HIT_PX = 12;
// Find the existing-polygon vertex (if any) within HIT px of point pt.
// Returns {kind:'zone'|'mask', polyIdx, ptIdx} or null.
function _hitVertex(pt){
  const test = (arr, kind) => {
    for(let i=arr.length-1; i>=0; i--){
      const pts=_polyPoints(arr[i]);
      for(let j=0; j<pts.length; j++){
        const dx=pts[j].x-pt.x, dy=pts[j].y-pt.y;
        if(dx*dx + dy*dy <= _SHAPE_HIT_PX*_SHAPE_HIT_PX) return {kind, polyIdx:i, ptIdx:j};
      }
    }
    return null;
  };
  return test(shapeState.zones||[], 'zone') || test(shapeState.masks||[], 'mask');
}
// While drawing: if the cursor is within HIT px of the very first point
// AND we already have ≥3 points, hovering / clicking should close the
// polygon instead of adding a new point.
function _isClosingPoint(pt){
  if(!shapeState.points || shapeState.points.length < 3) return false;
  const first = shapeState.points[0];
  const dx=first.x-pt.x, dy=first.y-pt.y;
  return dx*dx + dy*dy <= _SHAPE_HIT_PX*_SHAPE_HIT_PX;
}
// Ray-casting point-in-polygon test against {x,y} polygon vertices.
// Used by canvas-click selection to decide which polygon (if any) the
// click lands inside.
function _pointInPoly(pt, points){
  if(!Array.isArray(points) || points.length < 3) return false;
  let inside = false;
  for(let i=0, j=points.length-1; i<points.length; j=i++){
    const xi=points[i].x, yi=points[i].y;
    const xj=points[j].x, yj=points[j].y;
    const intersect = ((yi>pt.y) !== (yj>pt.y)) &&
                      (pt.x < (xj-xi)*(pt.y-yi)/((yj-yi)||1e-9) + xi);
    if(intersect) inside = !inside;
  }
  return inside;
}
// Find the topmost completed polygon containing pt. Zones first (drawn
// on top in the editor), then masks. Returns {kind, idx} or null.
function _findPolygonAt(pt){
  const test = (arr, kind) => {
    for(let i=arr.length-1; i>=0; i--){
      const pts = _polyPoints(arr[i]);
      if(_pointInPoly(pt, pts)) return {kind, idx:i};
    }
    return null;
  };
  return test(shapeState.zones||[], 'zone') || test(shapeState.masks||[], 'mask');
}
function _commitInProgressPolygon(){
  if(shapeState.points.length < 3) return false;
  const poly = { points: [...shapeState.points], label: _nextPolyName(shapeState.mode) };
  if(shapeState.mode==='zone') shapeState.zones.push(poly);
  else                         shapeState.masks.push(poly);
  shapeState.points = [];
  saveShapesIntoForm(); drawShapes();
  _updateShapeDrawingBar(); _renderShapeList();
  showToast(`${poly.label} gespeichert`, 'success');
  return true;
}

(function _initShapeEditor(){
  const canvas = byId('maskCanvas');
  if(!canvas) return;

  let drag = null;          // {kind, polyIdx, ptIdx} while dragging an existing vertex
  let downPt = null;        // pointer at mousedown — used to distinguish click vs drag

  const onDown = (evt) => {
    if(!shapeState.camera) return;
    if(evt.cancelable) evt.preventDefault();
    const pt = canvasPoint(evt);
    const hit = _hitVertex(pt);
    if(hit){
      drag = hit;
      downPt = pt;
      return;
    }
    // No vertex grabbed → record the down position so the corresponding
    // up-event knows whether the user actually clicked or just brushed
    // the canvas. New points are added on up (with no movement) so a
    // missed drag-attempt doesn't accidentally drop a stray vertex.
    downPt = pt;
    drag = null;
  };

  const onMove = (evt) => {
    if(!shapeState.camera) return;
    const pt = canvasPoint(evt);
    if(drag){
      if(evt.cancelable) evt.preventDefault();
      const arr = drag.kind==='zone' ? shapeState.zones : shapeState.masks;
      const poly = arr[drag.polyIdx];
      const pts = _polyPoints(poly);
      if(!pts || !pts[drag.ptIdx]) return;
      pts[drag.ptIdx].x = Math.round(pt.x);
      pts[drag.ptIdx].y = Math.round(pt.y);
      drawShapes();
      return;
    }
    // Plain hover: track which vertex (if any) is under the cursor so
    // drawShapes can highlight it and the canvas cursor updates.
    const hover = _hitVertex(pt);
    const closing = !hover && _isClosingPoint(pt);
    const sig = hover ? `${hover.kind}:${hover.polyIdx}:${hover.ptIdx}` : (closing ? 'close' : '');
    if(sig !== shapeState.hoverSig){
      shapeState.hoverVertex = hover;
      shapeState.hoverClosing = closing;
      shapeState.hoverSig = sig;
      canvas.style.cursor = (hover ? 'move' : (closing ? 'pointer' : 'crosshair'));
      drawShapes();
    }
  };

  const onUp = (evt) => {
    if(!shapeState.camera){ drag=null; downPt=null; return; }
    if(drag){
      // Persist the drag result and clear state.
      saveShapesIntoForm();
      drag = null;
      downPt = null;
      return;
    }
    if(!downPt) return;
    const pt = canvasPoint(evt);
    // Treat as a click only when the pointer didn't move significantly.
    const dx=pt.x-downPt.x, dy=pt.y-downPt.y;
    downPt = null;
    if(dx*dx + dy*dy > 9) return;  // moved more than 3 px → ignore
    if(evt.cancelable) evt.preventDefault();
    // Click on the in-progress polygon's first vertex closes it.
    if(_isClosingPoint(pt)){
      _commitInProgressPolygon();
      shapeState.hoverClosing = false;
      canvas.style.cursor = 'crosshair';
      return;
    }
    // While not drawing, a click on an existing polygon SELECTS it; a click
    // in empty canvas DESELECTS (if anything was selected). New points are
    // only added when nothing was selected and the click missed every
    // polygon — that preserves the legacy "click empty area to draw" UX.
    if(shapeState.points.length === 0){
      const hit = _findPolygonAt(pt);
      if(hit){
        const key=`${hit.kind}:${hit.idx}`;
        shapeState.pulse = key;
        shapeState.expandedRows.add(key);
        drawShapes(); _renderShapeList();
        // Bring the matching list row into view so its trigger panel is
        // immediately visible.
        const row = byId(`shapeRow_${hit.kind}_${hit.idx}`);
        if(row && row.scrollIntoView) row.scrollIntoView({behavior:'smooth', block:'nearest'});
        return;
      }
      if(shapeState.pulse){
        shapeState.pulse = null;
        drawShapes(); _renderShapeList();
        return;
      }
    }
    shapeState.points.push(pt);
    drawShapes(); _updateShapeDrawingBar();
  };

  // Mouse + touch share the same handlers; touch events expose .touches
  // / .changedTouches and canvasPoint already reads from both.
  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseup',   onUp);
  canvas.addEventListener('mouseleave',()=>{ drag=null; downPt=null; shapeState.hoverVertex=null; shapeState.hoverClosing=false; shapeState.hoverSig=''; canvas.style.cursor='crosshair'; drawShapes(); });
  canvas.addEventListener('touchstart',onDown,{passive:false});
  canvas.addEventListener('touchmove', onMove,{passive:false});
  canvas.addEventListener('touchend',  onUp,  {passive:false});
  canvas.addEventListener('touchcancel',()=>{ drag=null; downPt=null; });

  byId('refreshMaskSnapshotBtn').onclick = () =>
    loadMaskSnapshot(shapeState.camera || byId('cameraForm').elements['id'].value);

  byId('editZoneBtn').onclick = () => { shapeState.mode='zone'; _updateShapeModeButtons(); };
  byId('editMaskBtn').onclick = () => { shapeState.mode='mask'; _updateShapeModeButtons(); };

  byId('undoShapeBtn').onclick = () => {
    shapeState.points.pop();
    drawShapes(); _updateShapeDrawingBar();
  };

  byId('saveShapeBtn').onclick = () => {
    if(shapeState.points.length < 3){ showToast('Mindestens 3 Punkte.','warn'); return; }
    _commitInProgressPolygon();
  };

  byId('clearShapesBtn').onclick = async () => {
    if(!await showConfirm('Alle Zonen und Masken löschen?')) return;
    shapeState.zones = []; shapeState.masks = []; shapeState.points = [];
    shapeState.pulse = null;
    saveShapesIntoForm(); drawShapes();
    _updateShapeDrawingBar(); _renderShapeList();
  };

  byId('maskSnapshot').addEventListener('load', () => {
    drawShapes(); _renderShapeList(); _updateShapeModeButtons(); _updateShapeDrawingBar();
  });
})();

byId('wiz_cam_rtsp').value='rtsp://user:pass@192.168.X.X:554/Streaming/Channels/101';
byId('wiz_cam_snapshot').value='http://user:pass@192.168.X.X/cgi-bin/snapshot.cgi';
let wizStep=1;
document.querySelectorAll('.wiz-tab').forEach(btn=>btn.onclick=()=>{ wizStep=Number(btn.dataset.step); showWizardStep(wizStep); });
byId('wizPrev').onclick=()=>{ wizStep=Math.max(1,wizStep-1); showWizardStep(wizStep); };
byId('wizNext').onclick=()=>{ wizStep=Math.min(4,wizStep+1); showWizardStep(wizStep); };
byId('wizFinish').onclick=()=>finishWizard();

// ── Sidebar ───────────────────────────────────────────────────���───────────────
(function initSidebar(){
  const sidebar=byId('sidebar');
  const STORAGE_KEY='tspy_sidebar_collapsed';

  function setCollapsed(yes){
    sidebar.classList.toggle('collapsed',yes);
    try{localStorage.setItem(STORAGE_KEY,yes?'1':'0');}catch{}
  }

  // Desktop (>1024px): always collapsed; CSS hover expands.
  // Tablet  (768-1024px): collapsed by default, persisted via localStorage.
  // Mobile  (≤768px): hidden — navigation lives in the bottom dock now,
  // so the drawer + hamburger + edge-swipe machinery is gone.
  if(window.innerWidth>1024){
    sidebar.classList.add('collapsed');
  } else if(window.innerWidth>768){
    const saved=localStorage.getItem(STORAGE_KEY);
    setCollapsed(saved!=='0');
  }

  document.querySelectorAll('.nav a').forEach(a=>a.addEventListener('click',e=>{
    e.preventDefault();
    const target=document.querySelector(a.getAttribute('href'));
    if(!target) return;
    target.scrollIntoView({behavior:'smooth',block:'start'});
    // One-shot offset correction: if scroll-margin + padding still leaves a gap,
    // nudge to the top. Needed mainly for sections late in the flow.
    setTimeout(()=>{
      const el=document.querySelector(a.getAttribute('href'));
      if(!el) return;
      const rect=el.getBoundingClientRect();
      if(rect.top>12){
        window.scrollBy({top:rect.top-8,behavior:'smooth'});
      }
    },420);
  }));
})();

// ── Mobile bottom dock ───────────────────────────────────────────────────────
// 5-tab nav that replaces the old mobile topbar. Click → smooth-scroll;
// scroll-spy auto-activates the tab whose section is centered. Sections
// without a matching dock entry (cameras, media, logs) ride along with a
// related tab via the data-dock-section attribute.
function _initMobileDock(){
  const dock=document.getElementById('mobileDock');
  if(!dock) return;
  const btns=Array.from(dock.querySelectorAll('.m-dock-btn'));
  btns.forEach(btn=>{btn.style.setProperty('--m-acc',btn.dataset.accentRgb);});

  function setActiveByDockTarget(target){
    btns.forEach(b=>b.classList.toggle('is-active',b.dataset.target===target));
  }

  // Section-id → dock-target. data-dock-section overrides the default
  // self-mapping so #cameras rides Live, #media rides Statistik, #logs
  // rides Setup. trackedSections is in DOM/scroll order so the spy
  // loop can early-break once it crosses the probe.
  const sectionIds=['dashboard','cameras','statistik','media','achievements','weather','settings','logs'];
  const targetById={};
  const trackedSections=[];
  for(const id of sectionIds){
    const el=document.getElementById(id);
    if(!el) continue;
    targetById[id]=el.dataset.dockSection||id;
    trackedSections.push(el);
  }

  // Click-lock keeps the tapped tab pinned for ~900 ms while the smooth-
  // scroll settles, so scroll-spy can't flip-flop and force the user to
  // tap twice.
  let clickLockTarget=null;
  let clickLockTimer=0;
  let scrollRaf=0;

  btns.forEach(btn=>{
    btn.addEventListener('click',()=>{
      const targetId=btn.dataset.target;
      const el=document.getElementById(targetId);
      if(!el) return;
      const wasActive=btn.classList.contains('is-active');
      clickLockTarget=targetId;
      if(clickLockTimer) clearTimeout(clickLockTimer);
      clickLockTimer=setTimeout(()=>{clickLockTarget=null;updateActiveFromScroll();},900);
      setActiveByDockTarget(targetId);
      if(wasActive){
        window.scrollTo({top:el.offsetTop-12,behavior:'smooth'});
      } else {
        el.scrollIntoView({behavior:'smooth',block:'start'});
      }
      if(location.hash!=='#'+targetId){
        try{history.replaceState(null,'','#'+targetId);}catch{}
      }
    });
  });

  // Position-based scroll-spy. The previous IntersectionObserver band
  // (rootMargin -30%/-55%) was too narrow — short sections and the last
  // section on the page never reached it, so their tabs never lit up.
  // New rule: activate the last section whose top has crossed a probe
  // line at vh*0.30. Bottom-of-page snaps to the last section regardless
  // so settings/logs always lights Setup at the page foot.
  function updateActiveFromScroll(){
    scrollRaf=0;
    if(clickLockTarget){setActiveByDockTarget(clickLockTarget);return;}
    if(!trackedSections.length) return;
    const vh=window.innerHeight;
    const sy=window.scrollY;
    const docH=document.documentElement.scrollHeight;
    if(sy+vh>=docH-4){
      const last=trackedSections[trackedSections.length-1];
      setActiveByDockTarget(targetById[last.id]);
      return;
    }
    const probe=sy+vh*0.30;
    let bestId=null;
    for(const el of trackedSections){
      const top=el.getBoundingClientRect().top+sy;
      if(top<=probe) bestId=targetById[el.id];
      else break;
    }
    if(bestId) setActiveByDockTarget(bestId);
  }
  function scheduleScrollUpdate(){
    if(scrollRaf) return;
    scrollRaf=requestAnimationFrame(updateActiveFromScroll);
  }
  window.addEventListener('scroll',scheduleScrollUpdate,{passive:true});
  window.addEventListener('resize',scheduleScrollUpdate);
  updateActiveFromScroll();

  window._updateMobileDockLiveDot=function(){
    const dot=dock.querySelector('.m-dock-btn[data-target="dashboard"] .m-dock-livedot');
    if(!dot) return;
    const anyLive=(state.cameras||[]).some(c=>c.enabled&&c.armed);
    dot.hidden=!anyLive;
  };
  _updateMobileDockLiveDot();
}
_initMobileDock();

// ── Logs ─────────────────────────────────────────────────────────────────────
function _logSubsystemShort(logger){
  if(!logger) return '';
  // Handle sub-loggers like camera_runtime.timelapse, camera_runtime.camera
  if(logger.includes('camera_runtime.timelapse')) return 'tl';
  if(logger.includes('camera_runtime.camera')) return 'cam';
  const p=logger.split('.').pop()||logger;
  const MAP={camera_runtime:'runtime',timelapse:'tl',telegram_bot:'tg',detectors:'coral',storage:'store',mqtt_service:'mqtt',server:'srv',discovery:'disc'};
  return MAP[p]||p.slice(0,8);
}
async function loadLogs(){
  const level=byId('logLevelFilter')?.value||'INFO';
  const subsystem=byId('logSubsystemFilter')?.value||'';
  try{
    const params=`level=${level}${subsystem?'&subsystem='+encodeURIComponent(subsystem):''}`;
    const r=await j(`/api/logs?${params}`);
    renderLogs(r.logs||[]);
  }catch(e){
    byId('logOutput').innerHTML=`<div class="log-row ERROR"><span class="log-ts">--:--:--</span><span class="log-level">ERROR</span><span>${esc(String(e))}</span></div>`;
  }
}
function renderLogs(logs){
  const out=byId('logOutput');
  if(!logs.length){out.innerHTML='<div class="log-row INFO"><span class="log-ts">—</span><span class="log-level">—</span><span>Keine Log-Einträge auf diesem Level.</span></div>'; return;}
  out.innerHTML=logs.map(l=>{
    const tag=_logSubsystemShort(l.logger);
    return `<div class="log-row ${esc(l.level)}"><span class="log-ts">${esc(l.ts||'')}</span><span class="log-level">${esc(l.level||'')}</span>${tag?`<span class="log-subsys">${esc(tag)}</span>`:'<span class="log-subsys"></span>'}<span>${esc(l.msg||'')}</span></div>`;
  }).join('');
  out.scrollTop=out.scrollHeight;
}
byId('logRefreshBtn').onclick=loadLogs;
byId('logClearBtn').onclick=()=>{byId('logOutput').innerHTML='';};
byId('logLevelFilter').onchange=loadLogs;
byId('logSubsystemFilter')?.addEventListener('change',loadLogs);

// ── Telegram test button ──────────────────────────────────────────────────────
byId('telegramTestBtn')?.addEventListener('click',async()=>{
  const btn=byId('telegramTestBtn');
  const res=byId('telegramTestResult');
  btn.disabled=true; btn.textContent='Sende …';
  if(res){res.style.display='inline';res.style.color='var(--muted)';res.textContent='...';}
  try{
    const r=await j('/api/telegram/test',{method:'POST'});
    if(res){res.style.color='var(--good)';res.textContent='✓ Gesendet';}
  }catch(e){
    let msg='Fehler';
    try{msg=JSON.parse(e.message)?.error||e.message;}catch{}
    if(res){res.style.color='var(--danger)';res.textContent='✗ '+msg;}
  }finally{
    btn.disabled=false; btn.textContent='📨 Testnachricht senden';
    if(res) setTimeout(()=>{res.style.display='none';},6000);
  }
});

// ── Media rescan button ───────────────────────────────────────────────────────
byId('rescanMediaBtn')?.addEventListener('click',async()=>{
  const btn=byId('rescanMediaBtn');
  if(btn.disabled) return;
  btn.disabled=true; btn.classList.add('scanning');
  try{
    const r=await j('/api/media/rescan',{method:'POST'});
    showToast(`Scan abgeschlossen: ${r.registered||0} neue Medien registriert.`,'success');
    await loadAll();
  }catch(e){showToast('Fehler beim Scan: '+e.message,'error');}
  finally{btn.disabled=false; btn.classList.remove('scanning');}
});
let _fixThumbsPoll=null;
let _fixThumbsLastDone=-1;
let _shownThumbFiles=new Set();
function _showFixThumbsBar(done,total,finalMsg){
  let bar=byId('fixThumbsBar');
  if(!bar){
    bar=document.createElement('div');
    bar.id='fixThumbsBar';
    bar.style.cssText='position:fixed;bottom:0;left:0;right:0;z-index:500;background:var(--panel);border-top:1px solid rgba(255,255,255,.08);font-size:13px;color:var(--text)';
    bar.innerHTML=`
      <div id="ftp-prog-line" style="height:3px;background:var(--accent);width:0%;transition:width .3s ease"></div>
      <div style="display:flex;align-items:center;gap:10px;padding:10px 16px">
        <span id="ftp-icon" style="font-size:16px;animation:spin 1.2s linear infinite;display:inline-block">⚙</span>
        <span id="ftp-label" style="flex:1">Thumbnails werden erzeugt…</span>
        <button onclick="(function(){const d=byId('ftp-details');if(d)d.style.display=d.style.display==='none'?'block':'none';})()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:12px;padding:4px 8px;border-radius:6px">▲ Details</button>
        <button onclick="document.getElementById('fixThumbsBar').remove()" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;line-height:1;padding:4px 8px">✕</button>
      </div>
      <div id="ftp-details" style="display:none;padding:0 16px 10px;max-height:260px;overflow-y:auto;font-family:monospace;font-size:11px;color:var(--muted)"></div>`;
    document.body.appendChild(bar);
  }
  const pct=total>0?(done/total)*100:0;
  const prog=byId('ftp-prog-line');
  const lbl=byId('ftp-label');
  const icon=byId('ftp-icon');
  if(prog) prog.style.width=pct+'%';
  if(finalMsg){
    if(lbl) lbl.textContent=finalMsg;
    if(icon){icon.textContent='✓';icon.style.animation='none';icon.style.color='var(--good)';}
    if(prog) prog.style.background='var(--good)';
    return;
  }
  if(lbl) lbl.textContent=`Thumbnails werden erzeugt: ${done} / ${total}`;
}
function _hideFixThumbsBar(){
  const bar=byId('fixThumbsBar');
  if(bar) bar.remove();
}
function _startFixThumbsPoll(){
  if(_fixThumbsPoll) clearInterval(_fixThumbsPoll);
  _fixThumbsLastDone=-1;
  _fixThumbsPoll=setInterval(async()=>{
    try{
      const s=await j('/api/media/fix-thumbnails/status');
      _showFixThumbsBar(s.done||0,s.total||0);
      // Append per-filename log lines for any newly completed files
      const det=byId('ftp-details');
      if(det && Array.isArray(s.recent)){
        s.recent.forEach(fname=>{
          if(_shownThumbFiles.has(fname)) return;
          _shownThumbFiles.add(fname);
          const line=document.createElement('div');
          line.style.cssText='padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04);white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
          line.textContent='✓ '+fname;
          det.appendChild(line);
          det.scrollTop=det.scrollHeight;
        });
      }
      _fixThumbsLastDone=s.done||0;
      if(!s.running){
        clearInterval(_fixThumbsPoll); _fixThumbsPoll=null;
        const done=s.done||0, errs=s.errors||0;
        const msg=errs>0?`✓ ${done-errs} Thumbnails erzeugt, ${errs} Fehler`:`✓ ${done} Thumbnails erzeugt`;
        _showFixThumbsBar(done,s.total||0,msg);
        setTimeout(_hideFixThumbsBar,12000);
        try{renderMediaGrid();}catch(_){}
        // Newly-generated thumbnails may also have surfaced previously
        // unscanned media — refresh overview chips + size badges.
        loadMediaStorageStats();
      }
    }catch(_){ /* transient — keep polling */ }
  },1500);
}
byId('fixThumbsBtn')?.addEventListener('click',async()=>{
  const btn=byId('fixThumbsBtn');
  if(btn.disabled) return;
  btn.disabled=true; btn.classList.add('scanning');
  _shownThumbFiles=new Set();
  try{
    const r=await j('/api/media/fix-thumbnails',{method:'POST'});
    if(!r.ok){
      showToast('Thumbnail-Erzeugung: '+(r.error||'Fehler'),'error');
      return;
    }
    if((r.total||0)===0&&!r.already_running){
      _showFixThumbsBar(0,0,'✓ Alle Thumbnails vorhanden');
      setTimeout(_hideFixThumbsBar,12000);
    }else{
      _showFixThumbsBar(r.done||0,r.total||0);
      _startFixThumbsPoll();
    }
  }catch(e){showToast('Fehler: '+e.message,'error');}
  finally{btn.disabled=false; btn.classList.remove('scanning');}
});

// ── Lightbox / Media viewer ───────────────────────────────────────────────────
let _lbItem=null;
let _lbIndex=-1;
let _lbDeletePending=false;
function _lbHandleDeleteKey(){
  if(!_lbItem) return;
  if(_lbItem.confirmed&&!_lbDeletePending){
    _lbDeletePending=true;
    const btn=byId('lightboxDelete');
    if(btn){btn.classList.add('confirm-delete');btn.innerHTML='<span>🗑</span><span style="font-size:9px">↓ nochmal</span>';}
    return;
  }
  byId('lightboxDelete').click();
}
const _LB_CHECK_SVG=`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,12 9,18 20,6"/></svg>`;
const _LB_CHECK2_SVG=`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="1,13 6,18 13,9"/><polyline points="10,13 15,18 23,6"/></svg>`;
const _LB_HINT='<span style="font-size:9px;line-height:1;opacity:.7;white-space:nowrap">↑ behalten</span>';
const _LB_TRASH_HTML='<span style="font-size:14px;line-height:1;opacity:.8">↓</span><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,6 5,6 21,6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>';
function _updateLbConfirmBtn(confirmed){
  const btn=byId('lightboxConfirm');
  if(!btn) return;
  if(confirmed){
    btn.style.background='#166534';
    btn.innerHTML=_LB_CHECK2_SVG;
    btn.title='Bestätigt';
  } else {
    btn.style.background='';
    btn.innerHTML=_LB_CHECK_SVG;
    btn.title='Behalten (↑)';
  }
}
// ── Detection-bbox overlay ───────────────────────────────────────────────────
// Draws coloured rectangles + labels over the active lightbox media. Bbox
// coords come from _lbItem.detections[].bbox in the original frame's pixel
// space; we scale them to the object-fit:contain rendered rectangle so they
// line up whether the media is letterboxed vertically or horizontally.
function _lbDrawDetections(){
  const cv=byId('lightboxDetections'); if(!cv||!_lbItem) return;
  const ctx=cv.getContext('2d');
  const videoEl=byId('lightboxVideo');
  const imgEl=byId('lightboxImg');
  const usingVideo=videoEl&&videoEl.style.display!=='none'&&videoEl.videoWidth>0;
  const usingImage=imgEl&&imgEl.style.display!=='none'&&imgEl.naturalWidth>0;
  const media=usingVideo?videoEl:(usingImage?imgEl:null);
  if(!media){ _lbClearDetections(); return; }
  const natW=usingVideo?videoEl.videoWidth:imgEl.naturalWidth;
  const natH=usingVideo?videoEl.videoHeight:imgEl.naturalHeight;
  const wrap=byId('lightboxMediaWrap'); if(!wrap) return;
  const wrapRect=wrap.getBoundingClientRect();
  const mediaRect=media.getBoundingClientRect();
  // Size the canvas to cover the wrap; use DPR for crisp strokes.
  const dpr=window.devicePixelRatio||1;
  cv.style.width=wrapRect.width+'px'; cv.style.height=wrapRect.height+'px';
  cv.width=Math.round(wrapRect.width*dpr);
  cv.height=Math.round(wrapRect.height*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,wrapRect.width,wrapRect.height);
  const dets=(_lbItem.detections||[]).filter(d=>d&&d.bbox&&typeof d.bbox.x1==='number');
  if(!dets.length) return;
  // object-fit:contain inside the media element
  const scale=Math.min(mediaRect.width/natW,mediaRect.height/natH);
  const renderedW=natW*scale, renderedH=natH*scale;
  const offX=(mediaRect.width-renderedW)/2+(mediaRect.left-wrapRect.left);
  const offY=(mediaRect.height-renderedH)/2+(mediaRect.top-wrapRect.top);
  ctx.font='600 12px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  ctx.textBaseline='top';
  for(const d of dets){
    const b=d.bbox;
    const x1=offX+b.x1*scale, y1=offY+b.y1*scale;
    const x2=offX+b.x2*scale, y2=offY+b.y2*scale;
    const w=x2-x1, h=y2-y1;
    if(w<=0||h<=0) continue;
    const c=colors[d.label]||colors.unknown;
    ctx.save();
    ctx.shadowColor=c; ctx.shadowBlur=6;
    ctx.strokeStyle=c; ctx.lineWidth=2;
    ctx.strokeRect(x1,y1,w,h);
    ctx.restore();
    const lbl=OBJ_LABEL[d.label]||d.label||'';
    if(lbl){
      const padX=6, pillH=18;
      const tw=ctx.measureText(lbl).width;
      const pillY=Math.max(0,y1-pillH-2);
      ctx.fillStyle='rgba(0,0,0,0.72)';
      ctx.fillRect(x1,pillY,tw+padX*2,pillH);
      ctx.fillStyle=c;
      ctx.fillText(lbl,x1+padX,pillY+3);
    }
  }
}
function _lbClearDetections(){
  const cv=byId('lightboxDetections'); if(!cv) return;
  const ctx=cv.getContext('2d');
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,cv.width,cv.height);
}
// Wire the one-time draw/clear hooks. load fires even for cached images,
// so reopening the same snapshot still repaints. A single RAF-debounced
// resize handler handles window resize while the lightbox is visible.
(function _initLbDetectionsHooks(){
  const imgEl=byId('lightboxImg');
  const videoEl=byId('lightboxVideo');
  if(imgEl) imgEl.addEventListener('load',()=>_lbDrawDetections());
  if(videoEl) videoEl.addEventListener('loadedmetadata',()=>_lbDrawDetections());
  let _raf=0;
  window.addEventListener('resize',()=>{
    if(!byId('lightboxModal')||byId('lightboxModal').classList.contains('hidden')) return;
    cancelAnimationFrame(_raf);
    _raf=requestAnimationFrame(_lbDrawDetections);
  });
})();

function _lbResetToPhoto(){
  // Ensure photo mode is active (cleanup from any prior timelapse view)
  const videoEl=byId('lightboxVideo');
  if(videoEl){videoEl.pause();videoEl.src='';videoEl.style.display='none';}
  byId('lightboxImg').style.display='';
  _lbClearDetections();
  const errEl=byId('lightboxErrorMsg');
  if(errEl) errEl.style.display='none';
  const confirmBtn=byId('lightboxConfirm');
  if(confirmBtn) confirmBtn.style.display='';
}
function _lbShowError(text){
  let errEl=byId('lightboxErrorMsg');
  if(!errEl){
    errEl=document.createElement('div');
    errEl.id='lightboxErrorMsg';
    errEl.style.cssText='align-items:center;justify-content:center;width:100%;min-height:240px;max-height:80vh;color:rgba(255,255,255,.55);font-size:15px;font-weight:500;background:#080510;border-radius:18px';
    const wrap=byId('lightboxMediaWrap');
    if(wrap) wrap.appendChild(errEl);
  }
  errEl.textContent=text;
  errEl.style.display='flex';
  byId('lightboxImg').style.display='none';
  const videoEl=byId('lightboxVideo');
  if(videoEl){videoEl.style.display='none';videoEl.pause();videoEl.src='';}
}
function openLightbox(item){
  if(item.type==='timelapse'){openTLPlayer(item);return;}
  // iOS hand-off — for video items, skip the custom shell entirely and
  // give Safari its native player. The doubled-chrome problem (lightbox
  // buttons + iOS controls overlapping) goes away because there's no
  // shell to render on top of the player. Action sheet fills the gap
  // for tag/confirm/delete after the player closes.
  const _hasVideoSrc=!!(item && (item.video_relpath||item.video_url));
  if(IS_IOS && _hasVideoSrc){ _iosNativeVideoOpen(item); return; }
  // Index into the GLOBAL list (state._allMedia) so prev/next can cross
  // pagination boundaries — the page-slice (state.media) is a render
  // optimisation, not a navigation boundary.
  const globalList=state._allMedia||[];
  _lbIndex=globalList.findIndex(x=>x.event_id===item.event_id);
  if(_lbIndex===-1){
    // Fallback: item came from somewhere outside the cached merged list
    // (rare). Open it anyway with single-item nav so the lightbox still
    // works — just no prev/next.
    _lbIndex=0;
    _lbItem=item;
  } else {
    _lbItem=globalList[_lbIndex];
  }
  // If the navigated item lives outside the current page window, jump
  // the grid's page so the thumbnails behind the lightbox match what
  // the user sees on the lightbox itself. Re-rendering keeps current
  // scroll because the user is still inside the lightbox modal.
  const ps=_cachedPageSize||calcItemsPerPage();
  if(_cachedPageSize && globalList.length>0){
    const targetPage=Math.floor(_lbIndex/ps);
    if(targetPage!==state.mediaPage){
      state.mediaPage=targetPage;
      const offset=targetPage*ps;
      state.media=globalList.slice(offset,offset+ps);
      try{renderMediaGrid();renderMediaPagination();}catch(_){}
    }
  }
  _lbDeletePending=false;
  _lbResetToPhoto();
  const delBtn=byId('lightboxDelete');
  if(delBtn){delBtn.classList.remove('confirm-delete');delBtn.innerHTML=_LB_TRASH_HTML;delBtn.title=_lbItem.confirmed?'Bestätigt — trotzdem löschen?':'Löschen';}
  _updateLbConfirmBtn(_lbItem.confirmed);
  // Show video player for motion clips, image for snapshots
  const vidSrc=_lbItem.video_relpath?`/media/${_lbItem.video_relpath}`:(_lbItem.video_url||'');
  const imgSrc=_lbItem.snapshot_relpath?`/media/${_lbItem.snapshot_relpath}`:(_lbItem.snapshot_url||'');
  const hasVideoLabel=(_lbItem.labels||[]).some(l=>['motion','car','person','cat','bird','dog','squirrel'].includes(l));
  const pendingMsg=_lbItem.status==='recording'?'Video wird aufgenommen…':_lbItem.status==='processing'?'Video wird verarbeitet…':null;
  if(pendingMsg){
    _lbShowError(pendingMsg);
  } else if(vidSrc){
    const imgEl=byId('lightboxImg'); imgEl.style.display='none';
    const videoEl=byId('lightboxVideo');
    videoEl.style.display='block'; videoEl.src=vidSrc; videoEl.muted=true; videoEl.loop=true;
    videoEl.load(); videoEl.play().catch(()=>{});
  } else if(!imgSrc && (hasVideoLabel || _lbItem.encode_error)){
    _lbShowError('Video nicht verfügbar');
  } else {
    byId('lightboxImg').src=imgSrc;
  }
  const confirmedBadge=_lbItem.confirmed?`<span style="background:#166534;color:#4ade80;border-radius:999px;padding:3px 10px;font-size:11px;font-weight:700">✓ Behalten</span>`:'';
  byId('lightboxMeta').innerHTML=`
    <span class="badge">${esc(_lbItem.camera_id||'')}</span>
    <span class="badge">${esc(_lbItem.time||'')}</span>
    ${vidSrc?'<span class="badge">🎬 Video</span>':''}
    ${confirmedBadge}`;
  _renderLbLabels();
  // Edge dim only at the GLOBAL boundaries — page edges navigate through.
  byId('lightboxPrev').style.opacity=_lbIndex>0?'1':'0.2';
  byId('lightboxNext').style.opacity=_lbIndex<((state._allMedia||[]).length-1)?'1':'0.2';
  byId('lightboxModal').classList.remove('hidden');
  document.body.style.overflow='hidden';
}
function _tlNavItems(){
  // Timelapse + motion events share state._allMedia now — navigation is uniform.
  return state._allMedia||[];
}
function _tlPeriodLabel(item){
  if(item.period_s>0){
    const p=item.period_s,d=item.target_s||0;
    const pl=p<3600?Math.round(p/60)+'min':p<86400?Math.round(p/3600)+'h':p<604800?'daily':p<2592000?'weekly':'monthly';
    const dl=d<60?d+'sec':Math.floor(d/60)+'min';
    return `${pl}→${dl}`;
  }
  const raw=item.profile||item.period||'';
  if(raw==='rolling_10min') return '10 min';
  if(raw==='hour') return 'Stunde';
  if(raw==='custom') return 'Custom';
  if(raw==='daily'||raw==='day') return 'Tag';
  if(raw==='weekly') return 'Woche';
  if(raw==='monthly') return 'Monat';
  return raw||'Timelapse';
}
function openTLPlayer(item){
  const navItems=_tlNavItems();
  _lbIndex=navItems.findIndex(x=>x.event_id===item.event_id);
  _lbItem=_lbIndex>=0?navItems[_lbIndex]:item;
  // Jump the grid page when this item lives outside the current page
  // window, so the thumbnails behind the lightbox match the lightbox
  // content — same rule as openLightbox above.
  const ps=_cachedPageSize||calcItemsPerPage();
  if(_lbIndex>=0 && _cachedPageSize && navItems.length>0){
    const targetPage=Math.floor(_lbIndex/ps);
    if(targetPage!==state.mediaPage){
      state.mediaPage=targetPage;
      const offset=targetPage*ps;
      state.media=navItems.slice(offset,offset+ps);
      try{renderMediaGrid();renderMediaPagination();}catch(_){}
    }
  }
  _lbDeletePending=false;
  _lbClearDetections();
  const imgEl=byId('lightboxImg'); imgEl.style.display='none';
  const videoEl=byId('lightboxVideo');
  const videoSrc=(item.video_relpath?'/media/'+item.video_relpath:'')||item.video_url||item.url||(item.relpath?'/media/'+item.relpath:'');
  videoEl.style.display='block'; videoEl.src=videoSrc; videoEl.load(); videoEl.play().catch(()=>{});
  const confirmBtn=byId('lightboxConfirm'); if(confirmBtn) confirmBtn.style.display='none';
  byId('lightboxLabels').innerHTML='';
  const delBtn=byId('lightboxDelete');
  if(delBtn){delBtn.classList.remove('confirm-delete');delBtn.innerHTML=_LB_TRASH_HTML;delBtn.title='Timelapse löschen';}
  const period=_tlPeriodLabel(item);
  const sizeBadge=item.size_mb!=null?`<span class="badge">${item.size_mb} MB</span>`:'';
  byId('lightboxMeta').innerHTML=`
    <span class="badge">${esc(item.camera_id||'')}</span>
    <span class="badge">Timelapse · ${esc(period)}</span>
    <span class="badge">${esc(item.window_key||item.day||'')}</span>
    ${sizeBadge}`;
  const total=navItems.length;
  byId('lightboxPrev').style.opacity=_lbIndex>0?'1':'0.2';
  byId('lightboxNext').style.opacity=_lbIndex<total-1?'1':'0.2';
  byId('lightboxModal').classList.remove('hidden');
  document.body.style.overflow='hidden';
}
function closeLightbox(){
  if(document.fullscreenElement||document.webkitFullscreenElement){
    (document.exitFullscreen||document.webkitExitFullscreen||function(){}).call(document).catch(()=>{});
  }
  byId('lightboxModal').classList.add('hidden');
  document.body.style.overflow='';
  _lbItem=null; _lbIndex=-1;
  const videoEl=byId('lightboxVideo');
  if(videoEl){videoEl.pause();videoEl.src='';videoEl.style.display='none';}
  byId('lightboxImg').style.display='';
  _lbClearDetections();
  const confirmBtn=byId('lightboxConfirm'); if(confirmBtn) confirmBtn.style.display='';
}
byId('lightboxClose').onclick=closeLightbox;
byId('lightboxModal').onclick=(e)=>{if(e.target===byId('lightboxModal')) closeLightbox();};
// Lightbox navigation list — the merged-and-sorted global media list for
// BOTH motion and timelapse items. EventStore unifies the two kinds, so
// prev/next walks the global timeline regardless of the current page or
// item type. _tlNavItems() returns the same list (kept as an alias for
// historical reasons + the timelapse-only callers).
function _lbNavList(){return state._allMedia||[];}
byId('lightboxPrev').onclick=()=>{const nav=_lbNavList();const i=nav.findIndex(x=>x.event_id===_lbItem?.event_id);if(i>0) openLightbox(nav[i-1]);};
byId('lightboxNext').onclick=()=>{const nav=_lbNavList();const i=nav.findIndex(x=>x.event_id===_lbItem?.event_id);if(i>=0&&i<nav.length-1) openLightbox(nav[i+1]);};
document.addEventListener('keydown',(e)=>{
  // Live view ESC close (takes priority)
  if(e.key==='Escape'&&!byId('liveViewModal')?.classList.contains('hidden')){closeLiveView();return;}
  const lbOpen=!byId('lightboxModal').classList.contains('hidden');
  if(!lbOpen){
    // Drilldown back-nav: Backspace or Escape returns to overview when no lightbox is open.
    // Skip when the user is typing in an input/textarea so editable fields keep their normal behavior.
    if((e.key==='Escape'||e.key==='Backspace')
       && byId('mediaDrilldown')?.style.display!=='none'){
      const t=e.target;
      const isEditable=t && (t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.isContentEditable);
      if(!isEditable){e.preventDefault();closeMediaDrilldown();return;}
    }
    return;
  }
  const _v=byId('lightboxVideo');
  const _videoActive=!!(_v && _v.style.display!=='none' && _v.src);
  if(e.key==='ArrowLeft'){
    e.preventDefault();
    if(_videoActive){
      _v.currentTime=Math.max(0,(_v.currentTime||0)-10);
      _lbShowSeekOverlay('−10s');
    } else {
      const nav=_lbNavList();const i=nav.findIndex(x=>x.event_id===_lbItem?.event_id);
      if(i>0) openLightbox(nav[i-1]);
    }
  }
  else if(e.key==='ArrowRight'){
    e.preventDefault();
    if(_videoActive){
      const dur=_v.duration||0;
      const next=(_v.currentTime||0)+10;
      _v.currentTime=dur>0?Math.min(dur,next):next;
      _lbShowSeekOverlay('+10s');
    } else {
      const nav=_lbNavList();const i=nav.findIndex(x=>x.event_id===_lbItem?.event_id);
      if(i>=0&&i<nav.length-1) openLightbox(nav[i+1]);
    }
  }
  else if(e.key==='ArrowUp'){e.preventDefault();byId('lightboxConfirm').click();}
  else if(e.key==='ArrowDown'){e.preventDefault();_lbHandleDeleteKey();}
  else if(e.key===' '){
    if(_videoActive){
      e.preventDefault();
      if(_v.paused) _v.play().catch(()=>{}); else _v.pause();
    }
  }
  else if(e.key==='f'||e.key==='F'){
    if(_videoActive){
      e.preventDefault();
      const fsElem=document.fullscreenElement||document.webkitFullscreenElement;
      if(fsElem){
        (document.exitFullscreen||document.webkitExitFullscreen||function(){}).call(document).catch(()=>{});
      } else {
        const req=_v.requestFullscreen||_v.webkitRequestFullscreen||_v.webkitEnterFullscreen;
        if(req) req.call(_v).catch(()=>{});
      }
    }
  }
  else if(e.key==='Escape') closeLightbox();
});
let _lbSeekOverlayTimer=null;
function _lbShowSeekOverlay(text){
  const wrap=byId('lightboxMediaWrap'); if(!wrap) return;
  let el=byId('lightboxSeekOverlay');
  if(!el){
    el=document.createElement('div');
    el.id='lightboxSeekOverlay';
    el.style.cssText='position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.72);color:#fff;font-size:34px;font-weight:800;padding:14px 26px;border-radius:14px;pointer-events:none;z-index:5;backdrop-filter:blur(8px);opacity:0;transition:opacity .2s ease;letter-spacing:.02em';
    wrap.appendChild(el);
  }
  el.textContent=text;
  // force reflow so a rapid second press retriggers the fade-in
  el.style.opacity='0'; void el.offsetWidth; el.style.opacity='1';
  clearTimeout(_lbSeekOverlayTimer);
  _lbSeekOverlayTimer=setTimeout(()=>{el.style.opacity='0';},600);
}
_updateLbConfirmBtn(false);
byId('lightboxDelete').innerHTML=_LB_TRASH_HTML;
_initFsBtn('liveViewFsBtn',byId('liveViewWrap'),()=>byId('liveViewWrap'));
// ── iOS native video player handoff ───────────────────────────────────────
// For VIDEO items on iOS we skip the custom lightbox entirely and let
// Safari render its standalone fullscreen player. The shell would only
// stack on top of it (the previous "hide shell on webkitbeginfullscreen"
// attempt was unreliable across iOS versions). After the player closes
// the user gets an inline action sheet for tags / confirm / delete /
// prev / next so the workflow doesn't lose those affordances.
let _iosCurrentVideo=null;     // the transient <video> currently playing
let _iosCurrentItem=null;      // the media item bound to that video
function _iosNativeVideoOpen(item){
  if(!item) return;
  // Tear down any previous transient first.
  _iosTeardownVideo();
  // Keep _lbItem / _lbIndex in sync with state._allMedia for the
  // inline ✓/✗ buttons on each card to operate on the right entry.
  const globalList=state._allMedia||[];
  const idx=globalList.findIndex(x=>x.event_id===item.event_id);
  _lbIndex=idx>=0?idx:0;
  _lbItem=idx>=0?globalList[idx]:item;
  _iosCurrentItem=_lbItem;
  const vidSrc=_lbItem.video_relpath?`/media/${_lbItem.video_relpath}`:(_lbItem.video_url||'');
  if(!vidSrc){ showToast('Video nicht verfügbar','error'); return; }
  const v=document.createElement('video');
  v.src=vidSrc;
  v.controls=true;
  // CRITICAL: must be false on iOS so .play() can trigger native FS.
  v.playsInline=false;
  v.preload='metadata';
  // Off-screen but mounted so iOS keeps the element alive while playing.
  v.style.cssText='position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1';
  document.body.appendChild(v);
  _iosCurrentVideo=v;
  const _onEnd=()=>{
    // Closing the iOS native player just returns the user to the grid.
    // The inline ✓/✗ on each card handle confirm/delete; the old
    // floating action sheet (Behalten/Tags/Löschen/prev/next) was a
    // desktop-era leftover that briefly appeared then faded out.
    _iosTeardownVideo();
  };
  v.addEventListener('webkitendfullscreen',_onEnd);
  v.addEventListener('ended',_onEnd);
  // Best-effort error fallback so a bad src doesn't strand the user.
  v.addEventListener('error',()=>{ _iosTeardownVideo(); showToast('Video konnte nicht geladen werden','error'); });
  // Try .play() first — on most iOS versions this triggers native FS.
  // If that's blocked, fall back to the explicit webkitEnterFullscreen
  // path which works under direct user-gesture context.
  const _attempt=()=>{
    const p=v.play();
    if(p && p.catch){
      p.catch(()=>{
        try{
          if(v.webkitEnterFullscreen) v.webkitEnterFullscreen();
          v.play().catch(()=>{});
        }catch{}
      });
    }
  };
  _attempt();
}
function _iosTeardownVideo(){
  const v=_iosCurrentVideo;
  if(!v) return;
  try{ v.pause(); v.removeAttribute('src'); v.load(); }catch{}
  if(v.parentNode) v.parentNode.removeChild(v);
  _iosCurrentVideo=null;
}
// Swipe navigation on the lightbox media area (mobile). Horizontal
// swipe = prev/next, vertical swipe ≥ 80 px down = dismiss.
(function initLightboxSwipe(){
  const wrap=byId('lightboxMediaWrap');
  const modal=byId('lightboxModal');
  if(!wrap||!modal) return;
  let _tx=0,_ty=0,_dragging=false;
  wrap.addEventListener('touchstart',e=>{
    if(e.touches.length!==1) return;
    _tx=e.touches[0].clientX;
    _ty=e.touches[0].clientY;
    _dragging=true;
  },{passive:true});
  wrap.addEventListener('touchend',e=>{
    if(!_dragging) return;
    _dragging=false;
    const dx=e.changedTouches[0].clientX-_tx;
    const dy=e.changedTouches[0].clientY-_ty;
    // Vertical wins when its magnitude exceeds horizontal — protects
    // pinch-zoom-finished and pure scroll gestures from triggering nav.
    if(Math.abs(dy)>Math.abs(dx)){
      if(dy>=80) closeLightbox();
      return;
    }
    if(Math.abs(dx)<40) return;
    if(dx<0) byId('lightboxNext')?.click();
    else byId('lightboxPrev')?.click();
  },{passive:true});
})();
byId('lightboxConfirm').onclick=async()=>{
  if(!_lbItem) return;
  const{camera_id,event_id}=_lbItem;
  if(!camera_id||!event_id) return;
  try{
    await j(`/api/camera/${encodeURIComponent(camera_id)}/events/${encodeURIComponent(event_id)}/confirm`,{method:'POST'});
    // update state.media in place
    const sIdx=(state.media||[]).findIndex(x=>x.event_id===event_id);
    if(sIdx>=0) state.media[sIdx].confirmed=true;
    _updateLbConfirmBtn(true);
    if(_lbItem) _lbItem.confirmed=true;
    // update card DOM
    const card=byId('mediaGrid').querySelector(`[data-event-id="${CSS.escape(event_id)}"]`);
    if(card){
      card.classList.add('mmc-confirmed');
      const actions=card.querySelector('.mmc-actions');
      if(actions) actions.outerHTML='<span class="media-confirmed-badge">✓</span>';
    }
    // auto-advance to next item (use fresh index)
    const ci=(state.media||[]).findIndex(x=>x.event_id===event_id);
    const nextIdx=ci+1;
    if(nextIdx>0&&nextIdx<(state.media||[]).length) openLightbox(state.media[nextIdx]);
    else closeLightbox();
  }catch(e){showToast('Bestätigen fehlgeschlagen: '+e.message,'error');}
};
byId('lightboxDelete').onclick=async()=>{
  if(!_lbItem) return;
  // Timelapse deletion
  if(_lbItem.type==='timelapse'){
    if(!_lbDeletePending){
      _lbDeletePending=true;
      const btn=byId('lightboxDelete');
      if(btn){btn.classList.add('confirm-delete');btn.innerHTML='<span style="font-size:15px;line-height:1;opacity:.75">↓</span><span style="font-size:11px">nochmal</span>';}
      return;
    }
    const filename=_lbItem.filename||(_lbItem.relpath||'').split('/').pop();
    if(!filename){showToast('Dateiname fehlt','error');return;}
    try{
      await j(`/api/camera/${encodeURIComponent(_lbItem.camera_id)}/timelapse/${encodeURIComponent(filename)}`,{method:'DELETE'});
      const deletedId=_lbItem.event_id;
      state.media=(state.media||[]).filter(x=>x.event_id!==deletedId);
      state._allMedia=(state._allMedia||[]).filter(x=>x.event_id!==deletedId);
      renderMediaGrid();
      const nav=_tlNavItems();
      const nextIdx=Math.min(_lbIndex,nav.length-1);
      if(nextIdx<0) closeLightbox();
      else openLightbox(nav[nextIdx]);
    }catch(e){showToast('Löschen fehlgeschlagen: '+e.message,'error');}
    return;
  }
  // Photo event deletion
  const{camera_id,event_id}=_lbItem;
  if(!camera_id||!event_id) return;
  try{
    const imgEl=byId('lightboxImg');
    if(imgEl){imgEl.style.transform='scale(0.88)';imgEl.style.opacity='0';}
    await new Promise(r=>setTimeout(r,200));
    if(imgEl){imgEl.style.transform='';imgEl.style.opacity='';}
    await j(`/api/camera/${encodeURIComponent(camera_id)}/events/${encodeURIComponent(event_id)}`,{method:'DELETE'});
    // Remove from client-side pool and re-paginate so the current page refills
    state._allMedia=(state._allMedia||[]).filter(x=>x.event_id!==event_id);
    const ps_lb=calcItemsPerPage();
    state.mediaTotalPages=Math.max(1,Math.ceil(state._allMedia.length/ps_lb));
    state.mediaPage=Math.min(state.mediaPage||0,state.mediaTotalPages-1);
    state.media=state._allMedia.slice(state.mediaPage*ps_lb,(state.mediaPage+1)*ps_lb);
    if(state.media.length===0&&state.mediaPage>0){
      state.mediaPage--;
      state.media=state._allMedia.slice(state.mediaPage*ps_lb,(state.mediaPage+1)*ps_lb);
    }
    renderMediaGrid();
    renderMediaPagination();
    _lbIndex=Math.min(_lbIndex,(state.media||[]).length-1);
    if(_lbIndex<0) closeLightbox();
    else openLightbox(state.media[_lbIndex]);
    await refreshTimelineAndStats();
  }catch(e){showToast('Löschen fehlgeschlagen: '+e.message,'error');}
};

// ── Media overview + drill-down ───────────────────────────────────────────────
const CAM_COLORS=['#3b82f6','#f59e0b','#10b981','#8b5cf6','#ef4444','#06b6d4','#ec4899','#84cc16'];
function camColor(camId){
  const idx=state.cameras.findIndex(c=>c.id===camId);
  return CAM_COLORS[(idx<0?0:idx)%CAM_COLORS.length];
}
const _TL_FILMSTRIP=`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" stroke-width="2" stroke-linecap="round" style="flex-shrink:0"><line x1="6" y1="3" x2="18" y2="3"/><line x1="6" y1="21" x2="18" y2="21"/><polygon points="7,4 17,4 12,12" fill="#c4b5fd" opacity=".8"/><polygon points="12,12 7,20 17,20" fill="#c4b5fd" opacity=".5"/></svg>`;
function hexToRgba(hex,alpha){
  const h=(hex||'').replace('#','');
  if(h.length!==6) return `rgba(147,197,253,${alpha})`;
  const r=parseInt(h.substring(0,2),16);
  const g=parseInt(h.substring(2,4),16);
  const b=parseInt(h.substring(4,6),16);
  return `rgba(${r},${g},${b},${alpha})`;
}
function getMediaAccentColor(labels){
  if(Array.isArray(labels)){
    for(const l of labels){
      if(colors[l]) return colors[l];
    }
  }
  return colors.motion||'#93c5fd';
}
function fmtMediaDate(ts){
  if(!ts) return '';
  try{
    const d=new Date(ts.replace(' ','T'));
    return d.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'});
  }catch{return '';}
}
function fmtMediaTimeOnly(ts){
  if(!ts) return '';
  try{
    const d=new Date(ts.replace(' ','T'));
    return d.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
  }catch{return '';}
}
function mediaCardHTML(item){
  // Primary (bold white) badge — shared across all card types
  const badgeStyle='font-size:10px;font-weight:700;color:#e2e8f0;background:rgba(0,0,0,.68);backdrop-filter:blur(3px);padding:2px 6px;border-radius:4px;line-height:1.45;white-space:nowrap';
  // Secondary (dimmer, accent-colored) badge — color added per-branch via accent
  const subBadgeBase='font-size:10px;background:none;backdrop-filter:blur(3px);padding:0 6px;border-radius:4px;line-height:1.45;white-space:nowrap;margin-top:1px;opacity:0.85';
  const isTL=item.type==='timelapse';
  if(isTL){
    const wk=item.window_key||item.day||'';
    const datePart=wk.substring(0,10);
    const timePart=wk.length>=15?wk.substring(11,13)+':'+wk.substring(13,15):'';
    const durLabel=item.target_s!=null?(item.target_s<60?item.target_s+'s':Math.floor(item.target_s/60)+'min'):'';
    const sizeText=item.size_mb!=null?item.size_mb+' MB':'';
    const thumbSrc=item.thumb_url||'';
    const thumbEl=thumbSrc
      ? `<img src="${esc(thumbSrc)}" alt="preview" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;opacity:.7" loading="lazy" onerror="this.remove()">`
      : '';
    const tlAccent=getMediaAccentColor(['timelapse']);
    const tlPlayBg=hexToRgba(tlAccent,0.18);
    const tlPlayBorder=hexToRgba(tlAccent,0.5);
    const tlSubBadge=`${subBadgeBase};color:${tlAccent}`;
    return `<article class="media-card mmc-tl" data-event-id="${esc(item.event_id||'')}" data-camera-id="${esc(item.camera_id||'')}">
      <div class="mmc-img-wrap" onclick="window._openMediaItem('${esc(item.event_id||'')}')">
        ${thumbEl}
        <div style="position:absolute;inset:0;z-index:1;display:flex;align-items:center;justify-content:center">
          <div class="mmc-play-btn" style="background:${tlPlayBg};border:1.5px solid ${tlPlayBorder}"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="color:${tlAccent};margin-left:2px"><polygon points="5,3 19,12 5,21"/></svg></div>
        </div>
        <div style="position:absolute;bottom:7px;left:8px;z-index:2;pointer-events:none;width:fit-content">
          ${datePart?`<div style="${badgeStyle}">${esc(datePart)}</div>`:''}
          ${timePart?`<div style="${tlSubBadge}">${esc(timePart)}</div>`:''}
        </div>
        ${(durLabel||sizeText)?`<div style="position:absolute;bottom:7px;right:8px;z-index:2;pointer-events:none;display:flex;flex-direction:column;align-items:flex-end;gap:2px">
          ${durLabel?`<div style="${badgeStyle}">${esc(durLabel)}</div>`:''}
          ${sizeText?`<div style="${tlSubBadge}">${esc(sizeText)}</div>`:''}
        </div>`:''}
        <div style="position:absolute;top:6px;left:6px;z-index:2"><span class="mmc-tl-badge">${objIconSvg('timelapse',12)}Timelapse</span></div>
        <div class="mmc-actions" style="z-index:3">
          <button class="mmc-btn mmc-delete" title="Löschen" onclick="event.stopPropagation();window.deleteTLCard('${esc(item.camera_id||'')}','${esc(item.filename||'')}','${esc(item.event_id||'')}')">✕</button>
        </div>
      </div>
    </article>`;
  }
  const isProcessing=item.status==='recording'||item.status==='processing';
  const hasVideo=!!(item.video_relpath||item.video_url);
  const showPlayer=hasVideo||!!item.encode_error;
  const imgSrc=item.snapshot_relpath?`/media/${item.snapshot_relpath}`:(item.snapshot_url||'');
  const confirmed=item.confirmed?'mmc-confirmed':'';
  const labelBubbles=(item.labels||[]).slice(0,3).map(l=>objBubble(l,26)).join('');
  const fmtDur=s=>{if(!s||s<=0)return'';const m=Math.floor(s/60),sec=Math.round(s%60);return`${m}:${String(sec).padStart(2,'0')}`;};
  const fmtByt=b=>{if(!b||b<=0)return'';if(b>=1048576)return(b/1048576).toFixed(1)+' MB';return Math.round(b/1024)+' KB';};
  const accent=getMediaAccentColor(item.labels);
  const playBg=hexToRgba(accent,0.18);
  const playBorder=hexToRgba(accent,0.5);
  const subBadge=`${subBadgeBase};color:${accent}`;
  // Pick most-specific label (first non-motion) for the top-left badge; fall back to motion
  const _badgeLabel=(item.labels||[]).find(l=>l && l!=='motion') || 'motion';
  const _badgeColor=colors[_badgeLabel]||colors.motion||'#93c5fd';
  // When the bird classifier has identified a species, show it instead of the
  // generic "Vogel" — keeps bird colour + icon but tells the user what kind.
  const _badgeText=(_badgeLabel==='bird' && item.bird_species) ? item.bird_species : (OBJ_LABEL[_badgeLabel]||_badgeLabel);
  // Inline overrides only border-color and text color; .mmc-tl-badge supplies dark bg + blur + shadow
  const motionBadge=`<div style="position:absolute;top:6px;left:6px;z-index:2"><span class="mmc-tl-badge" style="border-color:${hexToRgba(_badgeColor,0.7)};color:${_badgeColor}">${objIconSvg(_badgeLabel,12)}${esc(_badgeText)}</span></div>`;
  const errorBadge=item.encode_error?`<div style="position:absolute;bottom:7px;left:50%;transform:translateX(-50%);z-index:4"><span title="${esc(item.encode_error)}" style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:rgba(250,204,21,.18);border:1px solid rgba(250,204,21,.5);color:#facc15;font-size:13px;font-weight:800;backdrop-filter:blur(4px)">⚠</span></div>`:'';
  const vidDate=fmtMediaDate(item.time||'');
  const vidTime=fmtMediaTimeOnly(item.time||'');
  const vidDur=fmtDur(item.duration_s);
  const vidSize=fmtByt(item.file_size_bytes);
  const procMsg=item.status==='recording'?'wird aufgenommen…':'wird verarbeitet…';
  const processingInner=`<div style="position:absolute;inset:0;background:#0a0e1a;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px">
        <div style="width:42px;height:42px;border:3px solid ${hexToRgba(colors.motion,0.2)};border-top-color:${colors.motion};border-radius:50%;animation:spin 1s linear infinite"></div>
        <div style="font-size:11px;color:${colors.motion};font-weight:600">${procMsg}</div>
      </div>
      ${motionBadge}`;
  const videoThumbEl=(showPlayer&&imgSrc)
    ? `<img src="${esc(imgSrc)}" alt="preview" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.7" loading="lazy" onerror="this.remove()">`
    : '';
  const mediaInner=isProcessing
    ?processingInner
    :showPlayer
    ?`<div style="position:absolute;inset:0;background:#0a0e1a">${videoThumbEl}</div>
      <div style="position:absolute;inset:0;z-index:1;display:flex;align-items:center;justify-content:center">
        <div class="mmc-play-btn" style="background:${playBg};border:1.5px solid ${playBorder}"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="color:${accent};margin-left:3px"><polygon points="5,3 19,12 5,21"/></svg></div>
      </div>
      ${(vidDate||vidTime)?`<div style="position:absolute;bottom:7px;left:8px;z-index:2;pointer-events:none;width:fit-content">
        ${vidDate?`<div style="${badgeStyle}">${esc(vidDate)}</div>`:''}
        ${vidTime?`<div style="${subBadge}">${esc(vidTime)}</div>`:''}
      </div>`:''}
      ${(vidDur||vidSize)?`<div style="position:absolute;bottom:7px;right:8px;z-index:2;pointer-events:none;display:flex;flex-direction:column;align-items:flex-end;gap:2px">
        ${vidDur?`<div style="${badgeStyle}">${vidDur}</div>`:''}
        ${vidSize?`<div style="${subBadge}">${vidSize}</div>`:''}
      </div>`:''}
      ${motionBadge}
      ${errorBadge}`
    :`<img src="${esc(imgSrc)}" alt="event" loading="lazy" onerror="this.style.display='none'" />
      ${(vidDate||vidTime)?`<div style="position:absolute;bottom:7px;left:8px;z-index:2;pointer-events:none;width:fit-content">
        ${vidDate?`<div style="${badgeStyle}">${esc(vidDate)}</div>`:''}
        ${vidTime?`<div style="${subBadge}">${esc(vidTime)}</div>`:''}
      </div>`:''}
      ${vidSize?`<div style="position:absolute;bottom:7px;right:8px;z-index:2;pointer-events:none;display:flex;flex-direction:column;align-items:flex-end;gap:2px">
        <div style="${subBadge}">${vidSize}</div>
      </div>`:''}`;
  return `<article class="media-card ${confirmed}" data-event-id="${esc(item.event_id||'')}" data-camera-id="${esc(item.camera_id||'')}">
    <div class="mmc-img-wrap" onclick="window._openMediaItem('${esc(item.event_id||'')}')">
      ${mediaInner}
      ${showPlayer?'':`<div class="media-label-bubbles">${labelBubbles}</div>`}
      ${item.confirmed
        ? `<span class="media-confirmed-badge">✓</span>`
        : `<div class="mmc-actions">
        <button class="mmc-btn mmc-confirm" title="Bestätigen" onclick="event.stopPropagation();window.confirmMediaCard('${esc(item.camera_id||'')}','${esc(item.event_id||'')}',this)">✓</button>
        <button class="mmc-btn mmc-delete" title="Löschen" onclick="event.stopPropagation();window.deleteMediaCard(this)">✕</button>
      </div>`}
    </div>
  </article>`;
}
function _fmtMb(mb){
  if(!mb||mb<=0) return '0 MB';
  if(mb>=1024) return (mb/1024).toFixed(1)+' GB';
  return Math.round(mb)+' MB';
}
// Archive icon — box with lid and latch
const _ARCHIVE_ICON=`<svg width="13" height="12" viewBox="0 0 13 12" fill="none" aria-hidden="true" style="flex-shrink:0"><rect x="1" y="4.5" width="11" height="7" rx="1.5" stroke="currentColor" stroke-width="1.3"/><rect x="0.5" y="2" width="12" height="2.5" rx="1" stroke="currentColor" stroke-width="1.1"/><rect x="4.5" y="6.25" width="4" height="2" rx="0.75" stroke="currentColor" stroke-width="1"/></svg>`;
// All-media multi-camera grid icon — 4 quads: TL=timelapse(violet), TR=motion(blue), BL=person(blue), BR=object(amber)
const _MOC_ALL_SVG=`<svg width="168" height="106" viewBox="0 0 80 50" fill="none" aria-hidden="true"><rect x="1" y="1" width="34" height="21" rx="3.5" fill="#1a2535" stroke="#4a6890" stroke-width="1.3"/><rect x="45" y="1" width="34" height="21" rx="3.5" fill="#1a2535" stroke="#4a6890" stroke-width="1.3"/><rect x="1" y="28" width="34" height="21" rx="3.5" fill="#1a2535" stroke="#4a6890" stroke-width="1.3"/><rect x="45" y="28" width="34" height="21" rx="3.5" fill="#1a2535" stroke="#4a6890" stroke-width="1.3"/><circle cx="6" cy="6" r="2" fill="#4a6890"/><circle cx="50" cy="6" r="2" fill="#4a6890"/><circle cx="6" cy="33" r="2" fill="#4a6890"/><circle cx="50" cy="33" r="2" fill="#4a6890"/><!-- TL: timelapse hourglass (violet) --><line x1="9" y1="7.5" x2="25" y2="7.5" stroke="#c4b5fd" stroke-width="1.2" stroke-linecap="round" opacity=".9"/><polygon points="9,8.5 25,8.5 17,13" fill="#c4b5fd" opacity=".75"/><polygon points="17,13 9,17 25,17" fill="#c4b5fd" opacity=".5"/><line x1="9" y1="17.5" x2="25" y2="17.5" stroke="#c4b5fd" stroke-width="1.2" stroke-linecap="round" opacity=".9"/><!-- TR: running person / motion (blue) --><circle cx="64" cy="7" r="2" fill="#93c5fd" opacity=".8"/><path d="M63.5 9L61 14L59 19" stroke="#93c5fd" stroke-width="1.4" stroke-linecap="round" fill="none" opacity=".75"/><path d="M62 11L59.5 9.5" stroke="#93c5fd" stroke-width="1.2" stroke-linecap="round" opacity=".7"/><path d="M62 11L65 10.5" stroke="#93c5fd" stroke-width="1.2" stroke-linecap="round" opacity=".7"/><path d="M61 14L59 19" stroke="#93c5fd" stroke-width="1.4" stroke-linecap="round" opacity=".75"/><path d="M61 14L64 19" stroke="#93c5fd" stroke-width="1.4" stroke-linecap="round" opacity=".75"/><!-- BL: person detection (sky blue) --><circle cx="18" cy="34" r="2.8" fill="#60a5fa" opacity=".7"/><path d="M12 48C12 42 24 42 24 48" stroke="#60a5fa" stroke-width="1.5" stroke-linecap="round" fill="none" opacity=".65"/><!-- BR: object box (amber) --><rect x="57" y="34" width="14" height="10" rx="1.5" fill="#f59e0b" opacity=".55"/><rect x="59.5" y="31.5" width="5" height="3" rx="1" fill="#f59e0b" opacity=".45"/><!-- Center connector --><circle cx="40" cy="25" r="5.5" fill="#1a2a40" stroke="#3a5878" stroke-width="1.2"/><polygon points="38,22.5 44,25 38,27.5" fill="#4a7090"/></svg>`;
// Count chips for media overview cards
const _MOC_OBJECT_TYPES={person:1,cat:1,bird:1,car:1,dog:1};
function _mocChip(type,count,title){
  // Object-label chips (person/cat/bird/car): CAT_COLORS + objIconSvg
  if(_MOC_OBJECT_TYPES[type]){
    const col=CAT_COLORS[type]||'#8888aa';
    return `<span class="moc-count-chip" title="${esc(title)}" style="background:${hexToRgba(col,0.18)};color:${col};border-radius:8px">${objIconSvg(type,10)} ${count}</span>`;
  }
  const icons={
    event:`<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="3.8" stroke="#4a6477" stroke-width="1.3"/><path d="M5 3v2l1.5 1" stroke="#4a6477" stroke-width="1.1" stroke-linecap="round"/></svg>`,
    snap:`<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="1" y="2.5" width="8" height="6" rx="1.5" stroke="#4a6477" stroke-width="1.2"/><circle cx="5" cy="5.5" r="1.6" fill="#4a6477"/><path d="M3.5 2.5l.4-1h2.2l.4 1" stroke="#4a6477" stroke-width=".9" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    tl:`<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#c4b5fd" stroke-width="1" stroke-linecap="round"><line x1="2.5" y1="1" x2="7.5" y2="1"/><line x1="2.5" y1="9" x2="7.5" y2="9"/><polygon points="3,1.5 7,1.5 5,5" fill="#c4b5fd" opacity=".8"/><polygon points="5,5 3,8.5 7,8.5" stroke="#a855f7" stroke-width="1" fill="none"/></svg>`,
    motion:objIconSvg('motion',10)
  };
  const styles={
    event: {bg:'rgba(255,255,255,.07)', color:'var(--muted)', radius:'6px'},
    snap:  {bg:'rgba(255,255,255,.07)', color:'var(--muted)', radius:'6px'},
    tl:    {bg:'rgba(168,85,247,.18)',  color:'#c084fc',       radius:'8px'},
    motion:{bg:'rgba(147,197,253,.15)', color:'#93c5fd',       radius:'8px'},
  };
  const st=styles[type]||styles.event;
  return `<span class="moc-count-chip" title="${esc(title)}" style="background:${st.bg};color:${st.color};border-radius:${st.radius}">${icons[type]||icons.event} ${count}</span>`;
}
// Build the full chip HTML for a stats entry: objects → motion_only → timelapse
function _buildMocChips(stats){
  const lc=stats.label_counts||{};
  const order=['person','cat','bird','car','dog','squirrel'];
  const objTotal=order.reduce((n,k)=>n+(lc[k]||0),0);
  const motionOnly=Math.max(0,(stats.event_count||0)-objTotal);
  let html='';
  for(const k of order){
    const n=lc[k]||0;
    if(n>0) html+=_mocChip(k,n,OBJ_LABEL[k]||k);
  }
  if(motionOnly>0) html+=_mocChip('motion',motionOnly,'Bewegung');
  if((stats.timelapse_count||0)>0) html+=_mocChip('tl',stats.timelapse_count,'Timelapse');
  return html;
}
function renderMediaOverview(){
  const ov=byId('mediaOverview'); if(!ov) return;
  const cams=state.cameras;
  if(!cams.length){ov.innerHTML=''; return;}
  const statsByid={};
  (state.mediaStats||[]).forEach(s=>{ statsByid[s.camera_id||s.id||s.name]=s; });

  const totalStats=(state.mediaStats||[]).reduce((acc,s)=>{
    const lc={...acc.label_counts};
    if(s.label_counts) Object.entries(s.label_counts).forEach(([k,v])=>{lc[k]=(lc[k]||0)+v;});
    return {
      size_mb:(acc.size_mb||0)+(s.size_mb||0),
      event_count:(acc.event_count||0)+(s.event_count||0),
      jpg_count:(acc.jpg_count||0)+(s.jpg_count||0),
      timelapse_count:(acc.timelapse_count||0)+(s.timelapse_count||0),
      label_counts:lc
    };
  },{size_mb:0,event_count:0,jpg_count:0,timelapse_count:0,label_counts:{}});

  const thumbBadgeStyle='position:absolute;bottom:6px;right:6px;font-size:10px;font-weight:700;color:#e2e8f0;background:rgba(0,0,0,.68);backdrop-filter:blur(3px);padding:2px 6px;border-radius:4px;z-index:2';
  const allCard=`<div class="moc-card" data-cam-id="__all__" onclick="openAllMediaDrilldown()">
    <div class="moc-all-thumb">${_MOC_ALL_SVG}<div style="${thumbBadgeStyle}">${_fmtMb(totalStats.size_mb)}</div></div>
    <div class="moc-body">
      <div class="moc-name">Alle Medien</div>
      <div class="moc-desc">${cams.length} Kamera${cams.length!==1?'s':''} · Gesamtarchiv</div>
      <div class="moc-counts">
        ${_buildMocChips(totalStats)}
      </div>
    </div>
  </div>`;

  const ts=Date.now();
  const camCards=cams.map(c=>{
    const s=statsByid[c.id]||{};
    const icon=getCameraIcon(c.name||c.id);
    // Prefer newest object-labelled snapshot (person/cat/bird/car) over generic latest snap;
    // fall back to the generic latest, then the live snapshot.
    const storedSnap=s.latest_object_snap_url||s.latest_snap_url||'';
    const liveSnap=`/api/camera/${encodeURIComponent(c.id)}/snapshot.jpg?t=${ts}`;
    const thumbSrc=storedSnap||liveSnap;
    const placeholderInner=`<span style="font-size:48px;opacity:.25">${icon}</span>`;
    const fallback=storedSnap?`this.onerror=function(){this.replaceWith(Object.assign(document.createElement('span'),{innerHTML:'${placeholderInner}',style:'display:flex;align-items:center;justify-content:center;width:100%;height:100%'}))};this.src='${liveSnap}'`
      :`this.replaceWith(Object.assign(document.createElement('span'),{innerHTML:'${placeholderInner}',style:'display:flex;align-items:center;justify-content:center;width:100%;height:100%'}))`;
    const locationDesc=c.location?`<div class="moc-desc">${esc(c.location)}</div>`:'';
    return `<div class="moc-card" data-cam-id="${esc(c.id)}" onclick="openMediaDrilldown('${esc(c.id)}')">
      <div class="moc-thumb"><img src="${esc(thumbSrc)}" alt="${esc(c.name)}" onerror="${esc(fallback)}" loading="lazy"/><div style="${thumbBadgeStyle}">${_fmtMb(s.size_mb||0)}</div></div>
      <div class="moc-body">
        <div class="moc-name">${icon} ${esc(c.name)}</div>
        ${locationDesc}
        <div class="moc-counts">
          ${_buildMocChips(s)}
        </div>
      </div>
    </div>`;
  }).join('');

  // Archived cameras section — cameras removed from config but with remaining media
  const archived=state.mediaArchived||[];
  let archivedHtml='';
  if(archived.length){
    const archCards=archived.map(a=>{
      const thumbInner=a.latest_snap_url
        ?`<img src="${esc(a.latest_snap_url)}" alt="${esc(a.name)}" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block;filter:grayscale(.45) brightness(.8)"/>`
        :`<span style="font-size:36px;opacity:.18">📦</span>`;
      const archBadgeStyle='position:absolute;bottom:6px;right:6px;font-size:10px;font-weight:700;color:#a5bfce;background:rgba(0,0,0,.68);backdrop-filter:blur(3px);padding:2px 6px;border-radius:4px;z-index:2';
      return `<div class="moc-card moc-archived" data-cam-id="${esc(a.id)}" onclick="openMediaDrilldown('${esc(a.id)}')">
        <div class="moc-thumb moc-arch-thumb">${thumbInner}<div style="${archBadgeStyle}">${_fmtMb(a.size_mb||0)}</div></div>
        <div class="moc-body">
          <div class="moc-name" style="display:flex;align-items:center;gap:6px">${_ARCHIVE_ICON} <span>${esc(a.name)}</span></div>
          <div class="moc-desc">Archiviert · <code style="font-size:10px;opacity:.6">${esc(a.id)}</code></div>
          <div class="moc-counts">
            ${a.event_count?_mocChip('motion',a.event_count,'Bewegung'):''}
            ${a.timelapse_count?_mocChip('tl',a.timelapse_count,'Timelapse'):''}
          </div>
          <div style="margin-top:8px">
            <button class="btn-action ghost btn-merge-archived" title="In aktive Kamera zusammenführen" data-merge-action="open" data-merge-id="${esc(a.id)}" data-merge-name="${esc(a.name)}">
              Zusammenführen ↗
            </button>
          </div>
        </div>
      </div>`;
    }).join('');
    archivedHtml=`<div class="moc-archive-section">
      <div class="moc-archive-hdr">${_ARCHIVE_ICON} Archivierte Kameras <span class="moc-archive-count">${archived.length}</span></div>
      <div class="moc-archive-grid">${archCards}</div>
    </div>`;
  }

  // Category filter bar — populated dynamically (see renderMediaFilterPills('overview') below)
  const catSection=`<div class="media-filter-bar moc-filter-bar" id="mediaFilterBarOverview"></div>`;

  ov.innerHTML=catSection+`<div class="media-overview-grid">${allCard}${camCards}</div>`+archivedHtml;
  renderMediaFilterPills('overview');
}
window.openCategoryDrilldown=async function(label){
  state.mediaCamera=null;
  state.mediaLabels=new Set(label?[label]:[]);
  state.mediaPage=0;
  if(state.mediaSelectMode) _exitMediaSelectMode();
  if(state.mediaLabels.size===0) _seedTopMediaLabel();
  renderMediaFilterPills('drilldown');
  byId('mediaOverview').style.display='none';
  byId('mediaDrilldown').style.display='';
  _updateMediaSelectToggle();
  updateMediaSectionTitle();
  await loadMedia();
  renderMediaGrid();
};
function _goToPage(n){
  const ps=calcItemsPerPage();
  const p=Math.max(0,Math.min(state.mediaTotalPages-1,n));
  if(p===state.mediaPage) return;
  state.mediaPage=p;
  // Re-slice from the cached all-items list — no new API call needed
  state.media=(state._allMedia||[]).slice(p*ps,(p+1)*ps);
  renderMediaGrid();
  renderMediaPagination();
}
function renderMediaPagination(){
  const pg=byId('mediaPagination'); if(!pg) return;
  const total=state.mediaTotalPages||1;
  const cur=state.mediaPage||0;
  if(total<=1){pg.innerHTML='';return;}
  pg.innerHTML=
    `<button class="page-pill" ${cur===0?'disabled':''} onclick="_goToPage(${cur-1})">‹</button>`+
    `<span class="page-label">Seite ${cur+1} von ${total}</span>`+
    `<button class="page-pill" ${cur>=total-1?'disabled':''} onclick="_goToPage(${cur+1})">›</button>`;
}
let _processingPoll=null;
function _ensureProcessingPoll(){
  const pending=(state.media||[]).some(x=>x&&(x.status==='recording'||x.status==='processing'));
  if(pending&&!_processingPoll){
    _processingPoll=setInterval(async()=>{
      try{
        await loadMedia();
        renderMediaGrid();
      }catch(_){ /* keep polling */ }
    },3000);
  }else if(!pending&&_processingPoll){
    clearInterval(_processingPoll);
    _processingPoll=null;
    // A recording just finished — file landed on disk and size_mb grew.
    // Refresh overview chips + size badge to match server truth.
    loadMediaStorageStats();
  }
}
function renderMediaGrid(){
  const grid=byId('mediaGrid'); if(!grid) return;
  // Unified stream: EventStore now contains motion + timelapse events, so no
  // separate tl list needs to be merged here.
  const items=state.media||[];
  // Light slide-in on page change
  grid.style.opacity='0';grid.style.transform='translateX(10px)';
  grid.innerHTML=items.map(mediaCardHTML).join('')||'<div class="item muted" style="padding:16px">Keine Medien vorhanden.</div>';
  if(state.mediaSelectMode){
    grid.querySelectorAll('.media-card').forEach(card=>{
      if(state.mediaSelected.has(card.dataset.eventId)) card.classList.add('media-card--selected');
    });
  }
  requestAnimationFrame(()=>{grid.style.transition='opacity .18s ease,transform .18s ease';grid.style.opacity='1';grid.style.transform='';});
  renderMediaPagination();
  window._openMediaItem=id=>{
    if(state.mediaSelectMode){ _toggleMediaSelected(id); return; }
    const item=items.find(x=>x.event_id===id);
    if(item) openLightbox(item);
  };
  // Poll for pending recording/processing items until every visible card is ready
  _ensureProcessingPoll();
  // Cache-bust any card whose item has a snapshot_relpath but whose <img> is
  // empty or broken — covers freshly-generated thumbnails that the browser
  // may have cached as 404 from an earlier render pass.
  grid.querySelectorAll('.media-card').forEach(card=>{
    const eid=card.dataset.eventId;
    if(!eid) return;
    const item=items.find(x=>x.event_id===eid);
    if(!item||!item.snapshot_relpath) return;
    const img=card.querySelector('.mmc-img-wrap img');
    if(!img) return;
    const needsBust=!img.getAttribute('src')||img.naturalWidth===0||img.style.display==='none';
    if(needsBust){
      img.style.display='';
      img.src=`/media/${item.snapshot_relpath}?t=${Date.now()}`;
    }
  });
  // Post-render column correction: measure actual card width, recompute page size if off
  requestAnimationFrame(()=>{
    const firstCard=grid.querySelector('.media-card');
    if(!firstCard) return;
    const actualW=firstCard.getBoundingClientRect().width;
    const containerW=grid.getBoundingClientRect().width;
    if(actualW<=0||containerW<=0) return;
    const actualCols=Math.max(1,Math.round(containerW/actualW));
    if(actualCols!==_lastKnownCols) _lastKnownCols=actualCols;
    const correctPs=_MEDIA_ROWS*actualCols;
    if(correctPs!==_cachedPageSize&&state._allMedia&&state._allMedia.length){
      _cachedPageSize=correctPs;
      state.mediaTotalPages=Math.max(1,Math.ceil(state._allMedia.length/correctPs));
      state.mediaPage=0;
      state.media=state._allMedia.slice(0,correctPs);
      renderMediaGrid();
      renderMediaPagination();
    }
  });
}
window._tlItems=[];
// Single source of truth for which moc-card is highlighted. data-cam-id is
// stable across re-renders; pass null/undefined to clear all (used when the
// drilldown closes or "Alle Medien" opens).
function _setActiveMocCard(camId){
  document.querySelectorAll('.moc-card').forEach(c=>{
    c.classList.toggle('moc-active', !!camId && c.dataset.camId===camId);
  });
}
async function openAllMediaDrilldown(preFilterLabel){
  state.mediaCamera=null;
  state.mediaLabels=preFilterLabel?new Set([preFilterLabel]):new Set();
  state.mediaPage=0;
  if(state.mediaSelectMode) _exitMediaSelectMode();
  state.media=[]; state._allMedia=[];
  const grid=byId('mediaGrid');
  if(grid) grid.innerHTML='<div style="padding:32px;text-align:center;color:var(--muted)">Lade Medien…</div>';
  if(state.mediaLabels.size===0) _seedTopMediaLabel();
  renderMediaFilterPills('drilldown');
  byId('mediaOverview').style.display='none';
  byId('mediaDrilldown').style.display='';
  _setActiveMocCard('__all__');
  _updateMediaSelectToggle();
  updateMediaSectionTitle();
  await loadMedia();
  renderMediaGrid();
}
window.openAllMediaDrilldown=openAllMediaDrilldown;
async function openMediaDrilldown(camId){
  state.mediaCamera=camId;
  state.mediaLabels=new Set(); state.mediaPage=0;
  if(state.mediaSelectMode) _exitMediaSelectMode();
  // Clear stale state and grid immediately so the previous camera's thumbnails
  // don't flash before the new fetch resolves.
  state.media=[]; state._allMedia=[];
  const grid=byId('mediaGrid');
  if(grid) grid.innerHTML='<div style="padding:32px;text-align:center;color:var(--muted)">Lade Medien…</div>';
  const pag=byId('mediaPagination'); if(pag) pag.innerHTML='';
  _seedTopMediaLabel();
  renderMediaFilterPills('drilldown');
  byId('mediaOverview').style.display='none';
  byId('mediaDrilldown').style.display='';
  _setActiveMocCard(camId);
  _updateMediaSelectToggle();
  updateMediaSectionTitle();
  await loadMedia();
  renderMediaGrid();
}
function closeMediaDrilldown(){
  state.mediaCamera=null; state.media=[];
  if(state.mediaSelectMode) _exitMediaSelectMode();
  byId('mediaDrilldown').style.display='none';
  byId('mediaOverview').style.display='';
  _setActiveMocCard(null);
  _updateMediaSelectToggle();
  updateMediaSectionTitle();
}
// Library/film glyph for overview + Alle-Medien title; per-camera drilldown
// uses the camera's thematic icon via getCameraIcon (matches the cv-card).
const _MEDIA_TITLE_SVG=`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M7 6V4h10v2"/><circle cx="12" cy="13" r="3"/></svg>`;
function updateMediaSectionTitle(){
  const h=byId('mediaSectionTitle'); if(!h) return;
  const drillOpen=byId('mediaDrilldown')?.style.display!=='none';
  if(drillOpen && state.mediaCamera){
    const cam=(state.cameras||[]).find(c=>c.id===state.mediaCamera);
    const camName=cam?.name||state.mediaCamera;
    const camIcon=getCameraIcon(camName);
    h.innerHTML=`<span class="mst-cam-icon" aria-hidden="true">${camIcon}</span><span class="mst-text">Mediathek · ${esc(camName)}</span>`;
  } else if(drillOpen){
    h.innerHTML=`${_MEDIA_TITLE_SVG}<span class="mst-text">Mediathek · Alle Medien</span>`;
  } else {
    h.innerHTML=`${_MEDIA_TITLE_SVG}<span class="mst-text">Mediathek</span>`;
  }
}

// ── Multi-select / bulk delete ──────────────────────────────────────────────
function _updateMediaSelectToggle(){
  const btn=byId('mediaSelectToggleBtn'); if(!btn) return;
  btn.style.display=state.mediaCamera?'inline-flex':'none';
  btn.classList.toggle('btn-action',state.mediaSelectMode);
  btn.classList.toggle('action-green',state.mediaSelectMode);
  btn.classList.toggle('btn-neutral',!state.mediaSelectMode);
}
function _exitMediaSelectMode(){
  state.mediaSelectMode=false;
  state.mediaSelected.clear();
  document.body.classList.remove('media-select-mode');
  const bar=byId('mediaSelectBar'); if(bar) bar.style.display='none';
  document.querySelectorAll('.media-card.media-card--selected').forEach(c=>c.classList.remove('media-card--selected'));
  _updateMediaSelectToggle();
}
function _enterMediaSelectMode(){
  state.mediaSelectMode=true;
  state.mediaSelected.clear();
  document.body.classList.add('media-select-mode');
  _refreshMediaSelectBar();
  _updateMediaSelectToggle();
}
function _refreshMediaSelectBar(){
  const bar=byId('mediaSelectBar'); if(!bar) return;
  if(!state.mediaSelectMode){ bar.style.display='none'; return; }
  bar.style.display='';
  const c=byId('msbCount'); if(c) c.textContent=String(state.mediaSelected.size);
}
function _toggleMediaSelected(eventId){
  if(!eventId) return;
  if(state.mediaSelected.has(eventId)) state.mediaSelected.delete(eventId);
  else state.mediaSelected.add(eventId);
  const card=document.querySelector(`.media-card[data-event-id="${CSS.escape(eventId)}"]`);
  if(card) card.classList.toggle('media-card--selected',state.mediaSelected.has(eventId));
  _refreshMediaSelectBar();
}
window.toggleMediaSelectMode=function(){
  if(state.mediaSelectMode) _exitMediaSelectMode();
  else _enterMediaSelectMode();
};
window.bulkDeleteSelectedMedia=async function(){
  const ids=Array.from(state.mediaSelected);
  const camId=state.mediaCamera;
  if(!camId||!ids.length) return;
  if(!await showConfirm(`${ids.length} ausgewählte Einträge wirklich löschen?`)) return;
  try{
    const r=await j(`/api/camera/${encodeURIComponent(camId)}/events/delete-bulk`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event_ids:ids})});
    const okSet=new Set(ids.filter(id=>!(r.failed||[]).includes(id)));
    state._allMedia=(state._allMedia||[]).filter(x=>!okSet.has(x.event_id));
    const ps_d=calcItemsPerPage();
    state.mediaTotalPages=Math.max(1,Math.ceil(state._allMedia.length/ps_d));
    state.mediaPage=Math.min(state.mediaPage||0,state.mediaTotalPages-1);
    state.media=state._allMedia.slice(state.mediaPage*ps_d,(state.mediaPage+1)*ps_d);
    _exitMediaSelectMode();
    renderMediaGrid();
    renderMediaPagination();
    refreshTimelineAndStats();
    const failed=(r.failed||[]).length;
    showToast(failed?`${r.deleted} gelöscht, ${failed} fehlgeschlagen`:`${r.deleted} gelöscht`,failed?'error':'success');
  }catch(e){showToast('Bulk-Löschen fehlgeschlagen: '+e.message,'error');}
};
// Legacy alias — pills are now rendered dynamically via renderMediaFilterPills.
function syncMediaPills(){ renderMediaFilterPills('drilldown'); }
// ── Media grid resize observer ───────────────────────────────────────────────
(function(){
  const grid=byId('mediaGrid');
  if(!grid||typeof ResizeObserver==='undefined') return;
  let lastW=0;
  const ro=new ResizeObserver(entries=>{
    const w=entries[0]?.contentRect?.width||0;
    if(!w||Math.abs(w-lastW)<192) return;
    lastW=w;
    if(byId('mediaDrilldown')?.style.display==='none') return;
    const firstCard=grid.querySelector('.media-card');
    if(!firstCard) return;
    const cardW=firstCard.getBoundingClientRect().width;
    if(cardW<=0) return;
    const newCols=Math.max(1,Math.floor(w/cardW));
    if(newCols===_lastKnownCols) return;
    _lastKnownCols=newCols;
    if(!state._allMedia?.length) return;
    const ps=calcItemsPerPage();
    _cachedPageSize=ps;
    state.mediaTotalPages=Math.max(1,Math.ceil(state._allMedia.length/ps));
    state.mediaPage=0;
    state.media=state._allMedia.slice(0,ps);
    renderMediaGrid();
    renderMediaPagination();
  });
  ro.observe(grid);
})();
window.deleteMediaCard=async(btn)=>{
  const card=btn.closest('.media-card');
  const eventId=card?.dataset.eventId;
  const camId=card?.dataset.cameraId;
  if(!eventId||!camId) return;
  try{
    await j(`/api/camera/${encodeURIComponent(camId)}/events/${encodeURIComponent(eventId)}`,{method:'DELETE'});
    // Brief fade-out animation, then re-render
    if(card){
      card.style.transition='opacity .25s,transform .25s';
      card.style.opacity='0';
      card.style.transform='scale(0.95)';
    }
    setTimeout(()=>{
      state._allMedia=(state._allMedia||[]).filter(x=>x.event_id!==eventId);
      const ps_d=calcItemsPerPage();
      state.mediaTotalPages=Math.max(1,Math.ceil(state._allMedia.length/ps_d));
      state.mediaPage=Math.min(state.mediaPage||0,state.mediaTotalPages-1);
      state.media=state._allMedia.slice(state.mediaPage*ps_d,(state.mediaPage+1)*ps_d);
      if(state.media.length===0&&state.mediaPage>0){
        state.mediaPage--;
        state.media=state._allMedia.slice(state.mediaPage*ps_d,(state.mediaPage+1)*ps_d);
      }
      renderMediaGrid();
      renderMediaPagination();
      refreshTimelineAndStats();
    },250);
  }catch(e){showToast('Löschen fehlgeschlagen: '+e.message,'error');}
};
window.deleteTLCard=async(camId,filename,eventId)=>{
  try{
    await j(`/api/camera/${encodeURIComponent(camId)}/timelapse/${encodeURIComponent(filename)}`,{method:'DELETE'});
    // Remove the unified EventStore entry too (server also does this as a backstop)
    if(eventId){
      try{
        await j(`/api/camera/${encodeURIComponent(camId)}/events/${encodeURIComponent(eventId)}`,{method:'DELETE'});
      }catch(_){ /* already cleaned by server */ }
    }
    const card=byId('mediaGrid').querySelector(`[data-event-id="${CSS.escape(eventId)}"]`);
    if(card) card.remove();
    state._allMedia=(state._allMedia||[]).filter(x=>x.event_id!==eventId);
    const ps_d=calcItemsPerPage();
    state.mediaTotalPages=Math.max(1,Math.ceil(state._allMedia.length/ps_d));
    state.mediaPage=Math.min(state.mediaPage||0,state.mediaTotalPages-1);
    state.media=state._allMedia.slice(state.mediaPage*ps_d,(state.mediaPage+1)*ps_d);
    if(state.media.length===0&&state.mediaPage>0){
      state.mediaPage--;
      state.media=state._allMedia.slice(state.mediaPage*ps_d,(state.mediaPage+1)*ps_d);
    }
    renderMediaGrid();
    renderMediaPagination();
    if(!byId('mediaGrid').querySelector('.media-card')){
      byId('mediaGrid').innerHTML='<div class="item muted" style="padding:16px">Keine Medien vorhanden.</div>';
    }
    refreshTimelineAndStats();
  }catch(e){showToast('Löschen fehlgeschlagen: '+e.message,'error');}
};
window.confirmMediaCard=async(camId,eventId,btn)=>{
  // Brief scale animation on tap
  if(btn){
    btn.classList.add('mmc-confirm--anim');
    setTimeout(()=>btn.classList.remove('mmc-confirm--anim'),200);
  }
  try{
    await j(`/api/camera/${encodeURIComponent(camId)}/events/${encodeURIComponent(eventId)}/confirm`,{method:'POST'});
    // update state.media + state._allMedia in place so lightbox nav and re-renders stay in sync
    const sIdx=(state.media||[]).findIndex(x=>x.event_id===eventId);
    if(sIdx>=0) state.media[sIdx].confirmed=true;
    const aIdx=(state._allMedia||[]).findIndex(x=>x.event_id===eventId);
    if(aIdx>=0) state._allMedia[aIdx].confirmed=true;
    const card=byId('mediaGrid').querySelector(`[data-event-id="${CSS.escape(eventId)}"]`);
    if(card){
      // Wait for the scale anim to finish, then swap actions for the ✓ badge
      setTimeout(()=>{
        card.classList.add('mmc-confirmed');
        const actions=card.querySelector('.mmc-actions');
        if(actions) actions.outerHTML='<span class="media-confirmed-badge">✓</span>';
      },200);
    }
  }catch(e){showToast('Bestätigen fehlgeschlagen: '+e.message,'error');}
};
// ── Bird SVG icons — one distinctive silhouette per Bavarian Top-20 species ──
// viewBox 0 0 80 80 (reused by the medal rendering at size 80×80). Each SVG
// emphasises the bird's identifying features: plumage pattern, beak shape,
// posture. Flat design, 2–4 colours, branch perch for consistency.
const BIRD_SVGS={
// 1 Haussperling — stocky brown, grey crown, black bib, pale cheeks
'haussperling':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M18 57 L10 59 L12 65 L20 62Z" fill="#9b6840"/><ellipse cx="36" cy="50" rx="18" ry="12" fill="#c4a478"/><ellipse cx="28" cy="44" rx="18" ry="9" fill="#7a5330"/><rect x="16" y="43" width="14" height="2.5" rx="1.2" fill="#3a2a18"/><circle cx="52" cy="36" r="11" fill="#c4a478"/><path d="M41 30 Q 52 22 63 30 Q 63 34 52 34 Q 41 34 41 30Z" fill="#7a6150"/><ellipse cx="46" cy="43" rx="7" ry="4" fill="#1a1a1a"/><circle cx="57" cy="33" r="1.8" fill="#111"/><path d="M63 35 L72 34 L63 38Z" fill="#3a2a18"/></svg>`,
// 2 Amsel — solid black bird, orange beak + eye-ring
'amsel':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M14 55 L6 57 L8 64 L16 60Z" fill="#111"/><ellipse cx="36" cy="50" rx="20" ry="13" fill="#111"/><ellipse cx="30" cy="44" rx="18" ry="10" fill="#111"/><circle cx="52" cy="36" r="11" fill="#111"/><circle cx="57" cy="32" r="4" fill="none" stroke="#f08030" stroke-width="2"/><circle cx="57" cy="32" r="1.8" fill="#111"/><path d="M63 35 L74 33 L63 39Z" fill="#f08030"/></svg>`,
// 3 Kohlmeise — yellow belly, black head, white cheek, black belly stripe
'kohlmeise':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M18 56 L10 58 L12 64 L20 61Z" fill="#333"/><ellipse cx="36" cy="50" rx="18" ry="12" fill="#f0d060"/><rect x="32" y="40" width="7" height="22" rx="3.5" fill="#111"/><ellipse cx="30" cy="44" rx="17" ry="9" fill="#6a9a30"/><circle cx="52" cy="36" r="11" fill="#111"/><ellipse cx="51" cy="41" rx="7" ry="4.5" fill="#f0f0f0"/><circle cx="57" cy="32" r="1.8" fill="#fff"/><path d="M63 35 L72 34 L63 38Z" fill="#555"/></svg>`,
// 4 Star — iridescent dark with white speckles, pointed yellow beak
'star':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M14 55 L6 57 L8 64 L16 60Z" fill="#1a1a2a"/><ellipse cx="36" cy="50" rx="20" ry="12" fill="#1a1a2a"/><ellipse cx="30" cy="44" rx="18" ry="10" fill="#2a2a44"/><circle cx="24" cy="46" r="1" fill="#d0d0e0"/><circle cx="30" cy="48" r="1" fill="#d0d0e0"/><circle cx="36" cy="46" r="1" fill="#d0d0e0"/><circle cx="42" cy="49" r="1" fill="#d0d0e0"/><circle cx="28" cy="52" r="1" fill="#d0d0e0"/><circle cx="36" cy="53" r="1" fill="#d0d0e0"/><circle cx="44" cy="53" r="1" fill="#d0d0e0"/><circle cx="22" cy="50" r="1" fill="#d0d0e0"/><circle cx="52" cy="35" r="11" fill="#1a1a2a"/><circle cx="57" cy="31" r="1.8" fill="#f5f5ff"/><path d="M62 33 L76 32 L62 37Z" fill="#f0c020"/></svg>`,
// 5 Feldsperling — warm brown cap, white cheeks with black cheek-spot
'feldsperling':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M18 57 L10 59 L12 65 L20 62Z" fill="#a0704a"/><ellipse cx="36" cy="50" rx="18" ry="12" fill="#d4b890"/><ellipse cx="28" cy="44" rx="17" ry="9" fill="#a0704a"/><circle cx="52" cy="36" r="11" fill="#f5ecd8"/><path d="M41 26 Q 52 20 63 26 L 63 32 Q 52 34 41 32Z" fill="#7a4820"/><circle cx="50" cy="39" r="2.5" fill="#2a1a08"/><circle cx="57" cy="33" r="1.8" fill="#111"/><path d="M63 35 L72 34 L63 38Z" fill="#3a2a18"/></svg>`,
// 6 Blaumeise — blue cap + wings, yellow belly, white face
'blaumeise':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M18 56 L10 58 L12 64 L20 61Z" fill="#4a90d9"/><ellipse cx="36" cy="50" rx="18" ry="12" fill="#f0d060"/><ellipse cx="30" cy="44" rx="17" ry="9" fill="#5a9a40"/><ellipse cx="28" cy="42" rx="15" ry="7" fill="#4a90d9"/><circle cx="52" cy="36" r="11" fill="#f0f0f0"/><ellipse cx="52" cy="27" rx="11" ry="7" fill="#4a90d9"/><rect x="42" y="34" width="18" height="2.5" rx="1.2" fill="#111"/><circle cx="57" cy="32" r="1.8" fill="#111"/><path d="M63 35 L72 34 L63 38Z" fill="#666"/></svg>`,
// 7 Ringeltaube — plump grey dove with white neck patch
'ringeltaube':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M14 54 L4 56 L6 64 L16 60Z" fill="#6d7686"/><ellipse cx="36" cy="50" rx="22" ry="14" fill="#8c96a6"/><ellipse cx="28" cy="44" rx="20" ry="11" fill="#6d7686"/><circle cx="52" cy="34" r="12" fill="#7e8898"/><ellipse cx="44" cy="38" rx="5" ry="3.5" fill="#f5f5f5"/><ellipse cx="40" cy="42" rx="4" ry="2" fill="#f5f5f5" opacity="0.8"/><circle cx="57" cy="31" r="1.8" fill="#e04040"/><path d="M63 33 L72 32 L71 37 L63 37Z" fill="#e0a040"/></svg>`,
// 8 Mauersegler — dark sickle-winged bird in flight
'mauersegler':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><ellipse cx="40" cy="42" rx="10" ry="4" fill="#2a2a32"/><path d="M 30 42 Q 10 20 4 30 Q 12 32 28 42Z" fill="#1a1a22"/><path d="M 50 42 Q 70 20 76 30 Q 68 32 52 42Z" fill="#1a1a22"/><path d="M 30 42 Q 14 28 6 32 Q 14 36 28 44Z" fill="#2a2a32"/><path d="M 50 42 Q 66 28 74 32 Q 66 36 52 44Z" fill="#2a2a32"/><path d="M 38 48 L 36 58 L 40 56 L 44 58 L 42 48Z" fill="#1a1a22"/><circle cx="46" cy="41" r="1.5" fill="#111"/><path d="M50 42 L54 42 L50 44Z" fill="#111"/></svg>`,
// 9 Elster — black-and-white, long tail
'elster':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M6 48 L2 55 L14 60 L20 54Z" fill="#111"/><ellipse cx="36" cy="50" rx="18" ry="12" fill="#f5f5f5"/><ellipse cx="27" cy="44" rx="15" ry="9" fill="#111"/><ellipse cx="33" cy="52" rx="9" ry="5" fill="#f5f5f5"/><circle cx="52" cy="36" r="11" fill="#111"/><ellipse cx="48" cy="38" rx="5" ry="4" fill="#1a2e55" opacity="0.65"/><circle cx="57" cy="32" r="1.8" fill="#fff"/><path d="M63 35 L72 34 L63 38Z" fill="#222"/></svg>`,
// 10 Mehlschwalbe — forked-tail swallow, white underside
'mehlschwalbe':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><path d="M 30 40 Q 10 30 4 36 Q 10 44 28 44Z" fill="#1a2a44"/><path d="M 50 40 Q 70 30 76 36 Q 70 44 52 44Z" fill="#1a2a44"/><ellipse cx="40" cy="42" rx="12" ry="6" fill="#1a2a44"/><ellipse cx="40" cy="46" rx="10" ry="4" fill="#f5f5f5"/><path d="M 34 48 L 26 60 L 34 54 L 40 58 L 46 54 L 54 60 L 46 48Z" fill="#1a2a44"/><ellipse cx="42" cy="43" rx="3" ry="2" fill="#f5f5f5" opacity="0.7"/><circle cx="46" cy="41" r="1.5" fill="#111"/><path d="M50 42 L54 42 L50 43Z" fill="#111"/></svg>`,
// 11 Buchfink — pink breast, white wing bars, blue-grey cap
'buchfink':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M18 56 L10 58 L12 64 L20 61Z" fill="#a05030"/><ellipse cx="36" cy="50" rx="18" ry="12" fill="#c07060"/><ellipse cx="28" cy="44" rx="17" ry="9" fill="#6a4a38"/><rect x="16" y="43" width="26" height="2.5" rx="1.2" fill="#f0f0f0"/><rect x="18" y="48" width="22" height="2.5" rx="1.2" fill="#f0f0f0"/><circle cx="52" cy="36" r="11" fill="#7090b0"/><circle cx="57" cy="33" r="1.8" fill="#111"/><path d="M63 35 L72 34 L63 38Z" fill="#606060"/></svg>`,
// 12 Rotkehlchen — orange-red face/breast, round body
'rotkehlchen':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M18 57 L10 59 L12 65 L20 62Z" fill="#8b6040"/><ellipse cx="36" cy="51" rx="18" ry="12" fill="#f5f0ea"/><ellipse cx="30" cy="44" rx="16" ry="10" fill="#8b6040"/><circle cx="48" cy="47" r="13" fill="#e05a20"/><circle cx="52" cy="35" r="11" fill="#e05a20"/><circle cx="57" cy="32" r="1.8" fill="#111"/><path d="M63 34 L72 33 L63 37Z" fill="#555"/></svg>`,
// 13 Grünfink — olive body, bright yellow wing patch
'gruenfink':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M16 55 L8 57 L10 63 L18 60Z" fill="#6a9a20"/><ellipse cx="36" cy="50" rx="19" ry="12" fill="#90bb30"/><ellipse cx="28" cy="44" rx="17" ry="9" fill="#6a9a20"/><rect x="16" y="46" width="24" height="4" rx="2" fill="#e8d020"/><circle cx="52" cy="36" r="11" fill="#90bb30"/><circle cx="57" cy="33" r="1.8" fill="#111"/><path d="M62 34 L74 33 L62 38Z" fill="#d4a010"/></svg>`,
// 14 Rabenkrähe — all-black, stout beak
'rabenkraehe':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M10 52 L2 55 L4 63 L12 59Z" fill="#111"/><ellipse cx="36" cy="50" rx="22" ry="14" fill="#111"/><ellipse cx="28" cy="43" rx="20" ry="11" fill="#111"/><circle cx="52" cy="35" r="13" fill="#111"/><circle cx="57" cy="31" r="2" fill="#334455"/><path d="M62 33 L76 31 L62 40Z" fill="#111"/><path d="M62 34 L75 32 L62 39Z" fill="#223"/></svg>`,
// 15 Hausrotschwanz — dark sooty body, rusty-red tail
'hausrotschwanz':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M20 53 L6 56 L4 64 L14 63Z" fill="#c8451a"/><path d="M20 53 L10 58 L14 64 L22 61Z" fill="#e05a20"/><ellipse cx="36" cy="50" rx="18" ry="12" fill="#3a3a40"/><ellipse cx="30" cy="44" rx="16" ry="9" fill="#202028"/><circle cx="52" cy="36" r="11" fill="#202028"/><circle cx="57" cy="32" r="1.8" fill="#fff"/><path d="M63 35 L72 34 L63 38Z" fill="#111"/></svg>`,
// 16 Mönchsgrasmücke — olive-brown body, black cap (male)
'moenchsgrasmucke':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M18 56 L10 58 L12 64 L20 61Z" fill="#7a7060"/><ellipse cx="36" cy="51" rx="18" ry="12" fill="#b0a890"/><ellipse cx="28" cy="44" rx="17" ry="9" fill="#7a7060"/><circle cx="52" cy="36" r="11" fill="#a09684"/><path d="M41 30 Q 52 20 63 28 Q 63 36 52 34 Q 41 34 41 30Z" fill="#111"/><circle cx="57" cy="33" r="1.8" fill="#f5f5f5"/><path d="M63 35 L72 34 L63 38Z" fill="#555"/></svg>`,
// 17 Stieglitz — red face, gold wing bar, black wings
'stieglitz':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M14 55 L6 57 L8 63 L16 60Z" fill="#111"/><ellipse cx="36" cy="50" rx="18" ry="12" fill="#f5f0ea"/><ellipse cx="26" cy="44" rx="17" ry="9" fill="#111"/><rect x="14" y="46" width="28" height="5" rx="2.5" fill="#f0c010"/><circle cx="52" cy="36" r="11" fill="#f5f5f5"/><ellipse cx="46" cy="33" rx="9" ry="9" fill="#111"/><ellipse cx="51" cy="36" rx="8" ry="7" fill="#cc2200"/><circle cx="57" cy="33" r="1.8" fill="#111"/><path d="M62 35 L72 34 L62 38Z" fill="#c0b090"/></svg>`,
// 18 Buntspecht — black/white striped back, red belly patch, woodpecker pose
'buntspecht':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="44" y="10" width="5" height="60" rx="2" fill="#5a3a1a"/><ellipse cx="36" cy="48" rx="12" ry="14" fill="#111"/><ellipse cx="29" cy="46" rx="7" ry="10" fill="#f5f5f5"/><line x1="18" y1="34" x2="38" y2="34" stroke="#111" stroke-width="2"/><line x1="18" y1="40" x2="38" y2="40" stroke="#111" stroke-width="2"/><ellipse cx="32" cy="60" rx="8" ry="5" fill="#cc1a1a"/><circle cx="34" cy="32" r="8" fill="#111"/><ellipse cx="34" cy="26" rx="6" ry="4" fill="#cc1a1a"/><ellipse cx="32" cy="34" rx="4" ry="3" fill="#f5f5f5"/><circle cx="36" cy="30" r="1.5" fill="#fff"/><path d="M40 31 L52 30 L40 34Z" fill="#333"/></svg>`,
// 19 Kleiber — blue-grey back, orange underside, head-down pose on trunk
'kleiber':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="54" y="6" width="6" height="68" rx="3" fill="#5a3a1a"/><path d="M 44 20 Q 56 26 58 44 Q 56 58 44 64 Q 30 60 28 44 Q 30 26 44 20Z" fill="#6080a0"/><path d="M 44 30 Q 54 36 54 48 Q 54 58 44 62 Q 36 58 34 48 Q 36 38 44 30Z" fill="#d07030"/><rect x="32" y="30" width="20" height="3" rx="1.5" fill="#111"/><circle cx="38" cy="28" r="1.8" fill="#fff"/><path d="M30 30 L20 32 L30 34Z" fill="#444"/></svg>`,
// 20 Eichelhäher — pinkish-brown body, bright blue wing patch
'eichelhaher':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M12 54 L4 57 L6 63 L14 60Z" fill="#c8906c"/><ellipse cx="36" cy="50" rx="20" ry="13" fill="#c8906c"/><ellipse cx="26" cy="46" rx="13" ry="8" fill="#4060e0"/><line x1="18" y1="43" x2="32" y2="43" stroke="#111" stroke-width="1.5"/><line x1="18" y1="47" x2="32" y2="47" stroke="#111" stroke-width="1.5"/><line x1="18" y1="51" x2="32" y2="51" stroke="#111" stroke-width="1.5"/><circle cx="52" cy="36" r="11" fill="#c8906c"/><ellipse cx="52" cy="28" rx="9" ry="6" fill="#f0f0f0"/><rect x="42" y="39" width="14" height="2.5" rx="1.2" fill="#111"/><circle cx="57" cy="33" r="1.8" fill="#111"/><path d="M63 35 L72 34 L63 38Z" fill="#555"/></svg>`
};

// ── Mammal SVG icons ─────────────────────────────────────────────────────────
const MAMMAL_SVGS={
'igel':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><ellipse cx="40" cy="55" rx="26" ry="16" fill="#8b6340"/><ellipse cx="40" cy="47" rx="22" ry="12" fill="#4a3020"/><line x1="40" y1="35" x2="37" y2="19" stroke="#4a3020" stroke-width="2.5" stroke-linecap="round"/><line x1="52" y1="38" x2="56" y2="23" stroke="#4a3020" stroke-width="2.5" stroke-linecap="round"/><line x1="28" y1="38" x2="24" y2="23" stroke="#4a3020" stroke-width="2.5" stroke-linecap="round"/><line x1="62" y1="46" x2="70" y2="36" stroke="#4a3020" stroke-width="2.5" stroke-linecap="round"/><line x1="18" y1="46" x2="10" y2="36" stroke="#4a3020" stroke-width="2.5" stroke-linecap="round"/><ellipse cx="62" cy="57" rx="13" ry="9" fill="#a07850"/><circle cx="66" cy="53" r="2.5" fill="#111"/><circle cx="65.5" cy="52.5" r="1" fill="#fff"/><circle cx="72" cy="57" r="2" fill="#333"/><ellipse cx="28" cy="69" rx="5" ry="3.5" fill="#7a5530"/><ellipse cx="50" cy="70" rx="5" ry="3.5" fill="#7a5530"/></svg>`,
'feldhase':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><ellipse cx="34" cy="17" rx="6" ry="21" fill="#9e8060"/><ellipse cx="34" cy="17" rx="3.5" ry="18" fill="#e8e0d0"/><ellipse cx="47" cy="14" rx="6" ry="23" fill="#9e8060"/><ellipse cx="47" cy="14" rx="3.5" ry="20" fill="#e8e0d0"/><ellipse cx="38" cy="59" rx="20" ry="14" fill="#9e8060"/><ellipse cx="38" cy="64" rx="13" ry="9" fill="#e8e0d0"/><circle cx="50" cy="44" r="14" fill="#9e8060"/><circle cx="56" cy="39" r="3.5" fill="#111"/><circle cx="55" cy="38" r="1.2" fill="#fff"/><ellipse cx="58" cy="47" rx="6" ry="4" fill="#b09070"/><circle cx="61" cy="46" r="1.8" fill="#333"/><ellipse cx="20" cy="65" rx="8" ry="5" fill="#9e8060"/><ellipse cx="56" cy="70" rx="10" ry="4" fill="#9e8060"/></svg>`,
'reh':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><path d="M 36 20 Q 30 12 26 14 Q 22 16 24 20" stroke="#8b6040" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M 36 20 Q 34 10 39 9" stroke="#8b6040" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M 44 20 Q 50 12 54 14 Q 58 16 56 20" stroke="#8b6040" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M 44 20 Q 46 10 41 9" stroke="#8b6040" stroke-width="2.5" fill="none" stroke-linecap="round"/><rect x="36" y="24" width="12" height="22" rx="6" fill="#c8a870"/><circle cx="42" cy="23" r="12" fill="#c8a870"/><ellipse cx="48" cy="26" rx="7" ry="5" fill="#e8d8b0"/><ellipse cx="30" cy="19" rx="4" ry="8" fill="#c8a870" transform="rotate(-15 30 19)"/><circle cx="37" cy="20" r="3" fill="#111"/><circle cx="36" cy="19" r="1" fill="#fff"/><ellipse cx="40" cy="61" rx="24" ry="15" fill="#c8a870"/><ellipse cx="18" cy="58" rx="6" ry="7" fill="#f0e8d0"/><rect x="28" y="72" width="5" height="8" rx="2.5" fill="#a08050"/><rect x="36" y="72" width="5" height="8" rx="2.5" fill="#a08050"/><rect x="46" y="72" width="5" height="8" rx="2.5" fill="#a08050"/></svg>`,
'fuchs':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><polygon points="22,36 28,16 34,36" fill="#d4521a"/><polygon points="24,34 28,20 32,34" fill="#f0c0a0"/><polygon points="46,36 52,16 58,36" fill="#d4521a"/><polygon points="48,34 52,20 56,34" fill="#f0c0a0"/><ellipse cx="40" cy="46" rx="18" ry="16" fill="#d4521a"/><path d="M 32 50 Q 40 47 48 50 Q 52 55 50 60 Q 44 65 36 63 Q 30 59 32 53Z" fill="#e8e0d0"/><circle cx="32" cy="40" r="3.5" fill="#111"/><circle cx="31" cy="39" r="1.2" fill="#fff"/><circle cx="48" cy="40" r="3.5" fill="#111"/><circle cx="47" cy="39" r="1.2" fill="#fff"/><ellipse cx="40" cy="55" rx="4" ry="3" fill="#333"/><ellipse cx="40" cy="70" rx="20" ry="11" fill="#d4521a"/><ellipse cx="40" cy="69" rx="12" ry="7" fill="#e8e0d0"/><rect x="26" y="73" width="6" height="7" rx="3" fill="#2a1a0a"/><rect x="48" y="73" width="6" height="7" rx="3" fill="#2a1a0a"/></svg>`,
'eichhoernchen_orange':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><path d="M 50 72 Q 74 60 72 32 Q 70 14 54 16 Q 38 18 42 38 Q 46 58 50 72Z" fill="#a8350c"/><path d="M 51 70 Q 68 58 66 34 Q 64 22 54 24 Q 44 26 46 40 Q 48 56 51 70Z" fill="#c64a18"/><path d="M 53 66 Q 62 56 61 38 Q 60 30 55 32 Q 50 34 51 42 Q 52 54 53 66Z" fill="#e06228"/><ellipse cx="34" cy="62" rx="17" ry="12" fill="#a8350c"/><ellipse cx="34" cy="63" rx="13" ry="9" fill="#c64a18"/><ellipse cx="36" cy="68" rx="9" ry="5" fill="#f0c89a"/><circle cx="38" cy="42" r="15" fill="#a8350c"/><circle cx="38" cy="44" r="13" fill="#c64a18"/><path d="M 28 39 Q 38 50 50 41 Q 48 50 38 53 Q 30 50 28 39Z" fill="#f0c89a"/><path d="M 22 26 Q 26 16 32 22 Q 32 28 28 31Z" fill="#a8350c"/><path d="M 24 25 Q 27 19 30 24 Q 30 27 28 29Z" fill="#e0805a"/><path d="M 50 24 Q 46 16 42 22 Q 42 28 46 31Z" fill="#a8350c"/><path d="M 48 24 Q 45 19 43 24 Q 43 27 45 29Z" fill="#e0805a"/><circle cx="44" cy="38" r="3.6" fill="#1a0a05"/><circle cx="44" cy="38" r="2.6" fill="#2a1208"/><circle cx="42.7" cy="36.7" r="1.3" fill="#fff"/><ellipse cx="49" cy="46" rx="5.5" ry="4" fill="#9a3008"/><ellipse cx="50.5" cy="45" rx="3" ry="2.2" fill="#c64a18"/><circle cx="51" cy="44.5" r="1.6" fill="#1a0a05"/><path d="M 47 50 Q 49 51 51 50" stroke="#1a0a05" stroke-width="1.1" stroke-linecap="round" fill="none"/><ellipse cx="26" cy="68" rx="4.5" ry="6" fill="#5a1804"/><ellipse cx="36" cy="69" rx="4" ry="5" fill="#5a1804"/><ellipse cx="26" cy="68" rx="2.2" ry="3" fill="#7a2808"/><ellipse cx="36" cy="69" rx="2" ry="2.5" fill="#7a2808"/></svg>`,
'eichhoernchen_schwarz':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><path d="M 50 72 Q 74 60 72 32 Q 70 14 54 16 Q 38 18 42 38 Q 46 58 50 72Z" fill="#0e0f1a"/><path d="M 51 70 Q 68 58 66 34 Q 64 22 54 24 Q 44 26 46 40 Q 48 56 51 70Z" fill="#1c1d33"/><path d="M 53 66 Q 62 56 61 38 Q 60 30 55 32 Q 50 34 51 42 Q 52 54 53 66Z" fill="#2a2c4a"/><ellipse cx="34" cy="62" rx="17" ry="12" fill="#0e0f1a"/><ellipse cx="34" cy="63" rx="13" ry="9" fill="#1c1d33"/><ellipse cx="36" cy="68" rx="9" ry="5" fill="#7a7e95"/><circle cx="38" cy="42" r="15" fill="#0e0f1a"/><circle cx="38" cy="44" r="13" fill="#1c1d33"/><path d="M 28 39 Q 38 50 50 41 Q 48 50 38 53 Q 30 50 28 39Z" fill="#7a7e95"/><path d="M 22 26 Q 26 16 32 22 Q 32 28 28 31Z" fill="#0e0f1a"/><path d="M 24 25 Q 27 19 30 24 Q 30 27 28 29Z" fill="#3a3c5a"/><path d="M 50 24 Q 46 16 42 22 Q 42 28 46 31Z" fill="#0e0f1a"/><path d="M 48 24 Q 45 19 43 24 Q 43 27 45 29Z" fill="#3a3c5a"/><circle cx="44" cy="38" r="3.6" fill="#e8eaf2"/><circle cx="44" cy="38" r="2.6" fill="#c0c4d4"/><circle cx="42.7" cy="36.7" r="1.3" fill="#fff"/><ellipse cx="49" cy="46" rx="5.5" ry="4" fill="#0a0b14"/><ellipse cx="50.5" cy="45" rx="3" ry="2.2" fill="#252742"/><circle cx="51" cy="44.5" r="1.6" fill="#7a7e95"/><path d="M 47 50 Q 49 51 51 50" stroke="#9aa0b8" stroke-width="1.1" stroke-linecap="round" fill="none"/><ellipse cx="26" cy="68" rx="4.5" ry="6" fill="#050610"/><ellipse cx="36" cy="69" rx="4" ry="5" fill="#050610"/><ellipse cx="26" cy="68" rx="2.2" ry="3" fill="#1a1b2c"/><ellipse cx="36" cy="69" rx="2" ry="2.5" fill="#1a1b2c"/></svg>`,
'eichhoernchen_hell':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><path d="M 50 72 Q 74 60 72 32 Q 70 14 54 16 Q 38 18 42 38 Q 46 58 50 72Z" fill="#a89570"/><path d="M 51 70 Q 68 58 66 34 Q 64 22 54 24 Q 44 26 46 40 Q 48 56 51 70Z" fill="#c8b288"/><path d="M 53 66 Q 62 56 61 38 Q 60 30 55 32 Q 50 34 51 42 Q 52 54 53 66Z" fill="#e6d2a8"/><ellipse cx="34" cy="62" rx="17" ry="12" fill="#a89570"/><ellipse cx="34" cy="63" rx="13" ry="9" fill="#c8b288"/><ellipse cx="36" cy="68" rx="9" ry="5" fill="#f5ead0"/><circle cx="38" cy="42" r="15" fill="#a89570"/><circle cx="38" cy="44" r="13" fill="#c8b288"/><path d="M 28 39 Q 38 50 50 41 Q 48 50 38 53 Q 30 50 28 39Z" fill="#f5ead0"/><path d="M 22 26 Q 26 16 32 22 Q 32 28 28 31Z" fill="#a89570"/><path d="M 24 25 Q 27 19 30 24 Q 30 27 28 29Z" fill="#d8c098"/><path d="M 50 24 Q 46 16 42 22 Q 42 28 46 31Z" fill="#a89570"/><path d="M 48 24 Q 45 19 43 24 Q 43 27 45 29Z" fill="#d8c098"/><circle cx="44" cy="38" r="3.6" fill="#2a1f10"/><circle cx="44" cy="38" r="2.6" fill="#3a2a18"/><circle cx="42.7" cy="36.7" r="1.3" fill="#fff"/><ellipse cx="49" cy="46" rx="5.5" ry="4" fill="#9a8458"/><ellipse cx="50.5" cy="45" rx="3" ry="2.2" fill="#c8b288"/><circle cx="51" cy="44.5" r="1.6" fill="#3a2a18"/><path d="M 47 50 Q 49 51 51 50" stroke="#3a2a18" stroke-width="1.1" stroke-linecap="round" fill="none"/><ellipse cx="26" cy="68" rx="4.5" ry="6" fill="#806a48"/><ellipse cx="36" cy="69" rx="4" ry="5" fill="#806a48"/><ellipse cx="26" cy="68" rx="2.2" ry="3" fill="#a08458"/><ellipse cx="36" cy="69" rx="2" ry="2.5" fill="#a08458"/></svg>`
};

// ── Sichtungen drilldown (inline accordion) ──────────────────────────────────
// State is module-level so the renderer can reflect the open card with an
// outline+highlight and the wrap stays consistent across re-renders.
let _achOpenId = null;
let _achDrillItems = [];
let _achDrillTotal = 0;
let _achDrillPage = 0;
const _ACH_DRILL_LIMIT = 24;
let _achDrillLoading = false;

// Lightbox navigation uses state.media — we save whatever was there so the
// main Mediathek keeps its own list intact while the user pages through a
// Sichtungen drilldown.
let _achDrillSavedMedia = null;
function _achDrillStashMedia(){
  if(_achDrillSavedMedia === null) _achDrillSavedMedia = state.media;
  state.media = _achDrillItems;
}
function _achDrillRestoreMedia(){
  if(_achDrillSavedMedia !== null){
    state.media = _achDrillSavedMedia;
    _achDrillSavedMedia = null;
  }
}

async function _achDrillFetch(speciesId, offset){
  try{
    const r = await j(`/api/achievements/${encodeURIComponent(speciesId)}/media?limit=${_ACH_DRILL_LIMIT}&offset=${offset}`);
    return r || {items:[], total_count:0};
  }catch(e){
    return {items:[], total_count:0};
  }
}

function _achDrillRenderItems(){
  const grid = byId('achDrillGrid'); if(!grid) return;
  if(!_achDrillItems.length){
    grid.innerHTML = '<div class="item muted" style="padding:16px;grid-column:1/-1">Noch keine archivierten Aufnahmen für diese Art.</div>';
  }else{
    grid.innerHTML = _achDrillItems.map(mediaCardHTML).join('');
  }
  const more = byId('achDrillMore');
  if(more){
    more.style.display = _achDrillItems.length < _achDrillTotal ? '' : 'none';
  }
  const countEl = byId('achDrillCount');
  if(countEl){
    const shown = _achDrillItems.length;
    countEl.textContent = _achDrillTotal <= shown ? `${shown}` : `${shown} von ${_achDrillTotal}`;
  }
  // Cards click → openLightbox with our item list in scope
  _achDrillStashMedia();
  grid.querySelectorAll('.media-card').forEach(card=>{
    const eid = card.dataset.eventId;
    card.style.cursor = 'pointer';
    card.onclick = (ev) => {
      // Leave stop-propagation for inner buttons (confirm/delete already
      // call event.stopPropagation() in their onclick), so this only fires
      // when the card body itself is clicked.
      if(ev.target.closest('.mmc-actions, .media-confirmed-badge')) return;
      const it = _achDrillItems.find(x=>x.event_id===eid);
      if(it) openLightbox(it);
    };
  });
}

async function toggleAchDrilldown(id, name){
  // Second click on the same card → close.
  if(_achOpenId === id){
    closeAchDrilldown();
    return;
  }
  _achOpenId = id;
  _achDrillItems = [];
  _achDrillTotal = 0;
  _achDrillPage = 0;
  // Re-render grid so the previous active card loses its highlight and
  // the newly-active one gains it; the drilldown wrap below the grid is
  // recreated empty as part of that render.
  renderAchievements();
  const wrap = byId('achDrilldownWrap'); if(!wrap) return;
  const nameEl = byId('achDrillName'); if(nameEl) nameEl.textContent = name || id;
  const grid = byId('achDrillGrid'); if(grid) grid.innerHTML = '<div class="field-help" style="padding:16px;grid-column:1/-1">Lade Sichtungen…</div>';
  // Expand the accordion first so the fetch result slots into a visible container.
  wrap.classList.add('ach-drilldown-wrap--open');
  // Scroll the drilldown into view once the height transition starts.
  setTimeout(()=>{ byId('achDrilldownWrap')?.scrollIntoView({behavior:'smooth', block:'nearest'}); }, 60);
  _achDrillLoading = true;
  const r = await _achDrillFetch(id, 0);
  _achDrillLoading = false;
  // Check the user didn't close / switch the drilldown while we were waiting.
  if(_achOpenId !== id) return;
  _achDrillItems = r.items || [];
  _achDrillTotal = r.total_count || 0;
  _achDrillRenderItems();
}
window.toggleAchDrilldown = toggleAchDrilldown;

async function loadMoreAchDrill(){
  if(!_achOpenId || _achDrillLoading) return;
  _achDrillLoading = true;
  _achDrillPage += 1;
  const r = await _achDrillFetch(_achOpenId, _achDrillPage * _ACH_DRILL_LIMIT);
  _achDrillLoading = false;
  if(r && r.items && r.items.length){
    _achDrillItems = _achDrillItems.concat(r.items);
    _achDrillTotal = r.total_count || _achDrillItems.length;
    _achDrillRenderItems();
  }
}
window.loadMoreAchDrill = loadMoreAchDrill;

function closeAchDrilldown(){
  const wrap = byId('achDrilldownWrap');
  if(wrap) wrap.classList.remove('ach-drilldown-wrap--open');
  _achOpenId = null;
  _achDrillItems = [];
  _achDrillTotal = 0;
  _achDrillPage = 0;
  _achDrillRestoreMedia();
  renderAchievements();
}
window.closeAchDrilldown = closeAchDrilldown;

// Legacy name kept so any lingering inline callers don't break.
function openAchievementDrilldown(id, name){ toggleAchDrilldown(id, name); }

// ── Achievements / Sichtungen ─────────────────────────────────────────────────
// Top 20 Bavarian garden birds (LBV Stunde der Gartenvögel 2025 Bayern),
// sorted by frequency (most common first). freq values drive rarity pills.
const ACH_DEFS=[
  {id:'haussperling',     name:'Haussperling',     icon:'🐦', cat:'birds', freq:'sehr haeufig',  rank:1},
  {id:'amsel',            name:'Amsel',            icon:'🐦', cat:'birds', freq:'sehr haeufig',  rank:2},
  {id:'kohlmeise',        name:'Kohlmeise',        icon:'🐦', cat:'birds', freq:'sehr haeufig',  rank:3},
  {id:'star',             name:'Star',             icon:'🐦', cat:'birds', freq:'haeufig',       rank:4},
  {id:'feldsperling',     name:'Feldsperling',     icon:'🐦', cat:'birds', freq:'haeufig',       rank:5},
  {id:'blaumeise',        name:'Blaumeise',        icon:'🐦', cat:'birds', freq:'haeufig',       rank:6},
  {id:'ringeltaube',      name:'Ringeltaube',      icon:'🐦', cat:'birds', freq:'haeufig',       rank:7},
  {id:'mauersegler',      name:'Mauersegler',      icon:'🐦', cat:'birds', freq:'haeufig',       rank:8},
  {id:'elster',           name:'Elster',           icon:'🐦', cat:'birds', freq:'regelmaessig',  rank:9},
  {id:'mehlschwalbe',     name:'Mehlschwalbe',     icon:'🐦', cat:'birds', freq:'regelmaessig',  rank:10},
  {id:'buchfink',         name:'Buchfink',         icon:'🐦', cat:'birds', freq:'regelmaessig',  rank:11},
  {id:'rotkehlchen',      name:'Rotkehlchen',      icon:'🐦', cat:'birds', freq:'regelmaessig',  rank:12},
  {id:'gruenfink',        name:'Grünfink',         icon:'🐦', cat:'birds', freq:'regelmaessig',  rank:13},
  {id:'rabenkraehe',      name:'Rabenkrähe',       icon:'🐦', cat:'birds', freq:'regelmaessig',  rank:14},
  {id:'hausrotschwanz',   name:'Hausrotschwanz',   icon:'🐦', cat:'birds', freq:'gelegentlich',  rank:15},
  {id:'moenchsgrasmucke', name:'Mönchsgrasmücke',  icon:'🐦', cat:'birds', freq:'gelegentlich',  rank:16},
  {id:'stieglitz',        name:'Stieglitz',        icon:'🐦', cat:'birds', freq:'gelegentlich',  rank:17},
  {id:'buntspecht',       name:'Buntspecht',       icon:'🐦', cat:'birds', freq:'gelegentlich',  rank:18},
  {id:'kleiber',          name:'Kleiber',          icon:'🐦', cat:'birds', freq:'selten',        rank:19},
  {id:'eichelhaher',      name:'Eichelhäher',      icon:'🐦', cat:'birds', freq:'selten',        rank:20},
  // Säugetiere — Eichhörnchen sind das Aushängeschild des Projekts, daher
  // pinnen wir sie über die Vögel hinweg an den Anfang.
  {id:'eichhoernchen_orange',  name:'Eichhörnchen (rot)',     icon:'🐿️', cat:'mammals', freq:'haeufig',      rank:1, pin:-3},
  {id:'eichhoernchen_schwarz', name:'Eichhörnchen (schwarz)', icon:'🐿️', cat:'mammals', freq:'selten',       rank:2, pin:-2},
  {id:'eichhoernchen_hell',    name:'Eichhörnchen (hell)',    icon:'🐿️', cat:'mammals', freq:'selten',       rank:3, pin:-1},
  {id:'igel',         name:'Igel',          icon:'🦔', cat:'mammals', freq:'gelegentlich', rank:4},
  {id:'feldhase',     name:'Feldhase',      icon:'🐇', cat:'mammals', freq:'selten',       rank:5},
  {id:'reh',          name:'Reh',           icon:'🦌', cat:'mammals', freq:'selten',       rank:6},
  {id:'fuchs',        name:'Fuchs',         icon:'🦊', cat:'mammals', freq:'selten',       rank:7},
];

let _achData={};

async function loadAchievements(){
  try{
    const r=await j('/api/achievements');
    _achData=r.achievements||{};
  }catch{_achData={};}
  renderAchievements();
}

function _achTier(count){
  if(!count||count<1) return 'locked';
  if(count>=20) return 'gold';
  if(count>=5) return 'silver';
  return 'bronze';
}

function _medalSVG(achId, tier, birdSvg, isUnlocked, size=88){
  const uid=achId.replace(/[^a-z0-9]/g,'');
  // Locked medals are deliberately drab: two flat neutral greys, no
  // highlight arc. The silhouette is rendered faintly so the shape is
  // still recognisable without announcing itself.
  if(!isUnlocked){
    let silhouette='';
    if(birdSvg){
      // Desaturate + dim via filter so the silhouette is barely visible.
      silhouette=birdSvg.replace('<svg ',
        '<svg x="10" y="10" width="80" height="80" style="filter:grayscale(1) brightness(0.18) opacity(0.45)" ');
    }
    return `<svg viewBox="0 0 100 100" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="50" cy="50" r="47" fill="rgba(255,255,255,0.06)"/>
      <circle cx="50" cy="50" r="36" fill="rgba(255,255,255,0.03)"/>
      <circle cx="50" cy="50" r="36" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
      ${silhouette}
    </svg>`;
  }
  const rimC={bronze:['#4a2408','#c87840'], silver:['#303840','#a0b4c4'], gold:['#402e08','#e0c050']};
  const faceC={bronze:['#3a2010','#1e0e04'], silver:['#202e38','#101820'], gold:['#2a2010','#140e04']};
  const hlC={bronze:'#e09860', silver:'#c0d0e0', gold:'#f0e060'};
  const [rc,re]=rimC[tier];
  const [fc,fe]=faceC[tier];
  const hl=hlC[tier];
  const bird = birdSvg ? birdSvg.replace('<svg ',`<svg x="10" y="10" width="80" height="80" `) : '';
  return `<svg viewBox="0 0 100 100" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="rg${uid}" cx="50%" cy="40%" r="55%">
        <stop offset="0%" stop-color="${rc}"/>
        <stop offset="100%" stop-color="${re}"/>
      </radialGradient>
      <radialGradient id="fg${uid}" cx="42%" cy="38%" r="65%">
        <stop offset="0%" stop-color="${fc}"/>
        <stop offset="100%" stop-color="${fe}"/>
      </radialGradient>
    </defs>
    <circle cx="50" cy="50" r="47" fill="url(#rg${uid})"/>
    <circle cx="50" cy="50" r="36" fill="url(#fg${uid})"/>
    <circle cx="50" cy="50" r="36" fill="none" stroke="${re}" stroke-width="1.5" opacity=".5"/>
    <path d="M 25 30 A 28 28 0 0 1 70 22" fill="none" stroke="${hl}" stroke-width="5" stroke-linecap="round" opacity=".35"/>
    ${bird}
  </svg>`;
}

// Rarity → German label + subtle text colour when unlocked. Locked
// medals always render rarity in a neutral gray regardless of rank so
// the eye focuses on what's already been discovered, not what's missing.
const _FREQ_META={
  'sehr haeufig':  {label:'Sehr häufig',  color:'rgba(150,200,150,0.7)'},
  'haeufig':       {label:'Häufig',       color:'rgba(150,200,150,0.6)'},
  'regelmaessig':  {label:'Regelmäßig',   color:'rgba(200,200,150,0.7)'},
  'gelegentlich':  {label:'Gelegentlich', color:'rgba(210,170,100,0.7)'},
  'selten':        {label:'Selten',       color:'rgba(210,120,100,0.7)'},
};
function _rarityText(freq, isUnlocked){
  const m=_FREQ_META[freq]; if(!m) return '';
  const color = isUnlocked ? m.color : 'rgba(255,255,255,0.25)';
  return `<span class="medal-rarity" style="color:${color}">${m.label}</span>`;
}

function renderAchievements(){
  const unlocked=ACH_DEFS.filter(a=>_achData[a.id]);
  const total=ACH_DEFS.length;
  const pct=Math.round(unlocked.length/total*100);
  byId('achievementsProgress').innerHTML=`
    <span class="ach-progress-text">${unlocked.length} von ${total} gesichtet</span>
    <div class="ach-progress-track"><div class="ach-progress-fill" style="width:${pct}%"></div></div>
    <span class="ach-progress-pct">${pct}%</span>`;

  const legend=`<div class="ach-legend">
    <span><span class="ach-leg-dot" style="background:#c87840;width:14px;height:14px"></span><span style="font-size:13px;font-weight:600">Bronze 1–4×</span></span>
    <span><span class="ach-leg-dot" style="background:#a0b4c4;width:14px;height:14px"></span><span style="font-size:13px;font-weight:600">Silber 5–19×</span></span>
    <span><span class="ach-leg-dot" style="background:#e0c050;width:14px;height:14px"></span><span style="font-size:13px;font-weight:600">Gold 20×+</span></span>
  </div>`;

  const _renderCard=(a)=>{
    const info=_achData[a.id];
    const isUnlocked=!!info;
    const count=isUnlocked?(info.count||1):0;
    const tier=_achTier(count);
    const isSquirrelXL=a.cat==='mammals'&&a.id.startsWith('eichhoernchen_');
    const medalSize=isSquirrelXL?132:88;
    const iconSvg=a.cat==='birds'?(BIRD_SVGS[a.id]||null):(MAMMAL_SVGS[a.id]||null);
    const medalHtml=_medalSVG(a.id,tier,iconSvg,isUnlocked,medalSize);
    const emojiOverlay=!iconSvg
      ?`<span class="medal-emoji${isUnlocked?'':' medal-emoji-locked'}">${isUnlocked?a.icon:'🔒'}</span>`
      :'';
    // When unlocked: count-badge on medal. When locked: lock badge ABOVE medal (overlapping top).
    const badge=isUnlocked
      ?`<span class="medal-count-badge ${tier}">${count}×</span>`
      :`<div class="medal-lock-overlay"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" stroke-width="2.2" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="3"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg></div>`;
    // Bottom row: count + plain muted-colour rarity text. Squirrel XL tiles
    // replace the rarity slot with a dedicated variant subline (rendered
    // inside the name block) and omit rarity entirely.
    const countColors={bronze:'#d4894a',silver:'#90a8be',gold:'#d4a820'};
    const countSpan=isUnlocked
      ?`<span class="medal-count" style="color:${countColors[tier]||'#d4a820'}">${count}× gesehen</span>`
      :'';
    const footline=isSquirrelXL
      ?`<div class="medal-footline">${countSpan}</div>`
      :`<div class="medal-footline">${countSpan}${_rarityText(a.freq, isUnlocked)}</div>`;
    // Split "Eichhörnchen (rot)" → base name + variant suffix. On squirrel
    // XL tiles the suffix sits on its own line (.medal-variant). Other
    // tiles keep the inline-italic muted suffix.
    const nameParts=a.name.match(/^(.+?)\s*(\(.+\))?$/);
    const baseName=nameParts?.[1]||a.name;
    const variantSuffix=nameParts?.[2]||'';
    const nameHtml=isSquirrelXL
      ?`<div class="medal-name-base">${esc(baseName)}</div>${variantSuffix?`<div class="medal-variant">${esc(variantSuffix)}</div>`:''}`
      :`${esc(baseName)}${variantSuffix?`<span style="font-size:10px;font-weight:400;color:rgba(255,255,255,0.3);font-style:italic;margin-left:3px">${esc(variantSuffix)}</span>`:''}`;
    const clickable=isUnlocked?`onclick="toggleAchDrilldown('${esc(a.id)}','${esc(a.name)}')" style="cursor:pointer"`:'';
    const activeCls = (isUnlocked && _achOpenId === a.id) ? ' ach-card--active' : '';
    const xlCls=isSquirrelXL?' ach-card--xl':'';
    return `<div class="ach-card ${tier}${activeCls}${xlCls}" ${clickable}>
      <div class="medal-wrap">
        ${medalHtml}
        ${emojiOverlay}
        ${badge}
      </div>
      <div class="medal-name">${nameHtml}</div>
      ${footline}
    </div>`;
  };

  // Pinned items (negative pin rank) come first regardless of category, so
  // the Eichhörnchen variants sit at the very front. Then birds (by rank),
  // then the remaining mammals (by rank).
  const sorted = [...ACH_DEFS].sort((a,b)=>{
    const pa=a.pin??0, pb=b.pin??0;
    if(pa!==pb) return pa-pb;
    const catOrder = (a.cat==='birds'?0:1) - (b.cat==='birds'?0:1);
    if(catOrder) return catOrder;
    return (a.rank||99) - (b.rank||99);
  });
  const cards = sorted.map(_renderCard).join('');
  // Drilldown accordion — sits BETWEEN the grid and the legend so the
  // opening card's context stays close.
  const drilldown = `
    <div class="ach-drilldown-wrap${_achOpenId ? ' ach-drilldown-wrap--open' : ''}" id="achDrilldownWrap">
      <div class="ach-drilldown">
        <div class="ach-drill-header">
          <div class="ach-drill-title">🌿 <span id="achDrillName"></span></div>
          <span class="ach-drill-count" id="achDrillCount"></span>
          <button type="button" class="ach-drill-close" onclick="closeAchDrilldown()" aria-label="Schließen">✕</button>
        </div>
        <div class="ach-drill-grid" id="achDrillGrid"></div>
        <div class="ach-drill-more" id="achDrillMore" style="display:none">
          <button type="button" class="btn-action" onclick="loadMoreAchDrill()">Mehr laden</button>
        </div>
      </div>
    </div>`;
  byId('achievementsGrid').innerHTML=`<div class="ach-cards-grid">${cards}</div>${drilldown}`+legend;
  // If we re-rendered while a drilldown was open, re-populate the grid
  // from the in-memory cache so the user sees items immediately instead
  // of a "Lade…" placeholder on every click elsewhere.
  if(_achOpenId && _achDrillItems.length){
    _achDrillRenderItems();
  }
}

// Wire confirm modal
// Confirm-modal click wiring — moved into core/toast.js's
// bindConfirmModal() so the stage-2 module owns its own DOM
// listeners. Idempotent via dataset.wired.
bindConfirmModal();

// Legacy hero squirrel ASCII-injector — the hero now uses a static
// inline SVG ornament on the hyphen of "TAM-spy" so the random
// SQUIRREL_CHARS pick is no longer wired. Kept null-safe in case a
// stale template still has the #heroSquirrel element.
(()=>{const el=byId('heroSquirrel');if(el)el.innerHTML='';})();

// ── Statistics dashboard ──────────────────────────────────────────────────
const _STAT_LABEL_ICONS={motion:'👁',person:'🧍',cat:'🐈',bird:'🐦',car:'🚗',dog:'🐕',fox:'🦊',hedgehog:'🦔',squirrel:'🐿️',horse:'🐴'};
const _STAT_LABEL_COLORS={motion:'#36a2ff',person:'#ff6b6b',cat:'#9b8cff',bird:'#62d26f',car:'#00c2ff',dog:'#7c2d12',fox:'#ff7a1a',hedgehog:'#a67c52',squirrel:'#c8651a'};
// Section title icons — monochrome, currentColor, ~14px stroke style.
const _STAT_TITLE_SVG={
  camera:`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 5h2.5l1-1.5h5l1 1.5H14a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><circle cx="8" cy="9" r="2.7"/></svg>`,
  search:`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><line x1="10.5" y1="10.5" x2="14" y2="14"/></svg>`,
  clock:`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><polyline points="8,4.5 8,8 11,9.5"/></svg>`,
  grid:`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1.2"/><rect x="9" y="2" width="5" height="5" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx="1.2"/><rect x="9" y="9" width="5" height="5" rx="1.2"/></svg>`
};
let _statLoaded=false;

async function loadStatistik(){
  const content=byId('statContent'); if(!content) return;
  _statLoaded=true;
  content.innerHTML='<div class="stat-empty" style="padding:32px 0">Lade …</div>';
  const [monthData,dayData]=await Promise.all([
    j('/api/timeline?hours=720').catch(()=>({tracks:[],merged:[]})),
    j('/api/timeline?hours=24').catch(()=>({tracks:[],merged:[]}))
  ]);
  _renderStatistik(monthData,dayData);
}

function _statOpenMedia(camId,label){
  if(camId){ state.mediaCamera=camId; }
  if(label){ state.mediaLabels=new Set([label]); } else { state.mediaLabels=new Set(); }
  const mediaSection=document.querySelector('#media');
  if(!mediaSection) return;
  mediaSection.scrollIntoView({behavior:'smooth',block:'start'});
  setTimeout(()=>{ loadMedia(); },400);
}

function _renderStatistik(monthData,dayData){
  const content=byId('statContent'); if(!content) return;
  const now=new Date();
  const todayISO=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const weekAgoISO=new Date(now-7*24*3600*1000).toISOString();
  const allMonth=monthData.merged||[];

  const todayCount=allMonth.filter(e=>(e.time||'').startsWith(todayISO)).length;
  const weekCount=allMonth.filter(e=>e.time>=weekAgoISO).length;
  const monthCount=allMonth.length;

  const camCounts={};
  (monthData.tracks||[]).forEach(t=>{ camCounts[t.camera_id]=(t.points||[]).length; });
  const cameras=state.cameras||[];

  const labelCounts={};
  allMonth.forEach(e=>(e.labels||[]).forEach(l=>{ labelCounts[l]=(labelCounts[l]||0)+1; }));
  const totalLabels=Object.values(labelCounts).reduce((a,b)=>a+b,0)||1;
  const top3=Object.entries(labelCounts).sort((a,b)=>b[1]-a[1]).slice(0,3);

  // Rolling 24h buckets indexed by hoursAgo (0 = current hour, 23 = ~24h ago).
  // Rendering reverses this so the rightmost cell is hoursAgo=0 — the user
  // reads the strip right-to-left from "now".
  const hmData={};
  cameras.forEach(c=>{ hmData[c.id]=new Array(24).fill(0); });
  const nowMs=Date.now();
  (dayData.tracks||[]).forEach(t=>{
    if(!hmData[t.camera_id]) hmData[t.camera_id]=new Array(24).fill(0);
    (t.points||[]).forEach(e=>{
      const tt=new Date(e.time).getTime();
      if(!tt) return;
      const hoursAgo=Math.floor((nowMs-tt)/3600000);
      if(hoursAgo>=0&&hoursAgo<24) hmData[t.camera_id][hoursAgo]++;
    });
  });
  const hmMax=Math.max(1,...cameras.flatMap(c=>hmData[c.id]||[]));
  const hmHasData=cameras.some(c=>(hmData[c.id]||[]).some(v=>v>0));
  // Column 0 (leftmost) = hoursAgo=23, column 23 (rightmost) = hoursAgo=0.
  const hmColLabels=Array.from({length:24},(_,col)=>new Date(nowMs-(23-col)*3600000).getHours());

  const periodPills=[['Heute',todayCount],['Diese Woche',weekCount],['Dieser Monat',monthCount]]
    .map(([label,count])=>`<div class="stat-period-pill"><div class="stat-period-num">${count}</div><div class="stat-period-label">${label}</div></div>`).join('');

  // Slice + swatch colour comes from the camera icon (getCameraColor) so the
  // chart matches the icon next to each legend label.
  const camsWithEvents=cameras.map(c=>({c,cnt:camCounts[c.id]||0})).filter(x=>x.cnt>0);
  const camTotal=camsWithEvents.reduce((s,x)=>s+x.cnt,0);
  let camBars;
  if(!camsWithEvents.length){
    camBars='<div class="stat-empty">Keine Ereignisse</div>';
  } else {
    const R=60, C=2*Math.PI*R;
    let offset=0;
    const slices=camsWithEvents.map(x=>{
      const frac=x.cnt/camTotal;
      const len=frac*C;
      const dash=`${len.toFixed(2)} ${(C-len).toFixed(2)}`;
      const seg=`<circle cx="80" cy="80" r="${R}" fill="none" stroke="${getCameraColor(x.c.name||x.c.id)}" stroke-width="22" stroke-dasharray="${dash}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 80 80)"/>`;
      offset+=len;
      return seg;
    }).join('');
    const legend=camsWithEvents.map(x=>{
      const color=getCameraColor(x.c.name||x.c.id);
      const pct=Math.round(x.cnt/camTotal*100);
      const rowCls=STAT_MEDIA_DRILLDOWN?'stat-donut-row stat-drillable':'stat-donut-row';
      const rowClick=STAT_MEDIA_DRILLDOWN?`onclick="_statOpenMedia('${esc(x.c.id)}','')"`:'' ;
      const nm=x.c.name||x.c.id;
      return `<div class="${rowCls}" ${rowClick}>
        <span class="stat-donut-sw" style="background:${color}"></span>
        <span class="stat-donut-icon">${getCameraIcon(nm)}</span>
        <span class="stat-donut-name" title="${esc(nm)}">${esc(nm)}</span>
        <span class="stat-donut-cnt">${x.cnt}</span>
        <span class="stat-donut-pct">${pct}%</span>
      </div>`;
    }).join('');
    camBars=`<div class="stat-donut-wrap">
      <div class="stat-donut-chart">
        <svg viewBox="0 0 160 160" width="160" height="160" aria-hidden="true">
          <circle cx="80" cy="80" r="${R}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="22"/>
          ${slices}
        </svg>
        <div class="stat-donut-center">
          <div class="stat-donut-total">${camTotal}</div>
          <div class="stat-donut-sub">EVENTS</div>
        </div>
      </div>
      <div class="stat-donut-legend">${legend}</div>
    </div>`;
  }

  const topN=top3.slice(0,4);
  const topLabels=topN.length
    ?topN.map(([label,cnt])=>{
      const pct=Math.round(cnt/totalLabels*100);
      const color=CAT_COLORS[label]||colors[label]||_STAT_LABEL_COLORS[label]||'#cbd5e1';
      const icon=OBJ_SVG[label]?objIconSvg(label,18):(_STAT_LABEL_ICONS[label]||'🔍');
      const name=OBJ_LABEL[label]||label;
      const lblCls=STAT_MEDIA_DRILLDOWN?'stat-tile-row stat-drillable':'stat-tile-row';
      const lblClick=STAT_MEDIA_DRILLDOWN?`onclick="_statOpenMedia('','${esc(label)}')"`:'' ;
      return `<div class="${lblCls}" ${lblClick}>
        <div class="stat-tile-chip" style="background:${color}24"><span class="stat-tile-icon">${icon}</span></div>
        <div class="stat-tile-info">
          <div class="stat-tile-name">${esc(name)}</div>
          <div class="stat-tile-cnt">${cnt} Events</div>
        </div>
        <div class="stat-tile-pct" style="color:${color}">${pct}%</div>
      </div>`;}).join('')
    :'<div class="stat-empty">Keine Erkennungen</div>';

  const heatmap=hmHasData
    ?`<div class="stat-heatmap-wrap"><div class="stat-hm-grid">
        <div class="stat-hm-header">
          <div class="stat-hm-cam-col"></div>
          <div class="stat-hm-hours">${hmColLabels.map(h=>`<div class="stat-hm-hlabel">${h}</div>`).join('')}</div>
        </div>
        ${cameras.map(c=>{
          const hours=hmData[c.id]||new Array(24).fill(0);
          const hmCamCls=STAT_MEDIA_DRILLDOWN?'stat-hm-cam stat-drillable':'stat-hm-cam';
          const hmCamClick=STAT_MEDIA_DRILLDOWN?`onclick="_statOpenMedia('${esc(c.id)}','')"`:'' ;
          const cells=hmColLabels.map((labelHour,col)=>{
            const hoursAgo=23-col;
            const cnt=hours[hoursAgo]||0;
            const alpha=cnt===0?0:Math.max(0.18,0.12+cnt/hmMax*0.6);
            const bg=cnt===0?'rgba(255,255,255,0.04)':`rgba(255,255,255,${alpha.toFixed(2)})`;
            const prevHour=new Date(nowMs-(hoursAgo+1)*3600000).getHours();
            const h0=String(prevHour).padStart(2,'0');
            const h1=String(labelHour).padStart(2,'0');
            return `<div class="stat-hm-cell" style="background:${bg}" data-tip="${h0}:00–${h1}:00 · ${cnt} Events"></div>`;
          }).join('');
          return `<div class="stat-hm-row">
            <div class="${hmCamCls}" title="${esc(c.name||c.id)}" ${hmCamClick}>${getCameraIcon(c.name||c.id)}&nbsp;${esc(c.name||c.id)}</div>
            <div class="stat-hm-cells">${cells}</div>
          </div>`;}).join('')}
      </div></div>`
    :'<div class="stat-empty">Keine Ereignisse in den letzten 24h</div>';

  // 1–3: overview + per-camera + top detections
  content.innerHTML=`
    <div class="stat-period-row">${periodPills}</div>
    <div class="stat-split">
      <div class="stat-card"><div class="stat-card-title">${_STAT_TITLE_SVG.camera}<span>Events pro Kamera · letzter Monat</span></div>${camBars}</div>
      <div class="stat-card"><div class="stat-card-title">${_STAT_TITLE_SVG.search}<span>Top Erkennungen · letzter Monat</span></div>${topLabels}</div>
    </div>`;

  // 5: last 24h heatmap — rendered after the static timeline block (#4)
  const hmBlock=byId('statHeatmapBlock');
  if(hmBlock) hmBlock.innerHTML=`<div class="stat-card" style="margin-top:0"><div class="stat-card-title">${_STAT_TITLE_SVG.grid}<span>Letzte 24h · Aktivität nach Stunde</span></div>${heatmap}</div>`;

  // Camera label column auto-sizes to the widest entry so long names like
  // "Squirrel Town 'Nut Bar'" don't get clipped. Measure with the same
  // font as .stat-hm-cam (12px, weight 600). Clamp 80–180 px.
  if(hmBlock && cameras.length){
    const grid=hmBlock.querySelector('.stat-hm-grid');
    if(grid){
      const probe=document.createElement('canvas').getContext('2d');
      probe.font='600 12px Inter,system-ui,Segoe UI,Roboto,Arial,sans-serif';
      let widest=0;
      for(const c of cameras){
        // Same content the row renders: icon + nbsp + name. Icon is one
        // emoji wide (~16px); pad 12px for the cell's right padding.
        const txt=`${getCameraIcon(c.name||c.id)} ${c.name||c.id}`;
        const w=probe.measureText(txt).width;
        if(w>widest) widest=w;
      }
      const labelW=Math.max(80, Math.min(180, Math.ceil(widest)+24));
      grid.style.setProperty('--hm-label-w', labelW+'px');
    }
  }

  // Wire fixed-position tooltip for heatmap cells (CSS ::after clips inside overflow-x:auto)
  if(!_hmTip){
    _hmTip=document.createElement('div');
    _hmTip.style.cssText='position:fixed;z-index:9999;background:#0d1422;color:#edf4fb;font-size:11px;font-weight:600;padding:4px 9px;border-radius:8px;white-space:nowrap;pointer-events:none;box-shadow:0 2px 10px rgba(0,0,0,.6);display:none;border:1px solid rgba(255,255,255,.08)';
    document.body.appendChild(_hmTip);
  }
  (hmBlock||content).querySelectorAll('.stat-hm-cell[data-tip]').forEach(cell=>{
    cell.addEventListener('mouseenter',e=>{
      _hmTip.textContent=cell.dataset.tip;
      _hmTip.style.display='block';
      _hmTip.style.left=(e.clientX+14)+'px';
      _hmTip.style.top=(e.clientY-36)+'px';
    });
    cell.addEventListener('mousemove',e=>{
      _hmTip.style.left=(e.clientX+14)+'px';
      _hmTip.style.top=(e.clientY-36)+'px';
    });
    cell.addEventListener('mouseleave',()=>{ _hmTip.style.display='none'; });
  });
}

byId('statRefreshBtn')?.addEventListener('click',()=>{ _statLoaded=false; loadStatistik(); });
new IntersectionObserver((entries)=>{
  if(entries.some(e=>e.isIntersecting)&&!_statLoaded) loadStatistik();
},{threshold:0.05}).observe(byId('statistik'));

// Redirect #timeline → #statistik for nav backwards-compatibility
(function(){
  const redirectTl=()=>{
    if(window.location.hash==='#timeline'){
      byId('statistik')?.scrollIntoView({behavior:'smooth',block:'start'});
    }
  };
  redirectTl();
  window.addEventListener('hashchange',redirectTl);
})();

let _mediaResizeTimer=0;
window.addEventListener('resize',()=>{
  clearTimeout(_mediaResizeTimer);
  _mediaResizeTimer=setTimeout(()=>{
    if(byId('mediaDrilldown')?.style.display!=='none'){
      const ns=calcItemsPerPage();
      if(Math.abs(ns-_cachedPageSize)>=4){
        _cachedPageSize=ns;
        state.mediaTotalPages=Math.max(1,Math.ceil((state._allMedia||[]).length/ns));
        state.mediaPage=0;
        state.media=(state._allMedia||[]).slice(0,ns);
        renderMediaGrid();
        renderMediaPagination();
      }
    }
  },400);
});

loadAll().then(()=>{startLiveUpdate(); loadAchievements();});
loadLogs();

// ── Wetter-Ereignisse (Phase 2) ─────────────────────────────────────────────

// Single source of truth for type → label/color/icon. Backend mirror lives
// in app/app/weather_service.py:EVENT_LABEL_DE / EVENT_ICON_HEX — keep both
// in sync.
const WEATHER_TYPES = {
  thunder:    { de: 'Gewitter',        color: '#7faec9',
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2L3 14h7l-1 8 11-14h-7l0-6z"/></svg>' },
  heavy_rain: { de: 'Starkregen',      color: '#5a8aa8',
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 13a5 5 0 0 0 0-10 7 7 0 0 0-13.5 2.5"/><path d="M7 17l-2 4"/><path d="M11 19l-1 2"/><path d="M14 17l-2 4"/></svg>' },
  snow:       { de: 'Schnee',          color: '#a8c0d4',
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18M5 7l14 10M5 17l14-10"/></svg>' },
  fog:        { de: 'Nebel',           color: '#6d7787',
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h16M3 12h18M5 16h14M7 20h10"/></svg>' },
  sunset:     { de: 'Sonnenuntergang', color: '#d4823a',
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="14" r="4"/><path d="M12 4v3M5.6 7.6l2 2M2 14h3M19 14h3M16.4 9.6l2-2M3 20h18"/></svg>' },
  // Tägliche Sonnen-Timelapses — eigener Sub-Typ in der Wetter-Mediathek,
  // unabhängig vom score-gefilterten "sunset"-Wetter-Ereignis-Clip.
  sun_timelapse_rise: { de: 'Sonnenaufgang', color: '#e89540',
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="15" r="3.5"/><path d="M12 7v-4M5 11l-2-2M19 11l2-2M3 19h18"/><polyline points="9,5 12,2 15,5"/></svg>' },
  sun_timelapse_set:  { de: 'Sonnenuntergang TL', color: '#d4823a',
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="15" r="3.5"/><path d="M12 7v-4M5 11l-2-2M19 11l2-2M3 19h18"/><polyline points="9,1 12,4 15,1"/></svg>' },
  // Wetter-Ereignis-Timelapses — drei Trigger-Subtypen, ein gemeinsamer
  // 60-min-Capture-Mechanismus. Eigener event_type je Trigger, damit
  // Filter-Pills + Card-Badges in der Wetter-Mediathek auseinandergehalten
  // werden können.
  thunder_rising: { de: 'Gewitter zieht auf', color: '#7a8eb5',
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 16a5 5 0 0 0 0-10 7 7 0 0 0-13.5 2.5A4 4 0 0 0 5 16h12z"/><polyline points="11,11 9,15 12,15 10,19"/></svg>' },
  front_passing:  { de: 'Front zieht durch', color: '#9aa5b3',
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7c3-2 6 2 9 0s6-2 9 0M3 12c3-2 6 2 9 0s6-2 9 0M3 17c3-2 6 2 9 0s6-2 9 0"/></svg>' },
  storm_front:    { de: 'Sturmfront', color: '#b08070',
                icon: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 13a5 5 0 0 0 0-10 7 7 0 0 0-13.5 2.5"/><line x1="2" y1="16" x2="20" y2="16"/><line x1="5" y1="20" x2="22" y2="20"/></svg>' },
};

// ── Wetterdaten & Prognose chart (Phase 4) ──────────────────────────────────
// Single-source palette for the multi-line history chart. Re-uses the
// WEATHER_TYPES colours where the parameter maps cleanly onto an event
// type, picks close siblings for the diagnostic-only fields. Order here
// determines render order (last drawn sits on top).
const WEATHER_STATS_PALETTE = {
  precipitation:       '#5a8aa8',  // matches heavy_rain
  snowfall:            '#a8c0d4',  // matches snow
  lightning_potential: '#facc15',  // matches thunder badge
  visibility:          '#94a3b8',  // matches fog
  wind_gusts_10m:      '#84cc16',  // lime — diagnostic, distinct from the rain blues
  cloud_cover:         '#a78bfa',  // violet — diagnostic
  sun_altitude:        '#fb923c',  // matches sunset
};

const _WS_FIELD_ORDER = [
  'precipitation', 'snowfall', 'lightning_potential', 'visibility',
  'wind_gusts_10m', 'cloud_cover', 'sun_altitude',
];

let _wsStatsTimer_chart = null;
let _wsStatsObserver = null;
let _wsStatsState = {
  hours: 24,
  isolated: null,         // field key in isolated-mode, null = all lines
  data: null,             // last fetched payload
  inFlight: false,
};

async function loadWeatherStats(){
  if (_wsStatsState.inFlight) return;
  _wsStatsState.inFlight = true;
  try {
    const r = await fetch('/api/weather/history?hours=' + _wsStatsState.hours);
    _wsStatsState.data = await r.json();
    renderWeatherStats();
  } catch (e) {
    /* leave the previous render up — single transient error shouldn't blank the chart */
  } finally {
    _wsStatsState.inFlight = false;
  }
}

// Catmull-Rom-to-Bezier converter. Returns an SVG path string for the
// run of points, smoothed via cubic Beziers whose control points come
// from the slope between each point's neighbours (uniform Catmull-Rom,
// scaled by `tension` to dampen overshoots — 0.5 keeps the curve close
// to the data without introducing wild bumps). Endpoints duplicate
// themselves as virtual "p0/p3" so the first and last segments don't
// flatten or kink. The caller is responsible for ensuring points come
// from a contiguous run (no nulls) — gaps must be split into separate
// runs by the caller.
function _wsCatmullRomPath(pts, tension){
  if (!pts || pts.length < 2) return '';
  const k = tension / 6;
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++){
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || pts[i + 1];
    const c1x = p1[0] + (p2[0] - p0[0]) * k;
    const c1y = p1[1] + (p2[1] - p0[1]) * k;
    const c2x = p2[0] - (p3[0] - p1[0]) * k;
    const c2y = p2[1] - (p3[1] - p1[1]) * k;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

function _wsBuildLinePath(samples, key, x0, y0, w, h){
  // Per-line normalisation: each parameter gets its own min/max so a 30
  // mm/h precipitation peak doesn't flatten the 0.5 cm/h snow line.
  // Null values split the trace into independent runs — Catmull-Rom is
  // applied per-run so a single missing sample doesn't smear an
  // interpolated curve across the gap. Runs of <6 points fall back to
  // straight L-segments because a 3- or 4-point spline tends to
  // overshoot wildly on sparse data.
  const vals = [];
  for (const s of samples){
    const v = (s.values || {})[key];
    vals.push(typeof v === 'number' && isFinite(v) ? v : null);
  }
  const def = vals.filter(v => v != null);
  if (def.length < 2) return null;
  let lo = Math.min(...def), hi = Math.max(...def);
  if (hi - lo < 1e-9){ lo -= 0.5; hi += 0.5; } // flat line: pin to mid-band
  const N = vals.length;
  // Group into contiguous runs of [x, y] points.
  const runs = [];
  let cur = [];
  for (let i = 0; i < N; i++){
    const v = vals[i];
    if (v == null){
      if (cur.length){ runs.push(cur); cur = []; }
      continue;
    }
    const x = x0 + (N === 1 ? 0 : (i / (N - 1)) * w);
    const norm = (v - lo) / (hi - lo);
    const y = y0 + h - norm * h;
    cur.push([x, y]);
  }
  if (cur.length) runs.push(cur);
  let d = '';
  for (const run of runs){
    if (run.length >= 6){
      d += (d ? ' ' : '') + _wsCatmullRomPath(run, 0.5);
    } else {
      d += (d ? ' M' : 'M') + run[0][0].toFixed(1) + ',' + run[0][1].toFixed(1);
      for (let j = 1; j < run.length; j++){
        d += ' L' + run[j][0].toFixed(1) + ',' + run[j][1].toFixed(1);
      }
    }
  }
  return { path: d, lo, hi };
}

// X-axis tick formatter — adapts to the configured window so the bottom
// of the chart communicates the actual time scale at a glance.
//   hours ≤ 24   → "HH:MM"
//   hours ≤ 168  → "Di. HH:MM"   (German weekday + time)
//   hours > 168  → "DD.MM."      (date only — month-scale window)
const _WS_WEEKDAY_DE = ['So.','Mo.','Di.','Mi.','Do.','Fr.','Sa.'];
function _wsFmtTick(ts, hours){
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts.length >= 16 ? ts.slice(11, 16) : '';
  const p2 = n => (n < 10 ? '0' : '') + n;
  if (hours <= 24){
    return p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  if (hours <= 168){
    return _WS_WEEKDAY_DE[d.getDay()] + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  return p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.';
}

function _wsFmtVal(key, v){
  if (v == null || !isFinite(v)) return '—';
  const u = (_wsStatsState.data?.units || {})[key] || '';
  let s;
  if (key === 'sun_altitude') s = v.toFixed(0);
  else if (key === 'cloud_cover' || key === 'wind_gusts_10m') s = v.toFixed(0);
  else if (key === 'visibility') s = v.toFixed(0);
  else if (key === 'lightning_potential') s = v.toFixed(0);
  else s = v.toFixed(2);
  return u ? (s + ' ' + u) : s;
}

function _wsCurrentValue(key){
  // Walk back to the most recent non-null sample for this field. A single
  // failed poll (sun-altitude calc miss, API hiccup) shouldn't blank the
  // chip and strip its unit — the chip is meant to read as "this field's
  // latest known value", not "the last sample's value".
  const samples = _wsStatsState.data?.samples || [];
  for (let i = samples.length - 1; i >= 0; i--){
    const v = (samples[i].values || {})[key];
    if (typeof v === 'number' && isFinite(v)) return v;
  }
  return null;
}

// Field-detail copy shown beneath the chart when a legend chip is isolated.
// Three short German blocks per field: relevance for animal observation
// (TAM-spy's domain), weather correlation, seasonal pattern. Source of truth
// for the explainer card.
const WEATHER_STATS_EXPLAINERS = {
  precipitation: {
    summary: "Niederschlag misst Regen, Schnee und Graupel als Wassersäule pro Stunde — die Standard-Einheit ist mm/h.",
    relevance_for_animals: "Aktivitäts-Indikator: viele Vögel und Eichhörnchen reduzieren die Aktivität bei >2 mm/h, andere (Drosseln, Regenwürmer-Sucher) werden gerade dann sichtbar.",
    weather_correlation: "Korreliert positiv mit Bewölkung und Blitz-Potential, negativ mit Sicht.",
    seasonal_pattern: "In Mitteleuropa Maximum Juni–August (konvektive Schauer) und ein Nebenmaximum im Herbst.",
  },
  snowfall: {
    summary: "Schneefall in cm Neuschnee pro Stunde. 1 cm/h entspricht je nach Dichte etwa 0,7–1,2 mm/h Wasseräquivalent.",
    relevance_for_animals: "Frische Schneedecke macht Spuren und Wärmesignaturen besser erkennbar; viele Wildtiere reduzieren Aktivität auf wenige Spitzen am Tag.",
    weather_correlation: "Tritt nur bei Lufttemperaturen ≤ 1 °C zusammen mit aktivem Niederschlag auf.",
    seasonal_pattern: "In Mitteleuropa typisch von November bis März; vereinzelte Reste in Mittelgebirgen bis April.",
  },
  lightning_potential: {
    summary: "Konvektives Energiepotential (CAPE) in J/kg. Werte > 1000 J/kg gelten als Gewitter-Schwelle, > 2000 J/kg als markant unwetterträchtig.",
    relevance_for_animals: "Hohes Blitz-Potential verschiebt Tier-Aktivität in geschützte Bereiche; nach dem Durchzug oft eine kurze, hohe Aktivitätsspitze.",
    weather_correlation: "Korreliert positiv mit feucht-warmen Luftmassen, starkem vertikalem Temperaturgradient und herannahenden Frontensystemen.",
    seasonal_pattern: "Schwerpunkt Mai–August; gelegentliches Herbstmaximum bei warmen Mittelmeer-Tiefs.",
  },
  visibility: {
    summary: "Atmosphärische Sichtweite in Metern — die Distanz, in der ein Objekt vor dem Himmel noch erkennbar ist. Werte unter 1000 m gelten als Nebel.",
    relevance_for_animals: "Kameras verlieren Tier-Detail unter ~200 m, IR-Erkennung fällt zuerst aus. Manche Arten (Rehe, Füchse) nutzen reduzierte Sicht zur Annäherung an Häuser.",
    weather_correlation: "Sinkt mit hoher Luftfeuchte, Niederschlag und Inversionswetterlagen; steigt nach Frontdurchgängen mit kalter, trockener Luft.",
    seasonal_pattern: "Jahresminimum im Spätherbst und Winter (Strahlungs- und Hochnebel); Maximum im klaren Frühling nach kühlen Polarluft-Vorstößen.",
  },
  wind_gusts_10m: {
    summary: "Maximalwind-Böen in 10 m Höhe in km/h, gemittelt über das letzte 10-min-Intervall. Beaufort 6 ≈ 39 km/h, Sturm Beaufort 9 ≈ 75 km/h.",
    relevance_for_animals: "Vögel und kletternde Säuger reduzieren Aktivität ab ~30 km/h Böen; Greifvögel nutzen den Aufwind. Mikrofone werden ab ~25 km/h unbrauchbar.",
    weather_correlation: "Korreliert mit Druckgradient, Frontaldurchgang und nachmittäglicher thermischer Konvektion.",
    seasonal_pattern: "Winter- und Frühjahrsmaximum bei kräftigen Westwetterlagen; Sommer-Spitzen bei Gewitterböen.",
  },
  cloud_cover: {
    summary: "Bewölkungsgrad in Prozent — 0 % wolkenlos, 100 % bedeckt. Open-Meteo summiert tiefe, mittlere und hohe Wolken.",
    relevance_for_animals: "Diffuses Licht bei 60–90 % Bewölkung verlängert die Dämmerungsphase und erhöht Tier-Aktivität auf Lichtungen.",
    weather_correlation: "Vorlaufindikator für Niederschlag; hohe Bewölkung dämpft den Tagesgang der Temperatur um mehrere Grad.",
    seasonal_pattern: "Mittlere Bedeckung in Mitteleuropa ~60 %, mit November-Maximum (Dauergrau) und Aprilspitzen bei Aprilwetter.",
  },
  sun_altitude: {
    summary: "Sonnenhöhe ist der Winkel der Sonne über dem Horizont, gemessen in Grad. 0° = Horizont, 90° = direkt im Zenit, negative Werte = unter dem Horizont (Nacht).",
    relevance_for_animals: "Tagaktive Tiere folgen dem Sonnenstand: morgendliche und abendliche Aktivitätsspitzen liegen typisch zwischen 5° und 20° Höhe (sog. blue/golden hour für Beobachtung).",
    weather_correlation: "Direkter Treiber von Tagestemperatur, Schattenwurf und IR-Beleuchtungsbedarf der Kameras. Keine Wetter-Schwelle — eine astronomische Größe.",
    seasonal_pattern: "Maximum bei Sommersonnenwende (~63° in Nürnberg), Minimum bei Wintersonnenwende (~16°). Über das Jahr eine glatte Sinuskurve.",
  },
};

function _wsRenderExplainer(key){
  const e = WEATHER_STATS_EXPLAINERS[key];
  if (!e) return '';
  const colour = WEATHER_STATS_PALETTE[key] || '#94a3b8';
  const label = (_wsStatsState.data?.labels_de || {})[key] || key;
  return `<div class="ws-explainer-card" style="--cb:${colour}">
    <div class="ws-explainer-head">
      <span class="ws-explainer-dot" style="background:${colour}"></span>
      <h4>${label}</h4>
    </div>
    <p class="ws-explainer-summary">${e.summary}</p>
    <dl class="ws-explainer-list">
      <dt>Für Tierbeobachtung</dt><dd>${e.relevance_for_animals}</dd>
      <dt>Wetterzusammenhang</dt><dd>${e.weather_correlation}</dd>
      <dt>Jahresverlauf</dt><dd>${e.seasonal_pattern}</dd>
    </dl>
  </div>`;
}

function renderWeatherStatsExplainer(){
  const el = byId('weatherStatsExplainer'); if (!el) return;
  const k = _wsStatsState.isolated;
  if (!k){ el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = _wsRenderExplainer(k);
}

function renderWeatherStats(){
  renderWeatherStatsChart();
  renderWeatherStatsLegend();
  renderWeatherStatsExplainer();
}

function renderWeatherStatsChart(){
  const wrap = byId('weatherStatsChartWrap'); if (!wrap) return;
  const data = _wsStatsState.data;
  const samples = data?.samples || [];
  if (samples.length < 2){
    wrap.innerHTML = '<div class="ws-stats-empty">Noch zu wenige Messpunkte — der Verlauf füllt sich alle 5 min.</div>';
    return;
  }
  // Layout. Left lane reserved for Y-axis labels of the active line;
  // right padding for per-field threshold ticks in all-lines mode.
  // VB_PAD adds slack around the viewBox so axis labels never clip at
  // the very edge of the wrapper (overflow:hidden) even when their
  // baseline sits on the plot boundary.
  const VB_W = 600, VB_H = 220, VB_PAD = 4;
  const pad = { l: 42, r: 72, t: 12, b: 26 };
  const cw = VB_W - pad.l - pad.r;
  const ch = VB_H - pad.t - pad.b;
  const isolated = _wsStatsState.isolated;
  const fields = isolated ? [isolated] : _WS_FIELD_ORDER;
  const hours = _wsStatsState.hours || 24;

  // Time-based tick spacing keyed off the configured window:
  //   1 h  → every 10 min  · 6 ticks
  //   6 h  → every 1 h     · 6 ticks
  //   24 h → every 4 h     · 6 ticks
  //   7 d  → every 1 day   · 7 ticks
  //   30 d → every 5 days  · 6 ticks
  // Format adapts: HH:MM for ≤24 h, dd.MM for ≥7 d. Falls back to the
  // legacy index-based 6-tick scheme if timestamps fail to parse.
  const tFirst = new Date(samples[0]?.ts).getTime();
  const tLast = new Date(samples[samples.length - 1]?.ts).getTime();
  const tSpan = tLast - tFirst;
  let tickSvg = '';
  let xAxisFmt = (d) => {
    const p2 = n => (n < 10 ? '0' : '') + n;
    return p2(d.getHours()) + ':' + p2(d.getMinutes());
  };
  if (hours >= 168){
    xAxisFmt = (d) => {
      const p2 = n => (n < 10 ? '0' : '') + n;
      return p2(d.getDate()) + '.' + p2(d.getMonth() + 1);
    };
  }
  if (Number.isFinite(tFirst) && Number.isFinite(tLast) && tSpan > 0){
    let stepMs;
    if (hours <= 1)        stepMs = 10 * 60 * 1000;          // 10 min
    else if (hours <= 6)   stepMs = 60 * 60 * 1000;          // 1 h
    else if (hours <= 24)  stepMs = 4 * 60 * 60 * 1000;      // 4 h
    else if (hours <= 168) stepMs = 24 * 60 * 60 * 1000;     // 1 d
    else                   stepMs = 5 * 24 * 60 * 60 * 1000; // 5 d
    // Anchor first tick at first ceil-step boundary inside the window.
    const firstTick = Math.ceil(tFirst / stepMs) * stepMs;
    const ticks = [];
    for (let t = firstTick; t <= tLast; t += stepMs){
      ticks.push(t);
    }
    // Cap to a sane number so a 1-min-data 30-d zoom doesn't render 720 ticks.
    while (ticks.length > 8) ticks.splice(1, 2);  // thin every other inner tick
    // For ≤24 h windows that cross a midnight boundary, append a muted
    // "· dd.MM" suffix to the first tick of each new day so consecutive
    // "06:00 / 06:00" labels can be told apart. The dd.MM format already
    // shows the date for ≥7 d windows, so suffix only kicks in here.
    const isShortWindow = hours <= 24;
    let multiDay = false;
    if (isShortWindow){
      const dayKeys = new Set();
      for (const t of ticks){
        const dt = new Date(t);
        dayKeys.add(dt.getFullYear() + '-' + dt.getMonth() + '-' + dt.getDate());
      }
      multiDay = dayKeys.size > 1;
    }
    let lastDayKey = null;
    const p2 = n => (n < 10 ? '0' : '') + n;
    for (const t of ticks){
      const x = pad.l + ((t - tFirst) / tSpan) * cw;
      const dt = new Date(t);
      const dayKey = dt.getFullYear() + '-' + dt.getMonth() + '-' + dt.getDate();
      const label = xAxisFmt(dt);
      let suffix = '';
      if (multiDay && dayKey !== lastDayKey){
        suffix = ` · ${p2(dt.getDate())}.${p2(dt.getMonth() + 1)}`;
      }
      lastDayKey = dayKey;
      tickSvg += `<line x1="${x.toFixed(1)}" y1="${(pad.t + ch).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(pad.t + ch + 5).toFixed(1)}" stroke="rgba(255,255,255,.18)" stroke-width="1" shape-rendering="geometricPrecision"/>`;
      const suffixSvg = suffix ? `<tspan fill="rgba(255,255,255,.4)" font-size="9">${suffix}</tspan>` : '';
      tickSvg += `<text x="${x.toFixed(1)}" y="${(VB_H - 8).toFixed(1)}" text-anchor="middle" font-size="10" fill="rgba(255,255,255,.55)" text-rendering="geometricPrecision" shape-rendering="geometricPrecision">${label}${suffixSvg}</text>`;
    }
  } else {
    // Legacy fallback — no parseable timestamps, fall back to 6 ticks
    // anchored to data extremes.
    const last = samples.length - 1;
    const intervals = 5;
    for (let k = 0; k <= intervals; k++){
      const idx = Math.round(last * k / intervals);
      const x = pad.l + (idx / last) * cw;
      const anchor = k === 0 ? 'start' : k === intervals ? 'end' : 'middle';
      tickSvg += `<text x="${x.toFixed(1)}" y="${(VB_H - 8).toFixed(1)}" text-anchor="${anchor}" font-size="10" fill="rgba(255,255,255,.55)" text-rendering="geometricPrecision">${_wsFmtTick(samples[idx]?.ts, hours)}</text>`;
    }
  }

  // Horizontal grid: 4 evenly-spaced lines across the plotting area.
  // Subtle so they don't fight the data lines visually. Drawn UNDER
  // the lines (precedes linesSvg in the final concat).
  let gridSvg = '';
  for (let g = 0; g <= 4; g++){
    const y = pad.t + (g / 4) * ch;
    gridSvg += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${(pad.l + cw).toFixed(1)}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,.06)" stroke-width="1" vector-effect="non-scaling-stroke" shape-rendering="geometricPrecision"/>`;
  }
  // Lines — collect per-field meta so the threshold pass can renormalise
  // each tick against the same {lo, hi} the line was drawn against.
  let linesSvg = '';
  const lineMetas = {};
  for (const key of fields){
    const meta = _wsBuildLinePath(samples, key, pad.l, pad.t, cw, ch);
    if (!meta) continue;
    lineMetas[key] = meta;
    const colour = WEATHER_STATS_PALETTE[key] || '#94a3b8';
    const opacity = isolated && isolated !== key ? 0.15 : 1;
    linesSvg += `<path d="${meta.path}" fill="none" stroke="${colour}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}" vector-effect="non-scaling-stroke" shape-rendering="geometricPrecision" />`;
  }
  // Threshold overlay.
  //
  //  - Isolated mode: full horizontal dashed red line + right-side label
  //    (existing behaviour — that mode is for direct line-vs-boundary
  //    comparisons).
  //  - All-lines mode: per-field 18 px tick on the right edge in the
  //    line's own colour, with a 9 px label to the right of the tick.
  //    Always rendered when a threshold is configured, regardless of
  //    the event's enabled flag — events_enabled[k]==false dims the
  //    tick/label to 0.4 opacity. Out-of-range thresholds clamp to
  //    the top/bottom edge with ▲/▼ glyphs.
  let thresholdSvg = '';
  let noThresholdHint = '';
  if (isolated){
    const thr = (data?.thresholds || {})[isolated];
    const meta = lineMetas[isolated];
    if (thr == null){
      noThresholdHint = '<div class="ws-stats-no-threshold">keine Schwelle konfiguriert</div>';
    } else if (meta){
      const { lo, hi } = meta;
      const norm = (thr - lo) / (hi - lo);
      if (norm >= -0.05 && norm <= 1.05){
        const y = pad.t + ch - Math.max(0, Math.min(1, norm)) * ch;
        const u = (data?.units || {})[isolated] || '';
        // Floating annotation that sits ON the dashed line at the right
        // edge. The CSS class adds a paint-order=stroke halo so the red
        // text stays legible even when crossing a coloured data line.
        const lbl = `▲ ${thr}${u ? ' ' + u : ''} Schwelle`;
        thresholdSvg = `
          <line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${pad.l + cw}" y2="${y.toFixed(1)}"
                stroke="#fb7185" stroke-width="1.4" stroke-dasharray="6 4" opacity="0.85"
                vector-effect="non-scaling-stroke" shape-rendering="geometricPrecision" />
          <text class="ws-stats-threshold-label" x="${pad.l + cw - 8}" y="${(y - 4).toFixed(1)}" text-anchor="end">${lbl}</text>
        `;
      } else {
        noThresholdHint = '<div class="ws-stats-no-threshold">Schwelle außerhalb des sichtbaren Bereichs</div>';
      }
    }
  } else {
    const tickX1 = pad.l + cw - 18;
    const tickX2 = pad.l + cw;
    const labelX = pad.l + cw + 4;
    const placedYs = [];  // track placed label baselines to stack collisions
    for (const key of _WS_FIELD_ORDER){
      const meta = lineMetas[key]; if (!meta) continue;
      const thr = (data?.thresholds || {})[key];
      if (thr == null) continue;
      const enabled = (data?.events_enabled || {})[key];
      // events_enabled === null → field has no associated event (cloud,
      // wind, sun) and no threshold either, so the thr==null branch above
      // already handled it. true = armed (full opacity), false = configured
      // but off (dim).
      const opacity = enabled === false ? 0.4 : 1.0;
      const colour = WEATHER_STATS_PALETTE[key] || '#94a3b8';
      const { lo, hi } = meta;
      const norm = (thr - lo) / (hi - lo);
      let tickY, glyph = '', clampNote = '';
      if (norm > 1){
        tickY = pad.t + 4;
        glyph = '▲ ';
        clampNote = ` · aktuell ≪`;
      } else if (norm < 0){
        tickY = pad.t + ch - 4;
        glyph = '▼ ';
        clampNote = ` · aktuell ≫`;
      } else {
        tickY = pad.t + ch - norm * ch;
      }
      // Avoid label-on-label: shift down by 11 px until clear of any
      // already-placed label baseline (within ±11 px).
      let labelY = tickY + 3.5;
      while (placedYs.some(y => Math.abs(y - labelY) < 11)){
        labelY += 11;
      }
      placedYs.push(labelY);
      const u = (data?.units || {})[key] || '';
      const thrFmt = (typeof thr === 'number' && !Number.isInteger(thr) && Math.abs(thr) < 100)
        ? thr.toFixed(2)
        : Math.round(thr);
      const labelText = `${glyph}${thrFmt}${u ? ' ' + u : ''}`;
      const aria = `Schwelle ${thr}${u ? ' ' + u : ''}${clampNote}`;
      thresholdSvg += `
        <line x1="${tickX1.toFixed(1)}" y1="${tickY.toFixed(1)}" x2="${tickX2.toFixed(1)}" y2="${tickY.toFixed(1)}"
              stroke="${colour}" stroke-width="2" stroke-linecap="round" opacity="${opacity}"
              vector-effect="non-scaling-stroke" shape-rendering="geometricPrecision">
          <title>${aria}</title>
        </line>
        <text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" font-size="9" fill="${colour}" opacity="${opacity}" text-rendering="geometricPrecision">${labelText}</text>
      `;
    }
  }
  // Y-axis labels: when a line is isolated (or fields == 1), surface
  // its min and max in the line's own colour at the top-left and
  // bottom-left of the plotting area. In all-lines mode each line is
  // independently normalised, so a shared Y label would be meaningless;
  // skip the labels entirely in that mode (gridlines still anchor the
  // visual reading).
  let yAxisSvg = '';
  if (isolated && lineMetas[isolated]){
    const meta = lineMetas[isolated];
    const u = (data?.units || {})[isolated] || '';
    const colour = WEATHER_STATS_PALETTE[isolated] || '#94a3b8';
    const fmt = (v) => {
      if (Math.abs(v) < 100 && !Number.isInteger(v)) return v.toFixed(2);
      return Math.round(v).toString();
    };
    const hiTxt = `${fmt(meta.hi)}${u ? ' ' + u : ''}`;
    const loTxt = `${fmt(meta.lo)}${u ? ' ' + u : ''}`;
    // Top label sits 14 px BELOW the top gridline (was 4 px above) so it
    // never tips outside the SVG viewBox at the top edge. Bottom label
    // tucks 4 px above the bottom gridline. Both labels stay inside the
    // plot area no matter the wrapper's overflow.
    yAxisSvg = `
      <text x="${pad.l - 6}" y="${(pad.t + 14).toFixed(1)}" text-anchor="end" font-family="ui-monospace, SF Mono, Menlo, monospace" font-size="10" fill="${colour}" opacity="0.75" text-rendering="geometricPrecision" shape-rendering="geometricPrecision">${hiTxt}</text>
      <text x="${pad.l - 6}" y="${(pad.t + ch - 4).toFixed(1)}" text-anchor="end" font-family="ui-monospace, SF Mono, Menlo, monospace" font-size="10" fill="${colour}" opacity="0.75" text-rendering="geometricPrecision" shape-rendering="geometricPrecision">${loTxt}</text>
    `;
  }

  // viewBox padded by VB_PAD on every side so a label sitting on the very
  // edge of the plot area still has slack before it hits the wrap's
  // overflow:hidden boundary. preserveAspectRatio="none" stretches the
  // padded box to fill the wrapper, so the visual scale change is sub-
  // pixel and not noticeable.
  wrap.innerHTML = `
    <svg viewBox="${-VB_PAD} ${-VB_PAD} ${VB_W + 2 * VB_PAD} ${VB_H + 2 * VB_PAD}" preserveAspectRatio="none" role="img" aria-label="Wetterverlauf">
      ${gridSvg}
      ${yAxisSvg}
      ${tickSvg}
      ${linesSvg}
      ${thresholdSvg}
      <line class="ws-chart-guide" x1="0" y1="${pad.t}" x2="0" y2="${pad.t + ch}" stroke="rgba(255,255,255,.35)" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" shape-rendering="geometricPrecision" style="display:none;pointer-events:none"/>
      <rect class="ws-chart-hover-area" x="${pad.l}" y="${pad.t}" width="${cw}" height="${ch}" fill="transparent" style="pointer-events:all;cursor:crosshair"/>
    </svg>
    ${noThresholdHint}
    <div class="ws-chart-tooltip" hidden></div>
  `;
  _wsBindChartHover(wrap, samples, fields, pad, cw, ch, VB_W, VB_H, VB_PAD, isolated, data);
}

// Hover tooltip — vertical guide line + floating box that lists every
// active line's value at the hovered timestamp. Pointer events cover
// mouse + touch + pen. Touch taps auto-hide after 2.5 s. Reduced-motion
// users get instant show/hide (the CSS .ws-chart-tooltip has no
// transition by default; this comment is the contract).
function _wsBindChartHover(wrap, samples, fields, pad, cw, ch, VB_W, VB_H, VB_PAD, isolated, data){
  const svg = wrap.querySelector('svg'); if (!svg) return;
  const area = svg.querySelector('.ws-chart-hover-area');
  const guide = svg.querySelector('.ws-chart-guide');
  const tip = wrap.querySelector('.ws-chart-tooltip');
  if (!area || !guide || !tip) return;
  const tFirst = new Date(samples[0]?.ts).getTime();
  const tLast = new Date(samples[samples.length - 1]?.ts).getTime();
  const tSpan = tLast - tFirst;
  const labels = data?.labels_de || {};
  const hideTimer = { id: 0 };
  // Multi-day data: tooltip head shows "HH:MM · dd.MM" instead of just
  // HH:MM so the same time-of-day on different days isn't ambiguous.
  const firstDate = new Date(tFirst);
  const lastDate = new Date(tLast);
  const spansMultiDay = Number.isFinite(firstDate.getTime()) &&
                       Number.isFinite(lastDate.getTime()) &&
                       firstDate.toDateString() !== lastDate.toDateString();

  function _hide(){
    tip.hidden = true;
    guide.style.display = 'none';
    if (hideTimer.id) { clearTimeout(hideTimer.id); hideTimer.id = 0; }
  }

  function _onMove(ev){
    if (!Number.isFinite(tFirst) || !Number.isFinite(tLast) || tSpan <= 0){
      _hide(); return;
    }
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    // SVG uses preserveAspectRatio="none". The viewBox is padded by
    // VB_PAD on each side, so client-X maps to viewBox-X via the padded
    // total width and shifts back by -VB_PAD to get the original
    // coordinate system pad/cw operate in.
    const vbTotalW = VB_W + 2 * VB_PAD;
    const localX = -VB_PAD + (ev.clientX - rect.left) * (vbTotalW / rect.width);
    if (localX < pad.l || localX > pad.l + cw){ _hide(); return; }
    // Map x → timestamp → nearest sample index.
    const t = tFirst + ((localX - pad.l) / cw) * tSpan;
    let bestIdx = 0, bestDiff = Infinity;
    for (let i = 0; i < samples.length; i++){
      const ts = new Date(samples[i].ts).getTime();
      const d = Math.abs(ts - t);
      if (d < bestDiff){ bestDiff = d; bestIdx = i; }
    }
    const sample = samples[bestIdx];
    const sampleTs = new Date(sample.ts).getTime();
    const guideX = pad.l + ((sampleTs - tFirst) / tSpan) * cw;
    guide.setAttribute('x1', guideX.toFixed(1));
    guide.setAttribute('x2', guideX.toFixed(1));
    guide.style.display = '';
    // Tooltip body. Sample values live on sample.values[key], not on
    // sample[key] directly — the previous version walked the wrong
    // path so every row was filtered out and only the time header
    // rendered. Multi-day windows append "· dd.MM" so the same HH:MM
    // on adjacent days isn't ambiguous.
    const p2 = n => (n < 10 ? '0' : '') + n;
    const dt = new Date(sampleTs);
    const headTime = `${p2(dt.getHours())}:${p2(dt.getMinutes())}`;
    const head = spansMultiDay
      ? `${headTime} · ${p2(dt.getDate())}.${p2(dt.getMonth() + 1)}`
      : headTime;
    const sampleVals = sample.values || {};
    const rows = fields.map(key => {
      const v = sampleVals[key];
      if (v == null || !Number.isFinite(Number(v))) return '';
      const colour = WEATHER_STATS_PALETTE[key] || '#94a3b8';
      const lbl = labels[key] || key;
      const valFmt = _wsFmtVal(key, Number(v));
      return `<div class="ws-tt-row"><span class="ws-tt-dot" style="background:${colour}"></span><span class="ws-tt-lbl">${lbl}</span><span class="ws-tt-val">${valFmt}</span></div>`;
    }).filter(Boolean).join('');
    tip.innerHTML = `<div class="ws-tt-time">${head}</div>${rows}`;
    tip.hidden = false;
    // Position: 12 right + -6 top of cursor, clamped to wrap bounds.
    const wRect = wrap.getBoundingClientRect();
    const cx = ev.clientX - wRect.left + 12;
    const cy = ev.clientY - wRect.top - 6;
    tip.style.left = '0px';
    tip.style.top = '0px';
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    const px = Math.max(4, Math.min(cx, wRect.width - tipW - 4));
    const py = Math.max(4, Math.min(cy, wRect.height - tipH - 4));
    tip.style.left = px + 'px';
    tip.style.top = py + 'px';
    // Touch: auto-hide after 2.5 s of no further pointer events.
    if (ev.pointerType === 'touch'){
      if (hideTimer.id) clearTimeout(hideTimer.id);
      hideTimer.id = setTimeout(_hide, 2500);
    }
  }

  area.addEventListener('pointermove', _onMove);
  area.addEventListener('pointerdown', _onMove);
  area.addEventListener('pointerleave', () => {
    // Mouse: hide immediately. Touch: leave the auto-hide timer running.
    _hide();
  });
}

function renderWeatherStatsLegend(){
  const wrap = byId('weatherStatsLegend'); if (!wrap) return;
  const data = _wsStatsState.data;
  if (!data){ wrap.innerHTML = ''; return; }
  const isolated = _wsStatsState.isolated;
  const labels = data.labels_de || {};
  const html = _WS_FIELD_ORDER.map(key => {
    const colour = WEATHER_STATS_PALETTE[key] || '#94a3b8';
    const label = labels[key] || key;
    const val = _wsFmtVal(key, _wsCurrentValue(key));
    // When one series is isolated, the others render with .is-disabled
    // (opacity .35) so the active chip stands out without needing a
    // background pill to mark it. With no isolation, all chips render
    // at full opacity.
    let cls = 'ws-stats-chip';
    if (isolated){
      cls += isolated === key ? ' is-isolated' : ' is-disabled';
    }
    return `<button type="button" class="${cls}" data-field="${key}" aria-pressed="${isolated === key ? 'true' : 'false'}">
      <span class="ws-stats-chip-dot" style="--cb:${colour};background:${colour}"></span>
      <span class="ws-stats-chip-meta">
        <span class="ws-stats-chip-label">${label}</span>
        <span class="ws-stats-chip-value">${val}</span>
      </span>
    </button>`;
  }).join('');
  wrap.innerHTML = html;
  // Wire chip clicks once per render (innerHTML wipes prior listeners).
  wrap.querySelectorAll('.ws-stats-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.field;
      _wsStatsState.isolated = (_wsStatsState.isolated === key) ? null : key;
      renderWeatherStats();
    });
  });
}

function _bindWeatherStatsPills(){
  const bar = byId('weatherStatsPills'); if (!bar || bar.dataset.wired) return;
  bar.querySelectorAll('.ws-stats-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const h = parseInt(btn.dataset.hours, 10) || 24;
      if (h === _wsStatsState.hours) return;
      _wsStatsState.hours = h;
      bar.querySelectorAll('.ws-stats-pill').forEach(b => b.classList.toggle('is-active', b === btn));
      loadWeatherStats();
    });
  });
  bar.dataset.wired = '1';
}

function _startWeatherStatsRefresh(){
  if (_wsStatsTimer_chart) return; // already running
  loadWeatherStats();
  _wsStatsTimer_chart = setInterval(loadWeatherStats, 60_000);
}

function _stopWeatherStatsRefresh(){
  if (_wsStatsTimer_chart){ clearInterval(_wsStatsTimer_chart); _wsStatsTimer_chart = null; }
}

function initWeatherStats(){
  const block = byId('weatherStatsBlock'); if (!block) return;
  _bindWeatherStatsPills();
  if (_wsStatsObserver) return;  // already initialised
  // Pause polling while the section is off-screen — the chart is a
  // dashboard for the Wetter section, not a background task.
  _wsStatsObserver = new IntersectionObserver((entries) => {
    if (entries.some(e => e.isIntersecting)) _startWeatherStatsRefresh();
    else _stopWeatherStatsRefresh();
  }, { threshold: 0.05 });
  _wsStatsObserver.observe(block);
}

// Per-type unit hint for the threshold slider in Settings → Ereignistypen.
const WEATHER_THRESHOLD_HINTS = {
  thunder:    { unit: 'J/kg', min: 0,  max: 3000, step: 50, key: 'threshold' },
  heavy_rain: { unit: 'mm/h', min: 0,  max: 30,   step: 0.5, key: 'threshold' },
  snow:       { unit: 'cm/h', min: 0,  max: 5,    step: 0.1, key: 'threshold' },
  fog:        { unit: 'm',    min: 100,max: 5000, step: 100, key: 'vis_max_m' },
  sunset:     { unit: '°',    min: -10,max: 15,   step: 1,    key: 'alt_max' },
};

const WEATHER_FIELD_LABEL_DE = {
  precipitation:       'Niederschlag',
  snowfall:            'Schneefall',
  lightning_potential: 'Blitz-Potential',
  visibility:          'Sicht',
  wind_gusts_10m:      'Wind-Böen',
  cloud_cover:         'Bewölkung',
  weather_code:        'WMO-Code',
};
const WEATHER_FIELD_UNIT_DE = {
  precipitation:       'mm/h',
  snowfall:            'cm/h',
  lightning_potential: 'J/kg',
  visibility:          'm',
  wind_gusts_10m:      'km/h',
  cloud_cover:         '%',
  weather_code:        '',
};

async function loadWeatherSightings(filter){
  // Filter migrates from single-string to Set semantics: state.weather.filter
  // is a Set of event_type strings. Empty Set = "no filter, show everything"
  // (matches the Mediathek pill UX). Server fetch always pulls the full list
  // — filtering happens client-side in _renderWeatherGrid so toggling pills
  // doesn't trigger a network round-trip. The legacy single-string call site
  // is still tolerated: a string argument seeds a single-member Set.
  try{
    const r = await fetch('/api/weather/sightings');
    const data = await r.json();
    state.weather.items = data.items || [];
    state.weather.counts = data.counts || {};
    state.weather.total = data.total || 0;
    if (filter instanceof Set) {
      state.weather.filter = filter;
    } else if (typeof filter === 'string' && filter) {
      state.weather.filter = new Set([filter]);
    } else if (!(state.weather.filter instanceof Set)) {
      // First load → seed with every event type that has items, mirroring
      // the Mediathek "all on by default" rule.
      const present = Object.keys(WEATHER_TYPES).filter(t => (state.weather.counts[t]||0) > 0);
      state.weather.filter = new Set(present);
    }
    renderWeatherSightings();
  }catch(e){
    // silently degrade — section stays empty
  }
}

function renderWeatherSightings(){
  const block = byId('weatherSightingsBlock'); if (!block) return;
  const sub = byId('weatherSightingsSubtitle');
  if (sub) {
    const yr = new Date().getFullYear();
    sub.textContent = `${state.weather.total} Ereignisse · ${yr}`;
  }
  _renderWeatherFilterPills();
  _renderWeatherGrid();
}

function _renderWeatherFilterPills(){
  const bar = byId('weatherFilterBar'); if (!bar) return;
  // Sort by count desc, with ties by spec order. Counts==0 → empty/disabled
  // (mirrors the Mediathek pill recipe so the visual language is identical).
  const types = Object.keys(WEATHER_TYPES);
  const counts = state.weather.counts || {};
  const sorted = types.slice().sort((a,b) => {
    const d = (counts[b]||0) - (counts[a]||0);
    return d || (types.indexOf(a) - types.indexOf(b));
  });
  const sel = state.weather.filter instanceof Set ? state.weather.filter : new Set();
  let html = sorted.map(t => {
    const meta = WEATHER_TYPES[t];
    const cnt = counts[t] || 0;
    const empty = cnt === 0;
    const active = sel.has(t);
    const cls = `media-pill cat-filter-btn${active ? ' active' : ''}${empty ? ' media-pill--empty' : ''}`;
    const cntChip = cnt > 0 ? `<span class="mp-count" style="pointer-events:none">${cnt}</span>` : '';
    return `<button type="button" class="${cls}" data-type="weather" data-val="${esc(t)}" style="--cb:${meta.color}"${empty ? ' tabindex="-1" aria-disabled="true"' : ''}><span class="cfb-icon" style="pointer-events:none;color:${meta.color}">${meta.icon}</span><span style="pointer-events:none">${esc(meta.de)}</span>${cntChip}</button>`;
  }).join('');
  if (sel.size === 0) {
    html += `<span class="media-pill media-pill--status" aria-disabled="true">alle Filter aus</span>`;
  }
  bar.innerHTML = html;
  bar.querySelectorAll('.media-pill').forEach(p => {
    if (p.classList.contains('media-pill--empty')) return;
    if (p.classList.contains('media-pill--status')) return;
    p.addEventListener('click', () => {
      const val = p.dataset.val;
      if (!(state.weather.filter instanceof Set)) state.weather.filter = new Set();
      if (state.weather.filter.has(val)) state.weather.filter.delete(val);
      else state.weather.filter.add(val);
      // No fetch needed — filtering is client-side now.
      renderWeatherSightings();
    });
  });
}

function _renderWeatherGrid(){
  const grid = byId('weatherSightingsGrid'); if (!grid) return;
  const empty = byId('weatherSightingsEmpty');
  const allItems = state.weather.items || [];
  // Client-side filter: include items whose event_type is in the active
  // filter Set. Empty Set = "no filter active → show all" (matches the
  // Mediathek mental model).
  const sel = state.weather.filter instanceof Set ? state.weather.filter : new Set();
  const items = sel.size === 0 ? allItems
                                : allItems.filter(s => sel.has(s.event_type));
  if (!items.length) {
    grid.innerHTML = '';
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  grid.innerHTML = items.map((s, idx) => {
    const meta = WEATHER_TYPES[s.event_type] || { de: s.event_type, color: '#94a3b8', icon: '' };
    const t = new Date(s.started_at);
    const dateLabel = t.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
    const timeLabel = t.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const sevPct = Math.round((s.score || s.severity || 0) * 100);
    const camName = esc(s.cam_name || s.cam_id || '');
    return `
      <div class="ws-card" data-idx="${idx}" data-id="${esc(s.id)}">
        <div class="ws-card-thumb-wrap">
          <img class="ws-card-thumb" loading="lazy" src="/api/weather/sightings/${encodeURIComponent(s.id)}/thumb" alt="${esc(meta.de)}" onerror="this.style.opacity=0.2"/>
          <span class="ws-card-badge ws-card-badge--type" style="background:${meta.color}cc">
            <span class="ws-card-badge-icon">${meta.icon}</span>${esc(meta.de)}
          </span>
          ${sevPct > 0 ? `<span class="ws-card-badge ws-card-badge--score">${sevPct}%</span>` : ''}
          <span class="ws-card-play">
            <svg viewBox="0 0 24 24" width="34" height="34" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
          </span>
          <span class="ws-card-bottom-l">${dateLabel} · ${timeLabel}</span>
          <span class="ws-card-bottom-r">${camName}</span>
        </div>
      </div>`;
  }).join('');
  grid.querySelectorAll('.ws-card').forEach(card => {
    card.addEventListener('click', () => openWeatherLightbox(parseInt(card.dataset.idx, 10)));
  });
}

let _wsLbIdx = -1;

function openWeatherLightbox(idx){
  const items = state.weather.items || [];
  if (idx < 0 || idx >= items.length) return;
  _wsLbIdx = idx;
  const s = items[idx];
  // Build the modal lazily so the DOM stays clean when no sighting open.
  let modal = byId('wsLightbox');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'wsLightbox';
    modal.className = 'ws-lb';
    modal.innerHTML = `
      <div class="ws-lb-backdrop" data-action="close"></div>
      <div class="ws-lb-shell">
        <button class="ws-lb-close" data-action="close" aria-label="Schließen">✕</button>
        <button class="ws-lb-prev" data-action="prev" aria-label="Vorherige">‹</button>
        <button class="ws-lb-next" data-action="next" aria-label="Nächste">›</button>
        <div class="ws-lb-video-wrap"><video id="wsLbVideo" controls playsinline autoplay muted loop preload="metadata"></video></div>
        <div class="ws-lb-meta" id="wsLbMeta"></div>
        <div class="ws-lb-actions">
          <button class="btn-action" data-action="download">⬇ Herunterladen</button>
          <button class="btn-action danger-btn" data-action="delete">🗑 Löschen</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      if (action === 'close') closeWeatherLightbox();
      if (action === 'prev') openWeatherLightbox(_wsLbIdx - 1);
      if (action === 'next') openWeatherLightbox(_wsLbIdx + 1);
      if (action === 'download') {
        const cur = state.weather.items[_wsLbIdx];
        if (cur) window.open(`/api/weather/sightings/${encodeURIComponent(cur.id)}/clip`, '_blank');
      }
      if (action === 'delete') {
        const cur = state.weather.items[_wsLbIdx];
        if (cur && confirm('Wetter-Ereignis wirklich löschen?')) {
          fetch(`/api/weather/sightings/${encodeURIComponent(cur.id)}`, { method: 'DELETE' })
            .then(() => { closeWeatherLightbox(); loadWeatherSightings(state.weather.filter); });
        }
      }
    });
    document.addEventListener('keydown', (e) => {
      if (modal.classList.contains('open') === false) return;
      if (e.key === 'Escape') closeWeatherLightbox();
      if (e.key === 'ArrowLeft') openWeatherLightbox(_wsLbIdx - 1);
      if (e.key === 'ArrowRight') openWeatherLightbox(_wsLbIdx + 1);
    });
  }
  // Update video src + metadata
  const video = byId('wsLbVideo');
  video.src = `/api/weather/sightings/${encodeURIComponent(s.id)}/clip`;
  video.load(); video.play().catch(() => {});
  byId('wsLbMeta').innerHTML = _renderWsLbMeta(s);
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  modal.querySelector('.ws-lb-prev').style.opacity = idx > 0 ? '1' : '0.25';
  modal.querySelector('.ws-lb-next').style.opacity = idx < items.length - 1 ? '1' : '0.25';
}

function closeWeatherLightbox(){
  const modal = byId('wsLightbox'); if (!modal) return;
  modal.classList.remove('open');
  document.body.style.overflow = '';
  const v = byId('wsLbVideo'); if (v) { try { v.pause(); v.src = ''; } catch (e) {} }
}

function _renderWsLbMeta(s){
  const meta = WEATHER_TYPES[s.event_type] || { de: s.event_type, color: '#94a3b8' };
  const t = new Date(s.started_at);
  const fullDate = t.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  const snap = s.api_snapshot || {};
  const apiRows = Object.entries(snap)
    .filter(([k, v]) => v !== null && v !== undefined && k !== 'time')
    .map(([k, v]) => {
      const lbl = WEATHER_FIELD_LABEL_DE[k] || k;
      const unit = WEATHER_FIELD_UNIT_DE[k] || '';
      return `<div class="ws-lb-row"><span class="ws-lb-row-key">${esc(lbl)}</span><span class="ws-lb-row-val">${esc(String(v))}${unit ? ' ' + unit : ''}</span></div>`;
    }).join('');
  const showSun = (s.event_type === 'sunset' || s.event_type === 'fog') && s.sun_snapshot;
  const sunRows = showSun && s.sun_snapshot
    ? Object.entries(s.sun_snapshot)
        .filter(([_k, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `<div class="ws-lb-row"><span class="ws-lb-row-key">${k === 'altitude' ? 'Höhe' : 'Azimut'}</span><span class="ws-lb-row-val">${Number(v).toFixed(1)}°</span></div>`).join('')
    : '';
  return `
    <div class="ws-lb-headline">
      <span class="ws-lb-type-badge" style="background:${meta.color}33;border:1px solid ${meta.color}66;color:${meta.color}">${meta.icon || ''} ${esc(meta.de)}</span>
      <span class="ws-lb-date">${esc(fullDate)}</span>
    </div>
    <div class="ws-lb-cam">📷 ${esc(s.cam_name || s.cam_id || '')}</div>
    <div class="ws-lb-section-title">Wetter-Daten zur Aufnahme</div>
    <div class="ws-lb-rows">${apiRows || '<div class="ws-lb-row ws-lb-row--empty">— keine Mess­werte —</div>'}</div>
    ${sunRows ? `<div class="ws-lb-section-title">Sonne</div><div class="ws-lb-rows">${sunRows}</div>` : ''}
  `;
}

// ── Settings: Wetter-Ereignisse ──────────────────────────────────────────────

function initWeatherTabs(){
  const bar = document.querySelector('.ws-tab-bar'); if (!bar) return;
  const allPanels = ['ws-panel-cams', 'ws-panel-location', 'ws-panel-events', 'ws-panel-status'];
  bar.querySelectorAll('.set-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      bar.querySelectorAll('.set-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.tab;
      allPanels.forEach(id => { const p = byId(id); if (p) p.hidden = (id !== target); });
      if (target === 'ws-panel-status') _refreshWeatherStatus();
      if (target === 'ws-panel-location') _initWeatherMap();
    });
  });
}

// ── Weather "zuletzt gespeichert" hint ─────────────────────────────────────
// Quiet auto-save signal that replaces the per-input toast spam. Tick only
// runs while #set-weather is open — driven by a MutationObserver on the
// section's class list, so toggleSetSection stays untouched.
let _wsHintTimer = null;

let _wsPulseTimer = null;

function _wsBumpSavedHint(){
  state.weather = state.weather || {};
  state.weather._lastSavedAt = Date.now();
  _wsRenderSavedHint();
  const el = byId('weatherSavedHint');
  if (!el) return;
  // Restart the pulse animation on every save, even back-to-back ones.
  // The reflow read between remove/add forces the browser to retrigger.
  // Cancel the prior cleanup timer so a fast second save can't drop the
  // class mid-animation of the third.
  el.classList.remove('is-pulsing');
  void el.offsetWidth;
  el.classList.add('is-pulsing');
  if (_wsPulseTimer) clearTimeout(_wsPulseTimer);
  _wsPulseTimer = setTimeout(() => el.classList.remove('is-pulsing'), 2400);
}

function _wsRenderSavedHint(){
  const el = byId('weatherSavedHint');
  if (!el) return;
  const ts = state.weather && state.weather._lastSavedAt;
  if (!ts) { el.textContent = 'noch nicht gespeichert'; return; }
  const ageS = Math.max(0, (Date.now() - ts) / 1000);
  const label = ageS < 60
    ? 'gerade eben'
    : new Date(ts).toLocaleTimeString('de-DE', { hour12: false });
  el.textContent = 'zuletzt gespeichert · ' + label;
}

function _initWsSavedHintLifecycle(){
  const sec = byId('set-weather');
  if (!sec || sec.dataset.wsHintObs === '1') return;
  sec.dataset.wsHintObs = '1';
  const start = () => {
    _wsRenderSavedHint();
    if (!_wsHintTimer) _wsHintTimer = setInterval(_wsRenderSavedHint, 15000);
  };
  const stop = () => {
    if (_wsHintTimer) { clearInterval(_wsHintTimer); _wsHintTimer = null; }
  };
  const sync = () => sec.classList.contains('open') ? start() : stop();
  new MutationObserver(sync).observe(sec, { attributes: true, attributeFilter: ['class'] });
  sync();
}

let _weatherSaveTimer = null;

// Single chokepoint for every save inside the weather panel. Routes
// through one helper so new handlers can't forget to bump the
// "zuletzt gespeichert" hint — the prior sprinkle pattern silently
// missed the Farbmodus and Ereignis-Timelapse sliders. Returns the
// raw Response (or null on network error) so callers can still
// r.json() and guard state mutations on r.ok.
async function _weatherPanelSave(url, payload){
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (_) {
    showToast('Speichern fehlgeschlagen.', 'error');
    return null;
  }
  if (r.ok) _wsBumpSavedHint();
  else      showToast('Speichern fehlgeschlagen.', 'error');
  return r;
}

async function _saveWeatherCfg(partial){
  const r = await _weatherPanelSave('/api/settings/app', { weather: partial });
  if (r && r.ok) {
    state.config.weather = state.config.weather || {};
    _wsMergeDeep(state.config.weather, partial);
  }
}
function _wsMergeDeep(t, s){
  for (const k of Object.keys(s || {})) {
    if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k]) && t[k] && typeof t[k] === 'object') {
      _wsMergeDeep(t[k], s[k]);
    } else { t[k] = s[k]; }
  }
}
function _debouncedWeatherSave(partial, ms = 600){
  clearTimeout(_weatherSaveTimer);
  _weatherSaveTimer = setTimeout(() => _saveWeatherCfg(partial), ms);
}

function hydrateWeatherSettings(){
  const w = state.config?.weather || {};
  const srvLoc = state.config?.server?.location || {};
  const badge = byId('weatherStatusBadge');
  if (badge) {
    badge.textContent = w.enabled ? 'aktiv' : 'aus';
    badge.className = 'set-status-badge ' + (w.enabled ? 'set-status-badge--on' : 'set-status-badge--off');
  }
  const en = byId('ws_enabled'); if (en) en.checked = !!w.enabled;
  const lat = byId('ws_lat'); if (lat) lat.value = srvLoc.lat ?? '';
  const lon = byId('ws_lon'); if (lon) lon.value = srvLoc.lon ?? '';
  const elv = byId('ws_elev'); if (elv) elv.value = srvLoc.elevation ?? '';
  // Sun-Times preview lives next to the per-camera toggles. Fetched once
  // before the first render so window labels show the right values; the
  // _saveSunPhase handler refreshes it after each save.
  fetch('/api/weather/sun-times').then(r => r.json()).then(st => {
    state.weather._sunTimes = st;
    _renderWeatherCamList();
  }).catch(() => _renderWeatherCamList());
  _renderWeatherEventsList(w.events || {});
  _bindWeatherHandlers();
  _refreshWeatherStatus();
  _initWsSavedHintLifecycle();
}

// Loose Reolink-stream-URL detector. Only the path matters — Reolink RTSP
// paths consistently follow /(h264|h265)?Preview_<channel>_<main|sub>. A
// false positive just means the daynight HTTP call fails and the helper
// logs and falls back; cost is one warning, no broken capture.
function _isReolinkRtsp(rtspUrl){
  if (!rtspUrl || typeof rtspUrl !== 'string') return false;
  return /\/(h264|h265)?Preview_\d+_(main|sub)/i.test(rtspUrl);
}

// 🎨 Farbmodus erzwingen — sub-row of a sun-timelapse row. Renders the
// toggle + lead-time slider; only meaningful on Reolink cams. The whole
// row is dimmed and the toggle disabled for non-Reolink cams (the user
// can still inspect what the control would do).
function _renderSunDnovRow(camId, phase, pcfg, isReolink){
  const dn = pcfg.daynight_override || {};
  const dnEnabled = !!dn.enabled;
  const lead = Math.max(1, Math.min(15, parseInt(dn.lead_min, 10) || 5));
  const disabledAttr = isReolink ? '' : 'disabled';
  const titleAttr = isReolink ? '' : ' title="Funktioniert nur mit Reolink-Kameras"';
  const dimCls = isReolink ? '' : ' ws-sun-dnov--disabled';
  return `
    <div class="ws-sun-dnov${dimCls}" data-phase="${esc(phase)}"${titleAttr}>
      <span class="ws-sun-dnov-label">🎨 Farbmodus erzwingen</span>
      <label class="switch ws-sun-dnov-toggle"><input type="checkbox" data-sun-dnov="${esc(phase)}" ${dnEnabled ? 'checked' : ''} ${disabledAttr}/><span class="slider"></span></label>
      <div class="ws-sun-dnov-detail" ${dnEnabled ? '' : 'hidden'}>
        <input type="range" min="1" max="15" step="1" value="${lead}" data-sun-dnov-lead="${esc(phase)}" ${disabledAttr}/>
        <span><span class="ws-sun-dnov-lead-num">${lead}</span> min vorher</span>
      </div>
      <div class="ws-sun-dnov-help">${isReolink
        ? 'Schaltet die Reolink-Kamera per API kurz vor Aufnahme auf Farbe und nach Ende zurück auf Auto.'
        : 'Funktioniert nur mit Reolink-Kameras (h264/h265Preview-RTSP-Pfade).'}</div>
    </div>`;
}

// Sun-timelapse video-length helpers. fps is fixed at 25 here — the user
// picks a target duration in seconds; we derive the capture interval from
// the configured window so the resulting video lands close to the target.
const _WS_LENGTH_OPTIONS = [10, 15, 20, 30, 45];
const _WS_DEFAULT_LENGTH_S = 20;
const _WS_FPS = 25;

function _wsLengthPlan(window_min, target_duration_s){
  const fps = _WS_FPS;
  const target = parseInt(target_duration_s, 10) || _WS_DEFAULT_LENGTH_S;
  const window_s = (parseInt(window_min, 10) || 30) * 60;
  const frames_target = Math.max(1, target * fps);
  const interval_s = Math.max(1, Math.round(window_s / frames_target));
  const actual_frames = Math.floor(window_s / interval_s);
  const actual_duration_s = Math.round((actual_frames / fps) * 10) / 10;
  return {
    target, fps, frames_target, interval_s,
    actual_frames, actual_duration_s,
    was_clamped: actual_duration_s + 0.05 < target,
  };
}

function _wsRenderLengthPreview(plan){
  const main = `→ <b>${plan.actual_frames}</b> Frames · 1 Bild alle <b>${plan.interval_s}</b> s · <b>${plan.fps}</b> fps`;
  const warn = plan.was_clamped
    ? ` <span class="ws-sun-length-warn">Fenster zu kurz für ${plan.target} s — wird ~${plan.actual_duration_s} s</span>`
    : '';
  return main + warn;
}

function _wsRenderLengthRow(phase, pcfg){
  const window_min = parseInt(pcfg.window_min, 10) || 30;
  const target = parseInt(pcfg.target_duration_s, 10) || _WS_DEFAULT_LENGTH_S;
  const plan = _wsLengthPlan(window_min, target);
  const opts = _WS_LENGTH_OPTIONS.map(s =>
    `<option value="${s}"${s === plan.target ? ' selected' : ''}>${s} s</option>`
  ).join('');
  return `
    <div class="ws-sun-length" data-phase="${esc(phase)}">
      <span class="ws-sun-length-label">Video-Länge</span>
      <select data-sun-length="${esc(phase)}">${opts}</select>
      <span class="ws-sun-length-preview" data-sun-length-preview="${esc(phase)}">${_wsRenderLengthPreview(plan)}</span>
    </div>`;
}

// Picker selection persists across renders within a session. Falls back
// to the first weather-enabled camera (or first overall) when the cached
// id is no longer in the camera list (e.g. after a delete).
let _wsSelectedCam = null;

function _renderWeatherCamList(){
  const wrap = byId('weatherCamList'); if (!wrap) return;
  const cams = state.cameras || [];
  if (!cams.length) { wrap.innerHTML = '<div class="field-help">Keine Kameras konfiguriert.</div>'; return; }
  if (!cams.find(c => c.id === _wsSelectedCam)){
    const firstEnabled = cams.find(c => c.weather && c.weather.enabled);
    _wsSelectedCam = (firstEnabled || cams[0]).id;
  }
  const tabsHtml = cams.length > 1
    ? `<div class="set-tabs ws-cam-tabs">${cams.map(c => `
        <button type="button" class="set-tab${c.id === _wsSelectedCam ? ' active' : ''}" data-ws-cam-tab="${esc(c.id)}">
          ${getCameraIcon(c.name)} ${esc(c.name || c.id)}
        </button>`).join('')}</div>`
    : '';
  const sel = cams.find(c => c.id === _wsSelectedCam);
  wrap.innerHTML = `${tabsHtml}<div class="ws-cam-tab-content">${_renderWeatherCamPanel(sel)}</div>`;
  wrap.querySelectorAll('[data-ws-cam-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      _wsSelectedCam = btn.dataset.wsCamTab;
      _renderWeatherCamList();
    });
  });
  _bindWeatherCamPanel(wrap, sel);
}

function _renderWeatherCamPanel(c){
  if (!c) return '';
  const wEnabled = !!(c.weather && c.weather.enabled);
  const sun = (c.weather && c.weather.sun_timelapse) || {};
  const sr = sun.sunrise || {}, ss = sun.sunset || {};
  const sunPreview = state.weather._sunTimes || { cameras: [] };
  const pre = (sunPreview.cameras || []).find(e => e.id === c.id) || {};
  const previewLine = (phase, p) => {
    if (!p.enabled) return '';
    if (!sunPreview.location_set) return '<span class="ws-sun-preview ws-sun-preview--err">Standort fehlt</span>';
    const ev = pre[phase] || {};
    if (!ev.window_start) return '<span class="ws-sun-preview">Polartag — kein ' + (phase === 'sunrise' ? 'Aufgang' : 'Untergang') + ' heute</span>';
    return `<span class="ws-sun-preview">Heute: ${esc(ev.sun_event)} · Fenster ${esc(ev.window_start)} – ${esc(ev.window_end)}</span>`;
  };
  const isReolink = _isReolinkRtsp(c.rtsp_url);
  return `
    <div class="ws-cam-block" data-cam="${esc(c.id)}">
      <label class="toggle-row" style="margin:0">
        <span class="toggle-row-label">📷 ${esc(c.name || c.id)}</span>
        <label class="switch"><input type="checkbox" data-ws-cam="${esc(c.id)}" ${wEnabled ? 'checked' : ''}/><span class="slider"></span></label>
      </label>
      <div class="ws-sun-rows" ${wEnabled ? '' : 'hidden'}>
        <div class="ws-sun-row" data-phase="sunrise">
          <span class="ws-sun-icon" style="color:#e89540">${WEATHER_TYPES.sun_timelapse_rise.icon}</span>
          <span class="ws-sun-name">Sonnenaufgang</span>
          <label class="switch ws-sun-toggle"><input type="checkbox" data-sun-toggle="sunrise" ${sr.enabled ? 'checked' : ''}/><span class="slider"></span></label>
          <input type="range" class="ws-sun-slider" min="10" max="60" step="5" value="${sr.window_min || 30}" data-sun-window="sunrise"/>
          <span class="ws-sun-window"><span class="ws-sun-window-num">${sr.window_min || 30}</span> min</span>
          ${previewLine('sunrise', sr)}
          ${sr.enabled ? _wsRenderLengthRow('sunrise', sr) : ''}
          ${sr.enabled ? _renderSunDnovRow(c.id, 'sunrise', sr, isReolink) : ''}
        </div>
        <div class="ws-sun-row" data-phase="sunset">
          <span class="ws-sun-icon" style="color:#d4823a">${WEATHER_TYPES.sun_timelapse_set.icon}</span>
          <span class="ws-sun-name">Sonnenuntergang</span>
          <label class="switch ws-sun-toggle"><input type="checkbox" data-sun-toggle="sunset" ${ss.enabled ? 'checked' : ''}/><span class="slider"></span></label>
          <input type="range" class="ws-sun-slider" min="10" max="60" step="5" value="${ss.window_min || 30}" data-sun-window="sunset"/>
          <span class="ws-sun-window"><span class="ws-sun-window-num">${ss.window_min || 30}</span> min</span>
          ${previewLine('sunset', ss)}
          ${ss.enabled ? _wsRenderLengthRow('sunset', ss) : ''}
          ${ss.enabled ? _renderSunDnovRow(c.id, 'sunset', ss, isReolink) : ''}
        </div>
        ${_renderEventTLBlock(c)}
      </div>
    </div>`;
}

function _bindWeatherCamPanel(wrap, c){
  if (!c) return;
  const block = wrap.querySelector('.ws-cam-block'); if (!block) return;
  const camId = c.id;
  // Helper: read the current target_duration_s for a phase from the
  // in-memory state — fall back to the default if unset.
  const targetFor = (phase) => {
    const p = (((c.weather || {}).sun_timelapse || {})[phase] || {});
    return parseInt(p.target_duration_s, 10) || _WS_DEFAULT_LENGTH_S;
  };
  // Phase enable toggle.
  block.querySelectorAll('[data-sun-toggle]').forEach(cb => {
    cb.addEventListener('change', () => _saveSunPhase(camId, cb.dataset.sunToggle, { enabled: cb.checked }));
  });
  // Window slider — saving also recomputes interval_s so the backend sees
  // the new pacing without us round-tripping the formula on Python side.
  block.querySelectorAll('[data-sun-window]').forEach(sl => {
    const phase = sl.dataset.sunWindow;
    const numEl = sl.parentElement.querySelector('.ws-sun-window-num');
    const previewEl = block.querySelector(`[data-sun-length-preview="${phase}"]`);
    const refreshPreview = () => {
      if (!previewEl) return;
      const plan = _wsLengthPlan(parseInt(sl.value, 10), targetFor(phase));
      previewEl.innerHTML = _wsRenderLengthPreview(plan);
    };
    sl.addEventListener('input', () => {
      if (numEl) numEl.textContent = sl.value;
      refreshPreview();
    });
    sl.addEventListener('change', () => {
      const window_min = parseInt(sl.value, 10);
      const plan = _wsLengthPlan(window_min, targetFor(phase));
      _saveSunPhase(camId, phase, { window_min, interval_s: plan.interval_s });
    });
  });
  // Video-length select — persists the user's TARGET; backend uses the
  // recomputed interval_s for actual capture pacing.
  block.querySelectorAll('[data-sun-length]').forEach(sel => {
    const phase = sel.dataset.sunLength;
    const previewEl = block.querySelector(`[data-sun-length-preview="${phase}"]`);
    sel.addEventListener('change', () => {
      const target_duration_s = parseInt(sel.value, 10) || _WS_DEFAULT_LENGTH_S;
      const sliderEl = block.querySelector(`[data-sun-window="${phase}"]`);
      const window_min = sliderEl ? parseInt(sliderEl.value, 10) : 30;
      const plan = _wsLengthPlan(window_min, target_duration_s);
      if (previewEl) previewEl.innerHTML = _wsRenderLengthPreview(plan);
      _saveSunPhase(camId, phase, { target_duration_s, interval_s: plan.interval_s });
    });
  });
  // Day/night override toggles + lead-time sliders. _saveSunPhase
  // deep-merges the daynight_override sub-object so toggling enabled
  // doesn't wipe the lead_min the user dialled in (and vice versa).
  block.querySelectorAll('[data-sun-dnov]').forEach(cb => {
    cb.addEventListener('change', () => _saveSunPhase(camId, cb.dataset.sunDnov, {
      daynight_override: { enabled: cb.checked, revert: 'auto' },
    }));
  });
  block.querySelectorAll('[data-sun-dnov-lead]').forEach(sl => {
    const numEl = sl.parentElement.querySelector('.ws-sun-dnov-lead-num');
    sl.addEventListener('input', () => { if (numEl) numEl.textContent = sl.value; });
    sl.addEventListener('change', () => _saveSunPhase(camId, sl.dataset.sunDnovLead, {
      daynight_override: { lead_min: parseInt(sl.value, 10) },
    }));
  });
}

async function _saveSunPhase(camId, phase, partial){
  const cam = (state.cameras || []).find(c => c.id === camId);
  if (!cam) return;
  // Phase block is a 1-level merge by default. The daynight_override
  // sub-object needs an explicit 2nd-level merge so toggling `enabled`
  // doesn't wipe `lead_min` (and vice versa).
  const prevPhase = (((cam.weather || {}).sun_timelapse || {})[phase] || {});
  const mergedPhase = { ...prevPhase, ...partial };
  if (partial && partial.daynight_override){
    mergedPhase.daynight_override = {
      ...(prevPhase.daynight_override || {}),
      ...partial.daynight_override,
    };
  }
  const updated = { ...cam,
    weather: {
      ...(cam.weather || { enabled: false }),
      sun_timelapse: {
        ...((cam.weather && cam.weather.sun_timelapse) || {}),
        [phase]: mergedPhase,
      },
    },
  };
  const r = await _weatherPanelSave('/api/settings/cameras', updated);
  if (r && r.ok) {
    cam.weather = updated.weather;
    // Refresh the preview line for this camera by re-fetching sun-times.
    const st = await fetch('/api/weather/sun-times').then(x => x.json()).catch(() => null);
    if (st) state.weather._sunTimes = st;
    _renderWeatherCamList();
  }
}

// ── Event-Timelapse: per-camera Settings rows ─────────────────────────────────

const _EVENT_TL_TRIGGERS = ['thunder_rising', 'front_passing', 'storm_front'];

function _renderEventTLBlock(cam, sun){
  const evt = (cam.weather && cam.weather.event_timelapse) || {};
  const enabled = !!evt.enabled;
  const triggers = evt.triggers || {};
  const win = evt.window_min || 60;
  const trigChips = _EVENT_TL_TRIGGERS.map(t => {
    const meta = WEATHER_TYPES[t] || { de: t, color: '#94a3b8', icon: '' };
    const on = triggers[t] !== false;
    return `
      <div class="ws-evt-trigger-row" data-trig="${esc(t)}">
        <span class="ws-evt-trigger-chip" style="background:${meta.color}22;border:1px solid ${meta.color}55;color:${meta.color}">${meta.icon} ${esc(meta.de)}</span>
        <label class="switch ws-evt-trigger-toggle"><input type="checkbox" data-evt-trigger="${esc(t)}" ${on ? 'checked' : ''}/><span class="slider"></span></label>
      </div>`;
  }).join('');
  return `
    <div class="ws-evt-block" data-cam-evt="${esc(cam.id)}">
      <div class="ws-evt-head">
        <span class="ws-evt-icon">⛈</span>
        <span class="ws-evt-name">Ereignis-Timelapse</span>
        <label class="switch"><input type="checkbox" data-evt-master ${enabled ? 'checked' : ''}/><span class="slider"></span></label>
      </div>
      <div class="ws-evt-body" ${enabled ? '' : 'hidden'}>
        <div class="ws-evt-window-row">
          <span class="ws-evt-window-label">Fenster</span>
          <input type="range" class="ws-evt-window-slider" min="30" max="120" step="15" value="${win}" data-evt-window/>
          <span class="ws-evt-window-val"><span class="ws-evt-window-num">${win}</span> min</span>
        </div>
        ${trigChips}
        <div class="ws-evt-hint">Maximal 2 Ereignis-Timelapses pro Kamera und Tag · 4 h Cooldown nach jedem Trigger.</div>
      </div>
    </div>`;
}

async function _saveEventTL(camId, partial){
  const cam = (state.cameras || []).find(c => c.id === camId);
  if (!cam) return;
  // Deep-merge `partial` (e.g. {triggers:{thunder_rising:true}}) into the
  // current event_timelapse block so a single toggle save doesn't wipe
  // sibling fields.
  const cur = (cam.weather && cam.weather.event_timelapse) || {};
  const merged = { ...cur, ...partial };
  if (partial.triggers) merged.triggers = { ...(cur.triggers || {}), ...partial.triggers };
  const updated = { ...cam,
    weather: {
      ...(cam.weather || { enabled: false }),
      event_timelapse: merged,
    },
  };
  const r = await _weatherPanelSave('/api/settings/cameras', updated);
  if (r && r.ok) {
    cam.weather = updated.weather;
    _renderWeatherCamList();
  }
}

// Wire event-tl handlers via the existing weatherCamList delegated listener
// added in Phase Sun-TL.
document.addEventListener('change', (e) => {
  const block = e.target.closest('.ws-evt-block'); if (!block) return;
  const camId = block.dataset.camEvt;
  if (e.target.matches('[data-evt-master]')) {
    _saveEventTL(camId, { enabled: !!e.target.checked });
    return;
  }
  if (e.target.matches('[data-evt-trigger]')) {
    const trig = e.target.dataset.evtTrigger;
    _saveEventTL(camId, { triggers: { [trig]: !!e.target.checked } });
    return;
  }
});
document.addEventListener('input', (e) => {
  if (!e.target.matches('[data-evt-window]')) return;
  const block = e.target.closest('.ws-evt-block'); if (!block) return;
  const numEl = block.querySelector('.ws-evt-window-num');
  if (numEl) numEl.textContent = e.target.value;
});
document.addEventListener('change', (e) => {
  if (!e.target.matches('[data-evt-window]')) return;
  const block = e.target.closest('.ws-evt-block'); if (!block) return;
  const camId = block.dataset.camEvt;
  _saveEventTL(camId, { window_min: parseInt(e.target.value, 10) });
});

function _renderWeatherEventsList(events){
  const wrap = byId('weatherEventsList'); if (!wrap) return;
  // Sun-Timelapse types are configured in the per-camera section below;
  // they don't have a single global threshold to slide, so skip them in
  // this list to avoid an undefined-`hint` crash.
  const tunable = Object.keys(WEATHER_TYPES).filter(t => WEATHER_THRESHOLD_HINTS[t]);
  wrap.innerHTML = tunable.map(t => {
    const meta = WEATHER_TYPES[t];
    const cfg = events[t] || {};
    const hint = WEATHER_THRESHOLD_HINTS[t];
    const v = cfg[hint.key] != null ? Number(cfg[hint.key]) : (hint.min + (hint.max - hint.min) / 2);
    return `
      <div class="ws-event-row" data-event="${esc(t)}">
        <span class="ws-event-chip" style="background:${meta.color}22;border:1px solid ${meta.color}55;color:${meta.color}">${meta.icon} ${esc(meta.de)}</span>
        <label class="switch ws-event-toggle"><input type="checkbox" ${cfg.enabled !== false ? 'checked' : ''} data-ws-event-toggle/><span class="slider"></span></label>
        <input type="range" class="ws-event-slider" min="${hint.min}" max="${hint.max}" step="${hint.step}" value="${v}" data-ws-event-slider/>
        <span class="ws-event-val"><span class="ws-event-num">${v}</span> ${esc(hint.unit)}</span>
      </div>`;
  }).join('');
}

// ── Weather location map (Leaflet) ──────────────────────────────────────────
// Lazy singleton — Leaflet can only render once its container is visible, so
// init is deferred until the Standort tab is opened. Subsequent opens just
// invalidateSize() so the tile grid refits the (possibly resized) container.
let _wsMap = null;
let _wsMarker = null;
let _wsSyncing = false;        // suppresses input handlers while we write
                               // values from the map back into the inputs
let _wsLocSaveTimer = null;

function _wsPinIcon(){
  // Flat-design teardrop pin in storm-blue. 32×42 visual on a 44×44 hit area
  // so the touch target hits the project's iOS minimum.
  const svg = '<svg viewBox="0 0 32 44" width="32" height="42" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M16 2C9.4 2 4 7.4 4 14c0 9 12 26 12 26s12-17 12-26c0-6.6-5.4-12-12-12z" '
    + 'fill="rgb(127,174,201)" stroke="rgba(0,0,0,.35)" stroke-width="1"/>'
    + '<circle cx="16" cy="14" r="4.5" fill="#fff"/></svg>';
  return L.divIcon({
    className: 'ws-map-pin-wrap',
    html: '<div class="ws-map-pin-hit">' + svg + '</div>',
    iconSize: [44, 44],
    iconAnchor: [22, 42],
  });
}

function _initWeatherMap(){
  const el = byId('weatherMap');
  if (!el) return;
  if (typeof L === 'undefined') return; // Leaflet CDN unreachable — fail silent
  if (_wsMap) { _wsMap.invalidateSize(); return; }
  const lat = parseFloat(byId('ws_lat').value);
  const lon = parseFloat(byId('ws_lon').value);
  const hasLoc = Number.isFinite(lat) && Number.isFinite(lon);
  _wsMap = L.map(el, {
    center: hasLoc ? [lat, lon] : [51.16, 10.45],
    zoom:   hasLoc ? 15 : 5,
    scrollWheelZoom: true,
  });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
  }).addTo(_wsMap);
  if (hasLoc) _setWeatherMapMarker(lat, lon, false);
  _wsMap.on('click', (e) => {
    _setWeatherMapMarker(e.latlng.lat, e.latlng.lng, false);
    _wsWriteInputsFromMap(e.latlng.lat, e.latlng.lng);
    _saveWeatherLocation();
  });
  // Container was hidden when init started in some flows — ensure tile grid
  // matches the visible size on the next paint.
  setTimeout(() => { if (_wsMap) _wsMap.invalidateSize(); }, 60);
}

function _setWeatherMapMarker(lat, lon, panTo){
  if (!_wsMap) return;
  const ll = [lat, lon];
  if (!_wsMarker) {
    _wsMarker = L.marker(ll, { draggable: true, icon: _wsPinIcon() }).addTo(_wsMap);
    _wsMarker.on('dragend', (ev) => {
      const p = ev.target.getLatLng();
      _wsWriteInputsFromMap(p.lat, p.lng);
      _saveWeatherLocation();
    });
  } else {
    _wsMarker.setLatLng(ll);
  }
  if (panTo) _wsMap.setView(ll, Math.max(_wsMap.getZoom(), 13));
}

function _wsWriteInputsFromMap(lat, lon){
  _wsSyncing = true;
  const elLat = byId('ws_lat'); if (elLat) elLat.value = lat.toFixed(6);
  const elLon = byId('ws_lon'); if (elLon) elLon.value = lon.toFixed(6);
  _wsSyncing = false;
}

async function _saveWeatherLocation(){
  const lat = parseFloat(byId('ws_lat').value);
  const lon = parseFloat(byId('ws_lon').value);
  const elevRaw = byId('ws_elev').value;
  const elev = elevRaw === '' ? null : parseFloat(elevRaw);
  const partial = { server: { location: {
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    elevation: Number.isFinite(elev) ? elev : null,
  } } };
  const r = await _weatherPanelSave('/api/settings/app', partial);
  if (r && r.ok) {
    state.config.server = state.config.server || {};
    state.config.server.location = partial.server.location;
    if (Number.isFinite(lat) && Number.isFinite(lon) && elevRaw === '') {
      _wsAutoFetchElevation(lat, lon);
    }
  }
}

async function _wsAutoFetchElevation(lat, lon){
  // Open-Meteo /v1/elevation: free, no key, returns {elevation:[<m>]}.
  // Silent failure — manual elev entry stays the user's fallback.
  try {
    const r = await fetch('https://api.open-meteo.com/v1/elevation?latitude=' + lat + '&longitude=' + lon);
    if (!r.ok) return;
    const d = await r.json();
    const m = Array.isArray(d.elevation) ? d.elevation[0] : null;
    if (m == null || !Number.isFinite(m)) return;
    const elv = byId('ws_elev');
    if (!elv || elv.value !== '') return; // user filled it in meanwhile
    _wsSyncing = true;
    elv.value = Math.round(m);
    _wsSyncing = false;
    _saveWeatherLocation();
  } catch (_) { /* silent */ }
}

function _bindWsLocationInputs(){
  // Debounced input handler: pans the map and saves once typing settles.
  // The dataset guard makes re-binding (re-hydrate) a no-op.
  for (const id of ['ws_lat', 'ws_lon', 'ws_elev']) {
    const el = byId(id);
    if (!el || el.dataset.wsBound === '1') continue;
    el.dataset.wsBound = '1';
    el.addEventListener('input', () => {
      if (_wsSyncing) return;
      clearTimeout(_wsLocSaveTimer);
      _wsLocSaveTimer = setTimeout(() => {
        const lat = parseFloat(byId('ws_lat').value);
        const lon = parseFloat(byId('ws_lon').value);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          _setWeatherMapMarker(lat, lon, true);
        }
        _saveWeatherLocation();
      }, 400);
    });
  }
}

function _bindWeatherHandlers(){
  byId('ws_enabled')?.addEventListener('change', (e) => {
    _saveWeatherCfg({ enabled: e.target.checked });
    const badge = byId('weatherStatusBadge');
    if (badge) {
      badge.textContent = e.target.checked ? 'aktiv' : 'aus';
      badge.className = 'set-status-badge ' + (e.target.checked ? 'set-status-badge--on' : 'set-status-badge--off');
    }
  });
  _bindWsLocationInputs();
  // Per-camera toggles — read full cam dict from state.cameras, mutate
  // weather.enabled, POST whole dict back. upsert_camera fills defaults
  // for missing fields, so a partial post would stomp valid data.
  byId('weatherCamList')?.addEventListener('change', async (e) => {
    const cb = e.target.closest('input[data-ws-cam]'); if (!cb) return;
    const camId = cb.dataset.wsCam;
    const cam = (state.cameras || []).find(c => c.id === camId);
    if (!cam) return;
    const updated = { ...cam, weather: { ...(cam.weather || {}), enabled: !!cb.checked } };
    const r = await _weatherPanelSave('/api/settings/cameras', updated);
    if (r && r.ok) {
      cam.weather = updated.weather;
      // Re-render so the sun-timelapse rows reveal/collapse with the
      // master toggle (sun rows live inside .ws-sun-rows[hidden]).
      _renderWeatherCamList();
    }
  });
  byId('weatherEventsList')?.addEventListener('change', (e) => {
    const row = e.target.closest('.ws-event-row'); if (!row) return;
    const evt = row.dataset.event;
    if (e.target.matches('[data-ws-event-toggle]')) {
      _saveWeatherCfg({ events: { [evt]: { enabled: !!e.target.checked } } });
    }
  });
  byId('weatherEventsList')?.addEventListener('input', (e) => {
    if (!e.target.matches('[data-ws-event-slider]')) return;
    const row = e.target.closest('.ws-event-row');
    const evt = row.dataset.event;
    const hint = WEATHER_THRESHOLD_HINTS[evt];
    const v = parseFloat(e.target.value) || 0;
    row.querySelector('.ws-event-num').textContent = v;
    _debouncedWeatherSave({ events: { [evt]: { [hint.key]: v } } });
  });
}

let _wsStatusTimer = null;
async function _refreshWeatherStatus(){
  const wrap = byId('weatherStatusPanel'); if (!wrap) return;
  try {
    const r = await fetch('/api/weather/status');
    const d = await r.json();
    const ago = d.last_poll_at
      ? Math.max(0, Math.round((Date.now() - new Date(d.last_poll_at).getTime()) / 1000))
      : null;
    const stateRows = Object.entries(d.current_state || {})
      .map(([k, v]) => {
        const meta = WEATHER_TYPES[k] || { de: k, color: '#94a3b8' };
        return `<span class="ws-status-pill" style="--cb:${meta.color};opacity:${v ? 1 : 0.45}">${meta.icon} ${esc(meta.de)} ${v ? '·  aktiv' : ''}</span>`;
      }).join('');
    wrap.innerHTML = `
      <div class="field-help">Aktualisiert sich alle 15 Sekunden.</div>
      <div class="ws-status-row"><span class="ws-status-key">Letzter Poll</span><span class="ws-status-val">${ago == null ? '— noch nie —' : 'vor ' + ago + ' s'}</span></div>
      <div class="ws-status-row"><span class="ws-status-key">API-Antwort</span><span class="ws-status-val">${d.last_api_ok === true ? '🟢 OK' : d.last_api_ok === false ? '🔴 Fehler' : '— noch nie —'}</span></div>
      <div class="ws-status-row"><span class="ws-status-key">Standort</span><span class="ws-status-val">${d.location?.lat != null ? `${d.location.lat}, ${d.location.lon}` : '— nicht gesetzt —'}</span></div>
      <div class="ws-status-row" style="flex-direction:column;align-items:flex-start;gap:6px"><span class="ws-status-key">Aktuelle Trigger</span><div style="display:flex;flex-wrap:wrap;gap:6px">${stateRows}</div></div>
    `;
  } catch (e) {
    wrap.innerHTML = '<div class="field-help">Status nicht erreichbar.</div>';
  }
  clearTimeout(_wsStatusTimer);
  _wsStatusTimer = setTimeout(_refreshWeatherStatus, 15000);
}


// ── Wetter-Ereignisse Phase 3: Recaps + push UI + hash anchor ───────────────

async function loadWeatherRecaps(){
  try{
    const r = await fetch('/api/weather/recaps');
    const d = await r.json();
    state.weather.recaps = d.items || [];
    _renderWeatherRecaps();
  }catch(e){ /* silent */ }
}

function _renderWeatherRecaps(){
  const row = byId('weatherRecapsRow');
  const strip = byId('weatherRecapsStrip');
  if (!row || !strip) return;
  const items = state.weather.recaps || [];
  if (!items.length) { row.hidden = true; strip.innerHTML = ''; return; }
  row.hidden = false;
  strip.innerHTML = items.map((m, idx) => {
    const dur = parseInt(m.duration_s || 0, 10);
    const mm = Math.floor(dur / 60), ss = dur % 60;
    const durLbl = `${mm}:${ss.toString().padStart(2, '0')} min`;
    return `
      <div class="ws-recap-card" data-idx="${idx}" data-id="${esc(m.id)}">
        <div class="ws-recap-card-period">${esc(m.period_label || m.id)}</div>
        <div class="ws-recap-card-meta">${m.n_clips || 0} Clips · ${esc(durLbl)}</div>
        <span class="ws-recap-card-play">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
        </span>
      </div>`;
  }).join('');
  strip.querySelectorAll('.ws-recap-card').forEach(card => {
    card.addEventListener('click', () => openWeatherRecapLightbox(parseInt(card.dataset.idx, 10)));
  });
}

function openWeatherRecapLightbox(idx){
  // Reuse the wsLightbox shell built by Phase 2 — swap the video src and
  // metadata, no separate DOM. The Prev/Next nav stays disabled because
  // recaps don't form an ordered series across the year.
  const items = state.weather.recaps || [];
  if (idx < 0 || idx >= items.length) return;
  const m = items[idx];
  // Lazily build the modal if it doesn't exist yet (mirrors openWeatherLightbox).
  let modal = byId('wsLightbox');
  if (!modal) {
    // Trigger Phase-2 lightbox creation once via a no-op open that closes
    // immediately — it builds the shell, which we then reuse here.
    if ((state.weather.items || []).length) {
      openWeatherLightbox(0);
      closeWeatherLightbox();
      modal = byId('wsLightbox');
    }
    if (!modal) {
      // Cold start with no sightings yet — build a minimal shell inline.
      modal = document.createElement('div');
      modal.id = 'wsLightbox';
      modal.className = 'ws-lb';
      modal.innerHTML = `
        <div class="ws-lb-backdrop" data-action="close"></div>
        <div class="ws-lb-shell">
          <button class="ws-lb-close" data-action="close" aria-label="Schließen">✕</button>
          <div class="ws-lb-video-wrap"><video id="wsLbVideo" controls playsinline autoplay muted loop preload="metadata"></video></div>
          <div class="ws-lb-meta" id="wsLbMeta"></div>
          <div class="ws-lb-actions"></div>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="close"]')) closeWeatherLightbox();
      });
      document.addEventListener('keydown', (e) => {
        if (modal.classList.contains('open') && e.key === 'Escape') closeWeatherLightbox();
      });
    }
  }
  const video = byId('wsLbVideo');
  video.src = `/api/weather/recaps/${encodeURIComponent(m.id)}/clip`;
  video.load(); video.play().catch(() => {});
  byId('wsLbMeta').innerHTML = `
    <div class="ws-lb-headline">
      <span class="ws-lb-type-badge" style="background:#7faec933;border:1px solid #7faec966;color:#7faec9">🎞 ${esc(m.period_label || m.id)}</span>
      <span class="ws-lb-date">${esc(m.built_at || '')}</span>
    </div>
    <div class="ws-lb-cam">${m.n_clips || 0} Sichtungen · Zeitraum ${esc(m.period_start || '')} → ${esc(m.period_end || '')}</div>
  `;
  // Hide nav arrows (recaps don't form a navigable series here).
  const prev = modal.querySelector('.ws-lb-prev');
  const next = modal.querySelector('.ws-lb-next');
  if (prev) prev.style.display = 'none';
  if (next) next.style.display = 'none';
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
}

// ── Push Weather settings (extends the Telegram "Was senden" tab) ───────────

const _PUSH_WEATHER_ORDER = ['thunder', 'heavy_rain', 'snow', 'fog', 'sunset'];

function _renderPushWeatherEvents(weatherCfg){
  const wrap = byId('pushWeatherEventsList'); if (!wrap) return;
  const events = (weatherCfg && weatherCfg.events) || {};
  wrap.innerHTML = _PUSH_WEATHER_ORDER.map(t => {
    const meta = (typeof WEATHER_TYPES === 'object' && WEATHER_TYPES[t]) || { de: t, color: '#94a3b8', icon: '' };
    const on = events[t] !== undefined ? !!events[t] : false;
    return `
      <div class="push-label-row" data-weather-evt="${esc(t)}">
        <span class="push-label-chip" style="background:${meta.color}22;border:1px solid ${meta.color}55;color:${meta.color}">${meta.icon} ${esc(meta.de)}</span>
        <label class="switch push-label-toggle"><input type="checkbox" ${on ? 'checked' : ''} data-weather-event-toggle/><span class="slider"></span></label>
        <span></span>
        <span></span>
      </div>`;
  }).join('');
}

function _hydratePushWeather(){
  const w = ((state.config?.telegram?.push) || {}).weather || {};
  const en = byId('push_weather_enabled'); if (en) en.checked = !!w.enabled;
  const recap = byId('push_weather_recap'); if (recap) recap.checked = w.recap_push !== false;
  const sl = byId('push_weather_min_score');
  const lbl = byId('push_weather_min_score_pct');
  const v = w.min_score != null ? Number(w.min_score) : 0.4;
  if (sl) sl.value = v;
  if (lbl) lbl.textContent = Math.round(v * 100) + '%';
  _renderPushWeatherEvents(w);
}

function _bindPushWeatherHandlers(){
  byId('push_weather_enabled')?.addEventListener('change', e =>
    savePushCfg({ weather: { enabled: e.target.checked } }));
  byId('push_weather_recap')?.addEventListener('change', e =>
    savePushCfg({ weather: { recap_push: e.target.checked } }));
  byId('push_weather_min_score')?.addEventListener('input', e => {
    const v = parseFloat(e.target.value) || 0;
    const lbl = byId('push_weather_min_score_pct');
    if (lbl) lbl.textContent = Math.round(v * 100) + '%';
    _debouncedPushSave({ weather: { min_score: v } });
  });
  byId('pushWeatherEventsList')?.addEventListener('change', e => {
    const row = e.target.closest('.push-label-row[data-weather-evt]'); if (!row) return;
    if (!e.target.matches('[data-weather-event-toggle]')) return;
    const evt = row.dataset.weatherEvt;
    savePushCfg({ weather: { events: { [evt]: !!e.target.checked } } });
  });
}

// ── Hash anchor handler — open lightbox for #weather/<id> on page load ──────

function _handleWeatherHashAnchor(){
  const h = window.location.hash || '';
  // Scroll to the new top-level #weather section (was a sub-block of
  // #achievements before the Sichtungen↔Wetter split). Falls back to the
  // inner block id for back-compat with any cached deep links.
  const target = byId('weather') || byId('weatherSightingsBlock');
  if (h === '#weather') {
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (typeof _setActiveNav === 'function') _setActiveNav('weather');
    return;
  }
  if (!h.startsWith('#weather/')) return;
  const id = decodeURIComponent(h.slice('#weather/'.length));
  const items = state.weather.items || [];
  const idx = items.findIndex(s => s.id === id);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (typeof _setActiveNav === 'function') _setActiveNav('weather');
  if (idx >= 0 && typeof openWeatherLightbox === 'function') {
    setTimeout(() => openWeatherLightbox(idx), 350);
  }
}

// Wire the Phase 3 additions: extend renderer, init, and event hooks.
const _origRenderWeatherSightings = renderWeatherSightings;
renderWeatherSightings = function(){
  _origRenderWeatherSightings();
  _renderWeatherRecaps();
};
const _origLoadWeatherSightings = loadWeatherSightings;
loadWeatherSightings = async function(filter){
  await _origLoadWeatherSightings(filter);
  await loadWeatherRecaps();
};
const _origHydratePushUI = hydratePushUI;
hydratePushUI = function(){
  _origHydratePushUI();
  _hydratePushWeather();
  _bindPushWeatherHandlers();
};
window.addEventListener('hashchange', _handleWeatherHashAnchor);
// Fire once after the initial loadAll() completes.
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(_handleWeatherHashAnchor, 1200);
});

// ── Telegram deep-link router ──────────────────────────────────────────────
// URLs from Telegram bubbles look like
//   <public_base_url>/#/event/<event_id>
//   <public_base_url>/#/sighting/<sighting_id>
//   <public_base_url>/#/recap/<recap_id>
// On match, switch to the right section, ensure the relevant data is loaded,
// then open the corresponding lightbox at that item. After opening we
// rewrite the hash to a non-routable anchor (#media / #weather) so a page
// reload doesn't replay the animation.
function _showRouterToast(msg){
  let el=document.getElementById('_routerToast');
  if(!el){
    el=document.createElement('div');
    el.id='_routerToast';
    el.style.cssText='position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:1500;background:rgba(15,24,37,.96);color:#e2e8f0;padding:10px 16px;border-radius:12px;font-size:13px;font-weight:600;box-shadow:0 10px 30px rgba(0,0,0,.45);opacity:0;transition:opacity .2s ease;pointer-events:none;max-width:88vw;text-align:center';
    document.body.appendChild(el);
  }
  el.textContent=msg;
  el.style.opacity='1';
  clearTimeout(el._t);
  el._t=setTimeout(()=>{el.style.opacity='0';},3500);
}

async function _openLightboxByEventId(eventId){
  // Try in-memory first — fast path when the user is already on Mediathek.
  const all=state._allMedia||[];
  let item=all.find(x=>x.event_id===eventId);
  if(item){ openLightbox(item); return true; }
  // Resolve cam + event metadata via the cross-camera API.
  let meta=null;
  try{ meta=await j(`/api/event/${encodeURIComponent(eventId)}`); }catch{}
  if(!meta||!meta.camera_id){
    _showRouterToast('Ereignis nicht gefunden — vielleicht wurde es gelöscht?');
    return false;
  }
  // Switch to the cam's media drilldown, load the events for that cam,
  // then re-search _allMedia and open.
  state.mediaCamera=meta.camera_id;
  if(meta.top_label) state.mediaLabels=new Set([meta.top_label]);
  document.querySelector('#media')?.scrollIntoView({behavior:'auto',block:'start'});
  try{ await loadMedia(); renderMediaGrid(); renderMediaPagination?.(); }catch{}
  item=(state._allMedia||[]).find(x=>x.event_id===eventId);
  if(item){ openLightbox(item); return true; }
  _showRouterToast('Ereignis nicht gefunden — vielleicht wurde es gelöscht?');
  return false;
}

async function _openSightingById(sightingId){
  // Make sure the weather section is loaded.
  if(!state.weather||!state.weather.items||state.weather.items.length===0){
    try{ await loadWeatherSightings?.(); }catch{}
  }
  const items=state.weather?.items||[];
  const idx=items.findIndex(s=>s.id===sightingId);
  document.querySelector('#weather')?.scrollIntoView({behavior:'auto',block:'start'});
  if(idx>=0&&typeof openWeatherLightbox==='function'){
    openWeatherLightbox(idx);
    return true;
  }
  _showRouterToast('Sichtung nicht gefunden.');
  return false;
}

async function _openRecapById(recapId){
  // Recaps live alongside sightings — load + open via the existing hook.
  if(!state.weather?.recaps||state.weather.recaps.length===0){
    try{ await loadWeatherRecaps?.(); }catch{}
  }
  const items=state.weather?.recaps||[];
  const idx=items.findIndex(r=>r.id===recapId);
  document.querySelector('#weather')?.scrollIntoView({behavior:'auto',block:'start'});
  if(idx>=0&&typeof openWeatherRecap==='function'){
    openWeatherRecap(items[idx],idx);
    return true;
  }
  // Fallback — best effort: scroll to the recaps strip.
  document.querySelector('#weatherRecapsStrip')?.scrollIntoView({behavior:'smooth',block:'center'});
  return false;
}

async function _routeFromHash(){
  const h=location.hash||'';
  let m;
  if((m=h.match(/^#\/event\/([^/]+)$/))){
    const eid=decodeURIComponent(m[1]);
    const ok=await _openLightboxByEventId(eid);
    if(ok){ try{ history.replaceState(null,'','#media'); }catch{} }
  } else if((m=h.match(/^#\/sighting\/([^/]+)$/))){
    const sid=decodeURIComponent(m[1]);
    const ok=await _openSightingById(sid);
    if(ok){ try{ history.replaceState(null,'','#weather'); }catch{} }
  } else if((m=h.match(/^#\/recap\/([^/]+)$/))){
    const rid=decodeURIComponent(m[1]);
    const ok=await _openRecapById(rid);
    if(ok){ try{ history.replaceState(null,'','#weather'); }catch{} }
  }
}
window.addEventListener('hashchange',_routeFromHash);
window.addEventListener('load',()=>{ setTimeout(_routeFromHash,1500); });

// ─── Module-bridge exports (stage-1 of the ES-modules refactor) ────────────
// As a regular <script> top-level function declarations attached themselves
// to window automatically, which is how the inline onclick handlers in
// templates and innerHTML strings find their callbacks. As a module we
// lose that implicit bridge — these explicit assignments restore the
// names the inline handlers reference. The 70-or-so explicit window.X = X
// statements scattered through this file already covered most callbacks;
// the names below were the gaps the static-grep audit surfaced.
//
// Future per-domain modules will move each function out of this legacy
// file into js/<domain>.js with its own export-to-window line at the
// module's bottom; this block shrinks accordingly.
window._goToPage          = _goToPage;
window._setLiveViewStream = _setLiveViewStream;
window._statOpenMedia     = _statOpenMedia;
window.byId               = byId;
window.closeMediaDrilldown = closeMediaDrilldown;
window.openMediaDrilldown = openMediaDrilldown;
window._openMediaItem     = _openMediaItem;
