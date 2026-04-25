
const state={config:null,cameras:[],timeline:null,media:[],_allMedia:[],camera:'',label:'',period:'week',bootstrap:null,mediaCamera:null,mediaStats:[],mediaLabels:new Set(),mediaPeriod:'week',tlHours:168,mediaPage:0,mediaTotalPages:1,_tlInitialized:false};
let _hmTip=null; // fixed-position heatmap tooltip, bypasses overflow-x:auto clipping
const STAT_MEDIA_DRILLDOWN=true;

// ── Toast & Confirm helpers ───────────────────────────────────────────────────
window.showToast=function(msg,type='info'){
  const c=byId('toastContainer'); if(!c) return;
  const t=document.createElement('div');
  t.className=`toast ${type}`;
  const icons={warn:'⚠️',error:'✕',success:'✓',info:'ℹ'};
  t.innerHTML=`<span class="toast-icon">${icons[type]||'ℹ'}</span><span class="toast-msg">${esc(msg)}</span><button class="toast-close" onclick="this.closest('.toast').remove()">✕</button>`;
  c.appendChild(t);
  const dismiss=()=>{ t.classList.add('toast-out'); t.addEventListener('animationend',()=>t.remove(),{once:true}); };
  setTimeout(dismiss, type==='error'?8000:type==='warn'||type==='info'?6000:4000);
};

let _confirmResolve=null;
window.showConfirm=function(msg){
  return new Promise(resolve=>{
    _confirmResolve=resolve;
    const modal=byId('confirmModal');
    const msgEl=byId('confirmMsg');
    if(!modal||!msgEl){resolve(false);return;}
    msgEl.textContent=msg;
    modal.classList.remove('hidden');
    document.body.style.overflow='hidden';
  });
};
function _resolveConfirm(val){
  const modal=byId('confirmModal');
  if(modal){modal.classList.add('hidden');document.body.style.overflow='';}
  if(_confirmResolve){_confirmResolve(val);_confirmResolve=null;}
}
// Wire confirm buttons after DOM ready (done at bottom of file)
const colors={person:'#facc15',cat:'#fb923c',bird:'#38bdf8',car:'#f87171',motion:'#cbd5e1',alarm:'#ef4444',unknown:'#4a6477',timelapse:'#a855f7',motion_objects:'#c084fc',coral:'#f472b6',object:'#f472b6',notification:'#5bc8f5',dog:'#7c2d12'};
const OBJ_LABEL={person:'Person',cat:'Katze',bird:'Vogel',car:'Auto',dog:'Hund',motion:'Bewegung',alarm:'Alarm',timelapse:'Timelapse',motion_objects:'Objekt · Motion',object:'Objekt',notification:'Benachrichtigung'};
const OBJ_SVG={
  // Person: head circle + body arc — bright yellow silhouette
  person:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="7" r="4.5" fill="#facc15"/><path d="M4 22c0-4.4 3.6-8 8-8s8 3.6 8 8" stroke="#facc15" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>`,
  // Cat: round face with ear triangles and dot eyes — orange
  cat:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><polygon points="5,11 2,4 9.5,9" fill="#fb923c"/><polygon points="19,11 22,4 14.5,9" fill="#fb923c"/><circle cx="12" cy="15" r="7" fill="#fb923c"/><circle cx="9" cy="14.5" r="1.6" fill="#fff" opacity=".9"/><circle cx="15" cy="14.5" r="1.6" fill="#fff" opacity=".9"/><circle cx="9" cy="14.5" r=".7" fill="#7c2d12"/><circle cx="15" cy="14.5" r=".7" fill="#7c2d12"/><path d="M10 18q2 1.5 4 0" stroke="#fff" stroke-width="1.2" stroke-linecap="round" fill="none" opacity=".75"/></svg>`,
  // Bird: spread wings + oval body + round head — sky blue
  bird:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M2 12C5.5 7 9.5 9 12 13C14.5 9 18.5 7 22 12" fill="#38bdf8"/><ellipse cx="12" cy="15.5" rx="3.5" ry="2.5" fill="#38bdf8"/><circle cx="17.5" cy="10.5" r="2" fill="#38bdf8"/><circle cx="18.5" cy="10" r=".85" fill="#fff" opacity=".9"/><path d="M12 18v3" stroke="#38bdf8" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  // Car: coral-red body with lighter salmon highlights — reads as warning/vehicle
  car:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="2" y="11" width="20" height="8" rx="2.5" fill="#f87171"/><rect x="6" y="7" width="11" height="5" rx="2" fill="#fca5a5"/><circle cx="7" cy="20" r="2.5" fill="#1e293b"/><circle cx="17" cy="20" r="2.5" fill="#1e293b"/><circle cx="7" cy="20" r="1.2" fill="#7f1d1d"/><circle cx="17" cy="20" r="1.2" fill="#7f1d1d"/><rect x="14.5" y="8" width="3" height="3.5" rx=".75" fill="rgba(255,255,255,.35)"/></svg>`,
  // Motion: horizontal sine wave — wind-white
  motion:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M1 12 C4 5 7 5 9 12 C11 19 14 19 16 12 C18 5 21 5 23 12" stroke="#cbd5e1" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg>`,
  // Alarm: bell body + clapper dot + handle — red, classic bell shape
  alarm:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 3C7 3 4 7.5 4 12C4 17 7 19 7 19H17C17 19 20 17 20 12C20 7.5 17 3 12 3Z" fill="#ef4444"/><rect x="11" y="19" width="2" height="2.5" rx=".75" fill="#ef4444"/><rect x="9.5" y="21.5" width="5" height="1.5" rx=".75" fill="#ef4444"/><rect x="11.2" y="8" width="1.6" height="5.5" rx=".75" fill="#fff"/><circle cx="12" cy="15.5" r="1.1" fill="#fff"/></svg>`,
  // Timelapse: hourglass — vivid violet
  timelapse:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2" stroke-linecap="round"><line x1="6" y1="3" x2="18" y2="3"/><line x1="6" y1="21" x2="18" y2="21"/><polygon points="7,4 17,4 12,12" fill="#a855f7" opacity=".8"/><polygon points="12,12 7,20 17,20" fill="#a855f7" opacity=".5"/></svg>`,
  // Objekt · Motion combo: brain outline (pink) overlaid with a sine wave
  // (wind-white) and two purple-mix dots at the intersection points.
  motion_objects:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15A2.5 2.5 0 0 1 9.5 22a2.5 2.5 0 0 1-2.5-2.5V17a2.5 2.5 0 0 1-2-4.5 2.5 2.5 0 0 1 0-4A2.5 2.5 0 0 1 7 4.5 2.5 2.5 0 0 1 9.5 2z" fill="rgba(244,114,182,.22)" stroke="#f472b6" stroke-width="1.5" stroke-linejoin="round"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15A2.5 2.5 0 0 0 14.5 22a2.5 2.5 0 0 0 2.5-2.5V17a2.5 2.5 0 0 0 2-4.5 2.5 2.5 0 0 0 0-4A2.5 2.5 0 0 0 17 4.5 2.5 2.5 0 0 0 14.5 2z" fill="rgba(244,114,182,.22)" stroke="#f472b6" stroke-width="1.5" stroke-linejoin="round"/><path d="M1 12 C3 8 5.5 8 7 12 C8.5 16 11 16 12 12 C13 8 15.5 8 17 12 C18.5 16 21 16 23 12" stroke="#cbd5e1" stroke-width="1.6" stroke-linecap="round" fill="none" opacity=".95"/><circle cx="7" cy="12" r="1.1" fill="#c084fc"/><circle cx="17" cy="12" r="1.1" fill="#c084fc"/></svg>`,
  // Objekt (pink brain) — object-detection badge for media cards and pills
  object:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f472b6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15A2.5 2.5 0 0 1 9.5 22a2.5 2.5 0 0 1-2.5-2.5V17a2.5 2.5 0 0 1-2-4.5 2.5 2.5 0 0 1 0-4A2.5 2.5 0 0 1 7 4.5 2.5 2.5 0 0 1 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15A2.5 2.5 0 0 0 14.5 22a2.5 2.5 0 0 0 2.5-2.5V17a2.5 2.5 0 0 0 2-4.5 2.5 2.5 0 0 0 0-4A2.5 2.5 0 0 0 17 4.5 2.5 2.5 0 0 0 14.5 2z"/></svg>`,
  // Benachrichtigung: Telegram paper-plane (blue) with a small red bell
  // rotated ~18° in the upper right — one fused icon replacing Telegram+alarm.
  notification:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21.5 3L2.5 10.8 9.5 13 12 20 21.5 3z" fill="#229ED9" stroke="#229ED9" stroke-width="1" stroke-linejoin="round"/><path d="M9.5 13L21.5 3" stroke="rgba(255,255,255,.45)" stroke-width=".9" stroke-linecap="round"/><g transform="translate(14.5 1.5) rotate(18)"><path d="M5 0.5C3.3 0.5 2.2 2 2.2 3.8C2.2 5.6 3 6.3 3 6.3H7C7 6.3 7.8 5.6 7.8 3.8C7.8 2 6.7 0.5 5 0.5Z" fill="#ef4444"/><rect x="4.4" y="6.3" width="1.2" height="1.1" rx=".35" fill="#ef4444"/><rect x="3.8" y="7.4" width="2.4" height=".75" rx=".35" fill="#ef4444"/><circle cx="5" cy="4" r=".55" fill="#fff"/></g></svg>`,
  // Dog: flat paw print — main pad + four toe beans, dark brown (#7c2d12)
  dog:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M7 14.5C7 12 9.2 10.5 12 10.5C14.8 10.5 17 12 17 14.5C17 17 14.8 19.5 12 19.5C9.2 19.5 7 17 7 14.5Z" fill="#7c2d12"/><ellipse cx="6.5" cy="8.5" rx="1.7" ry="2.2" fill="#7c2d12"/><ellipse cx="17.5" cy="8.5" rx="1.7" ry="2.2" fill="#7c2d12"/><ellipse cx="9.5" cy="5" rx="1.5" ry="2" fill="#7c2d12"/><ellipse cx="14.5" cy="5" rx="1.5" ry="2" fill="#7c2d12"/></svg>`
};
function objBubble(label,size=22){
  const raw=OBJ_SVG[label]||OBJ_SVG.alarm;
  const svgPx=Math.round(size*0.70);
  const svg=raw.replace('width="16" height="16"',`width="${svgPx}" height="${svgPx}"`);
  const c=colors[label]||colors.unknown;
  const r=Math.max(6,Math.round(size*0.38));
  return `<span style="width:${size}px;height:${size}px;border-radius:${r}px;background:${c}40;border:1.5px solid ${c}80;backdrop-filter:blur(3px);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${svg}</span>`;
}
function objIconSvg(label,size=18){
  const raw=OBJ_SVG[label]||OBJ_SVG.alarm;
  return raw.replace('width="16" height="16"',`width="${size}" height="${size}"`);
}
const TL_LABELS=['person','cat','bird','car','dog','motion','alarm'];
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
function getCameraIcon(name){const n=(name||'').toLowerCase();if(/werkstatt|garage|keller|labor/.test(n))return'🔧';if(/eingang|tor|tür|door/.test(n))return'🚪';if(/garten|garden|außen|outdoor/.test(n))return'🌿';if(/eichhörnchen|squirrel|tier|animal|natur/.test(n))return'🐿️';if(/vogel|bird|futter|feeder/.test(n))return'🐦';if(/parkplatz|auto|car/.test(n))return'🚗';if(/pool|wasser|water/.test(n))return'💧';return'📷';}
const shapeState={mode:'zone',points:[],camera:null,zones:[],masks:[]};
const byId=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]));
const j=async(url,opt)=>{const r=await fetch(url,opt); if(!r.ok) throw new Error(await r.text()); return r.json();};

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

// ── Camera snapshot retry (handles 503 on initial load before stream is ready) ─
function _camImgRetry(img){
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

// ── Camera edit slide panel ───────────────────────────────────────────────────
let _currentEditCamId=null;
function _restoreEditWrapper(){
  const w=byId('cameraEditWrapper'); if(!w) return;
  w.classList.remove('slide-open');
  document.querySelectorAll('.cam-item.editing').forEach(el=>el.classList.remove('editing'));
  const sec=byId('cameras'); if(sec&&w.parentElement!==sec) sec.appendChild(w);
  _currentEditCamId=null;
}
function _closeEditPanel(){
  if(!_currentEditCamId) return;
  const w=byId('cameraEditWrapper');
  w?.classList.remove('slide-open');
  document.querySelectorAll('.cam-item.editing').forEach(el=>el.classList.remove('editing'));
  setTimeout(()=>{ const sec=byId('cameras'); if(sec) sec.appendChild(w); },400);
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
    }catch{/* silent */}
  },3000);
  ['liveIndicator'].forEach(id=>{const el=byId(id);if(el)el.classList.remove('hidden');});
}

async function loadAll(){
  _restoreEditWrapper();
  state.bootstrap=await j('/api/bootstrap');
  state.config=await j('/api/config');
  state.cameras=(await j('/api/cameras')).cameras||[];
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
  loadTlStatus();
  _updateTlActiveTags(state.cameras||[]);
  if(state.bootstrap.needs_wizard) openWizard();
  byId('openWizardBtn').classList.toggle('hidden', !!state.bootstrap?.wizard_completed || !state.bootstrap?.needs_wizard);
  startPreviewRefresh(); // 5fps thumbnail refresh for dashboard cards
}

function _mediaPeriodParams(){
  const p=state.mediaPeriod||'week';
  const now=new Date();
  const today=now.toISOString().slice(0,10);
  const end=today+'T23:59:59';
  let start;
  if(p==='day') start=today+'T00:00:00';
  else if(p==='month'){const d=new Date(now);d.setDate(d.getDate()-30);start=d.toISOString().slice(0,10)+'T00:00:00';}
  else{const d=new Date(now);d.setDate(d.getDate()-7);start=d.toISOString().slice(0,10)+'T00:00:00';}
  return `&start=${start}&end=${end}`;
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
function updateAvailableLabelPills(){
  const available=new Set((state._allMedia||[]).flatMap(item=>item.labels||[]));
  document.querySelectorAll('.media-pill[data-type="label"]').forEach(p=>{
    const val=p.dataset.val;
    if(!val) return;  // "Alle" (empty val) always visible
    p.style.display=available.has(val)?'':'none';
  });
  return available;
}
let _cachedPageSize=0;
async function loadMedia(){
  const labels=state.mediaLabels;
  const ps=calcItemsPerPage(); _cachedPageSize=ps;
  const cams=state.mediaCamera?[state.mediaCamera]:state.cameras.map(c=>c.id);
  const periodParams=_mediaPeriodParams();
  // Unified filter — EventStore now holds both motion and timelapse events.
  const allLabels=[...labels];
  const labelParam=allLabels.length===1?`&label=${encodeURIComponent(allLabels[0])}`
    :allLabels.length>1?`&labels=${encodeURIComponent(allLabels.join(','))}`:'';
  // Fetch ALL matching items from every camera in one pass (no server-side offset).
  // Pagination is done client-side on the merged+sorted list so that multi-camera
  // views produce a consistent global order and every page is fully filled.
  const allItems=[];
  for(const camId of cams){
    const data=await j(`/api/camera/${camId}/media?limit=9999&offset=0${labelParam}${periodParams}`);
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
  byId('appName').textContent=state.config.app.name||'TAM-spy';
  const _sideAppName=byId('sideAppName'); if(_sideAppName) _sideAppName.textContent=state.config.app.name||'TAM-spy';
  const tb=byId('topbarTitle'); if(tb) tb.textContent=state.config.app.name||'TAM-spy';
  byId('appTagline').textContent=state.config.app.tagline||'Motion · Objekte · Timelapse';
  const subEl=byId('appSubtitle');
  if(subEl) subEl.textContent=state.config.app.subtitle||'RTSP-Streams · KI-Erkennung · Vogelarten · Telegram-Alerts';
}

function _camGridCols(n){
  if(n<=1) return 'cam-grid-1';
  if(n<=2) return 'cam-grid-2';
  if(n<=4) return 'cam-grid-4';
  return 'cam-grid-n';
}

function renderDashboard(){
  const cams=state.cameras;
  const gridCls=_camGridCols(cams.length);
  byId('cameraCards').className=`camera-grid ${gridCls}`;
  // shared SVGs
  const pencil=`<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>`;
  byId('cameraCards').innerHTML=cams.map(c=>{
    const hdOn=_hdCards.has(c.id);
    const snapUrl=hdOn
      ? `/api/camera/${esc(c.id)}/stream_hd.mjpg`
      : `/api/camera/${esc(c.id)}/snapshot.jpg?t=${Date.now()}`;
    const isActive=c.status==='active';
    const motionActive=isActive;
    const coralActive=!!(c.coral_available && c.detection_mode && c.detection_mode!=='motion_only');
    const tlOn=!!(c.timelapse&&c.timelapse.enabled);
    const fps=c.frame_interval_ms?Math.round(1000/c.frame_interval_ms):null;
    const previewFps=(c.preview_fps||0)>0?c.preview_fps:null;
    const streamMode=c.stream_mode||'baseline';

    // Object detection box SVG (13×13) — corner-bracket bounding box, amber when Coral active
    const boxCol=c.coral_available?'#f59e0b':'rgba(255,255,255,.25)';
    const boxCls=c.coral_available?' class="cv-obj-unfold"':'';
    const brainSVG=`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="${boxCol}" stroke-width="2.2" stroke-linecap="round"${boxCls} aria-hidden="true"><path d="M6 10V6h4"/><path d="M14 6h4v4"/><path d="M6 14v4h4"/><path d="M20 14v4h-4"/></svg>`;

    // Motion running-person SVG (13×13) — stride silhouette, blue when active
    const motCol=isActive?'#93c5fd':'rgba(255,255,255,.25)';
    const motCls=isActive?' class="cv-runner-stride"':'';
    const motSVG=`<svg viewBox="0 0 24 24" width="13" height="13" fill="none"${motCls} aria-hidden="true"><circle cx="15" cy="4.5" r="2.5" fill="${motCol}"/><path d="M14 7L11 13.5" stroke="${motCol}" stroke-width="2" stroke-linecap="round" fill="none"/><path d="M12 10L8.5 8.5" stroke="${motCol}" stroke-width="1.8" stroke-linecap="round"/><path d="M12 10L15.5 9" stroke="${motCol}" stroke-width="1.8" stroke-linecap="round"/><path d="M11 13.5L8.5 19.5" stroke="${motCol}" stroke-width="2" stroke-linecap="round"/><path d="M11 13.5L14.5 19" stroke="${motCol}" stroke-width="2" stroke-linecap="round"/></svg>`;

    const bellOn=`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fb923c" stroke-width="2.2" stroke-linecap="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;
    const bellOff=`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2.2" stroke-linecap="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

    // Per-camera detection mode drives pill visibility / dim state
    const motionEnabled=(c.motion_enabled!==false);
    const trigMode=c.detection_trigger||'motion_and_objects';
    // Motion pill hidden entirely when the kill-switch is off
    const motionPillHidden=!motionEnabled;
    // When in objects_only mode, motion pill is dimmed (still visible so
    // users understand motion is IGNORED as a trigger even if sensed)
    const motionPillDim=motionEnabled && trigMode==='objects_only';
    // When in motion_only mode, object pill is dimmed
    const objectPillDim=trigMode==='motion_only';
    // Stumm-style bell-off next to the title when armed=false
    const mutedIndicator=c.armed?'':`<span class="cv-muted-ico" title="Benachrichtigungen stumm">${bellOff}</span>`;
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

    <!-- top-left: name + group — ALWAYS rendered so the offline card is still identifiable -->
    <div class="cv-title-wrap">
      <div class="cv-name-row">
        ${mutedIndicator}
        <div class="cv-name">${esc(c.name)}</div>
        ${tlOn?`<span class="cv-tl-dot" title="Timelapse aktiv">${objIconSvg('timelapse',15)}</span>`:''}
      </div>
      ${c.location?`<div class="cv-loc">${esc(c.location)}</div>`:''}
    </div>
${isActive?`
    <!-- top-right: [Live + HD] row, then alarm pill below -->
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
            <div class="cv-lp-row"><span>Preview-FPS<br><small class="cv-lp-fps-sub">${hdOn?'Main-Stream aktiv':'Gemessen (Sub-Stream)'}</small></span><strong class="cv-lp-fps-val">${hdOn?'—':(previewFps!=null?previewFps+' fps':'—')}</strong></div>
            <div class="cv-lp-row"><span>Auflösung</span><strong class="cv-lp-res-val">${hdOn?'Main-Stream':esc(c.preview_resolution||c.resolution||'—')}</strong></div>
            <div class="cv-lp-row"><span>Analyse-Framerate<br><small>Wie oft TAM-spy analysiert</small></span><strong>${fps!=null?fps+' fps':'—'}</strong></div>
          </div>
        </div>
        ${c.rtsp_url?`<button class="cv-hd-badge${hdOn?' active':''}" data-cam="${esc(c.id)}" onclick="event.stopPropagation();toggleCardHd('${esc(c.id)}',this)" title="HD-Vorschau">HD</button>`:''}
      </div>
      <div class="cv-pill ${c.armed?'cv-pill-alarm-on':'cv-pill-alarm-off'}" onclick="event.stopPropagation();toggleArm('${esc(c.id)}',${!c.armed})" style="cursor:pointer">${c.armed?objIconSvg('notification',14):bellOff}${c.armed?'Benachrichtigung':'Stumm'}</div>
    </div>

    <!-- bottom-right: Motion + Objekte pills (horizontal). Visibility +
         dimming mirror the per-camera detection_trigger mode. -->
    <div class="cv-br">
      ${motionPillHidden?'':`<div class="cv-pill ${motionActive?'cv-pill-motion-on':'cv-pill-motion-off'}${motionPillDim?' cv-pill-dim':''}" style="font-size:10px;padding:3px 7px" title="${motionPillDim?'Motion wird erkannt, löst aber KEIN Event aus (Nur Objekte)':'Motion-Erkennung'}">${objIconSvg('motion',11)} Motion</div>`}
      ${c.coral_available?`<div class="cv-pill ${coralActive?'cv-pill-coral-on':'cv-pill-coral-off'}${objectPillDim?' cv-pill-dim':''}" style="font-size:10px;padding:3px 7px" title="${objectPillDim?'Objekte werden erkannt, lösen aber KEIN Event aus (Nur Motion)':'Objekt-Erkennung'}">${objIconSvg('motion_objects',11)} Objekte</div>`:''}
    </div>
`:''}
    <!-- bottom: hover action button -->
    <div class="cv-actions">
      <button class="cv-abt cv-abt-edit" onclick="event.stopPropagation();editCamera('${esc(c.id)}')">${pencil}<span>Einstellungen</span></button>
    </div>
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

// ── Timeline ─────────────────────────────────────────────────────────────────
const CAT_COLORS={alle:'#8888aa',motion:'#cbd5e1',person:'#facc15',cat:'#fb923c',bird:'#38bdf8',car:'#f87171',dog:'#7c2d12',timelapse:'#a855f7'};
// Order matches the Mediathek filter bar exactly so both filter rows read
// the same left-to-right (Bewegung first, then per-class). Timelapse stays
// out of the timeline lanes — only physical detection labels here.
const TL_LANES=['motion','person','cat','bird','car','dog'];
const GAP_MS=2*60*1000;
let _tlActiveLanes=new Set(TL_LANES);

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

  // Compute which labels have events in the visible range
  const _tlTmpMax=now;
  let _tlTmpMin=now-hours*3600000;
  if(earliestMs&&earliestMs>_tlTmpMin) _tlTmpMin=earliestMs;
  const labelsInRange=new Set();
  tracks.forEach(tr=>{
    (tr.points||[]).forEach(p=>{
      const t=new Date(p.time).getTime();
      if(!t||t<_tlTmpMin||t>_tlTmpMax) return;
      (p.labels||[]).forEach(l=>labelsInRange.add(l));
      if(p.top_label) labelsInRange.add(p.top_label);
    });
  });

  // Filter pills — same .cat-filter-btn class + data-val attribute the
  // Mediathek bar uses, so both rows render visually identical. No
  // "Filter:" prefix, exact label order: motion · person · cat · bird ·
  // car · dog. Pills with no events in the current time range get the
  // dim class (still clickable, but visually backgrounded).
  const leg=byId('tlLegend');
  if(leg){
    leg.innerHTML=TL_LANES.map(l=>{
      const empty=!labelsInRange.has(l);
      const cls=`media-pill cat-filter-btn${_tlActiveLanes.has(l)?' active':''}${empty?' tl-lane-btn-empty':''}`;
      return `<button class="${cls}" data-lane="${l}" data-val="${l}" style="--cb:${CAT_COLORS[l]||'#8888aa'}"><span class="cfb-icon">${objIconSvg(l,18)}</span><span>${OBJ_LABEL[l]||l}</span></button>`;
    }).join('');
    leg.querySelectorAll('.cat-filter-btn[data-lane]').forEach(btn=>{
      btn.onclick=()=>{
        const lane=btn.dataset.lane;
        if(_tlActiveLanes.has(lane)) _tlActiveLanes.delete(lane); else _tlActiveLanes.add(lane);
        renderTimeline();
      };
    });
  }

  if(!tracks.length){container.innerHTML='<div class="tl-empty">Keine Ereignisse im gewählten Zeitraum.</div>';return;}

  const tMax=now;
  let tMin=now-hours*3600000;
  // Clamp tMin to earliest event — no point showing empty space before first data point
  if(earliestMs&&earliestMs>tMin) tMin=earliestMs;
  const span=tMax-tMin||1;

  let html='';
  tracks.forEach((tr,ti)=>{
    const cam=(state.config?.cameras||[]).find(c=>c.id===tr.camera_id)||{};
    const camName=cam.name||tr.camera_id;
    const camIcon=getCameraIcon(camName);
    // TASK 3: camera label with icon, 15px bold, extra margin for 2nd+ block
    html+=`<div class="tl-cam-block${ti>0?' tl-cam-block--notfirst':''}">`;
    const tlHdrCls=STAT_MEDIA_DRILLDOWN?'tl-cam-header stat-drillable':'tl-cam-header';
    const tlHdrClick=STAT_MEDIA_DRILLDOWN?`onclick="_statOpenMedia('${esc(tr.camera_id)}','')"`:'' ;
    html+=`<div class="${tlHdrCls}" ${tlHdrClick}><span class="tl-cam-icon">${camIcon}</span><span class="tl-cam-name">${esc(camName)}</span></div>`;
    // TASK 4: sunken pool wrapper with vertical grid lines
    html+=`<div class="tl-lanes-wrap">`;
    for(let k=1;k<5;k++) html+=`<div class="tl-vgrid" style="left:calc(36px + (100% - 36px)*${k}/5)"></div>`;
    TL_LANES.forEach(label=>{
      const color=colors[label]||colors.unknown;
      const groups=_tlGroupLane(tr.points||[], label, tMin, tMax);
      html+=`<div class="tl-lane${_tlActiveLanes.has(label)?'':' tl-lane--hidden'}">`;
      html+=`<div class="tl-lane-icon">${OBJ_SVG[label]||''}</div>`;
      html+=`<div class="tl-track">`;
      groups.forEach(g=>{
        const leftPct=Math.max(0,(g.startTime-tMin)/span*100);
        const widthPct=Math.max(0.8,Math.min((g.endTime-g.startTime)/span*100,100-leftPct));
        if(leftPct>=100) return;
        html+=`<div class="tl-bar" style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;background:${color};opacity:0.85" data-camid="${esc(tr.camera_id)}" data-label="${esc(label)}" title="${g.count} Events · ${OBJ_LABEL[label]||label}"></div>`;
      });
      html+=`</div></div>`;
    });
    html+=`</div></div>`;
  });

  // X-axis — 6 evenly spaced labels
  html+=`<div class="tl-xaxis">`;
  for(let k=0;k<6;k++) html+=`<span class="tl-xlabel">${_tlFmtTs(tMin+span*k/5,hours)}</span>`;
  html+=`</div>`;
  container.innerHTML=html;

  // Bar click → navigate to Mediathek
  container.querySelectorAll('.tl-bar').forEach(bar=>{
    bar.onclick=()=>{
      state.mediaCamera=bar.dataset.camid;
      state.mediaLabels=bar.dataset.label?new Set([bar.dataset.label]):new Set();
      document.querySelector('#media').scrollIntoView({behavior:'smooth',block:'start'});
      loadMedia().then(()=>renderMediaGrid());
    };
  });
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
  if(nowRevealed){_revealUrl(input); btn.classList.add('revealed'); btn.textContent='🙈';}
  else {
    // User just edited the revealed value — stash new real before re-masking
    input.dataset.real=input.value;
    _applyUrlMask(input); btn.classList.remove('revealed'); btn.textContent='👁';
  }
};
function _unmaskUrlsForSubmit(form){
  form.querySelectorAll('input[data-mask-url="1"]').forEach(inp=>{
    if(inp.dataset.masked==='1' && inp.dataset.real!=null){
      inp.value=inp.dataset.real;
    }
  });
}

function initRtspBuilder(){
  const sel=byId('rtspPathSelect');
  if(!sel.options.length) RTSP_PATH_OPTS.forEach(p=>{const o=document.createElement('option');o.value=p.value;o.textContent=p.label;sel.appendChild(o);});
  const f=byId('cameraForm').elements;
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
    if(!ip){setMaskable(f['rtsp_url'],'');return;}
    const auth=user?(user+(pass?':'+_rtspEnc(pass):'')+'@'):'';
    const portPart=port&&port!=='554'?':'+port:'';
    setMaskable(f['rtsp_url'],`rtsp://${auth}${ip}${portPart}${path}`);
    // auto-fill snapshot if empty
    const snapReal=f['snapshot_url']?.dataset.real||f['snapshot_url']?.value||'';
    if(!snapReal && user)
      setMaskable(f['snapshot_url'],`http://${user}:${_rtspEnc(pass)}@${ip}/cgi-bin/snapshot.cgi`);
  };
  ['rtsp_ip','rtsp_user','rtsp_pass','rtsp_port'].forEach(n=>f[n]?.addEventListener('input',rebuild));
  sel.addEventListener('change',rebuild);
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
  byId('cameraSettingsList').innerHTML=state.cameras.map(c=>{
    // Merge is offered when the camera isn't actively streaming — replacement
    // hardware always lives behind a different cam_id, so a healthy camera is
    // never a merge source.
    const canMerge=c.status!=='active';
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
  // Sliders update a sibling label. Each label lookup is null-guarded so
  // that a template change that removes the label element doesn't abort
  // the whole event handler — any future refactor can hide a slider
  // safely just by not rendering the label.
  f['detection_min_score']?.addEventListener('input',()=>{ const v=parseFloat(f['detection_min_score'].value); const el=byId('detectionMinScoreLabel'); if(el) el.textContent=v.toFixed(2); });
  f['wildlife_motion_sensitivity']?.addEventListener('input',()=>{ const v=parseFloat(f['wildlife_motion_sensitivity'].value); const el=byId('wildlifeMotionLabel'); if(el) el.textContent=Math.round(v*100)+'%'; });
  f['label_threshold_person']?.addEventListener('input',()=>{ const v=parseFloat(f['label_threshold_person'].value); const el=byId('labelThresholdPersonLabel'); if(el) el.textContent=v.toFixed(2); });
  f['frame_interval_ms']?.addEventListener('input',()=>{ const el=byId('frameIntervalLabel'); if(el) el.textContent=f['frame_interval_ms'].value+'ms'; });
  f['snapshot_interval_s']?.addEventListener('input',()=>{ const el=byId('snapshotIntervalLabel'); if(el) el.textContent=f['snapshot_interval_s'].value+'s'; });
  // Motion toggle → grey out the trigger dropdown + show hint
  f['motion_enabled']?.addEventListener('change',_updateMotionOffState);
}

// Per-camera object-filter pills (Person/Katze/Vogel/Auto/Hund). Same
// visual recipe as the Mediathek filter bar — active pill fills with the
// object colour via --cb. _camObjectFilterState is kept in sync with the
// hidden input so the existing save flow doesn't need to change.
const _CAM_OBJ_OPTIONS=[
  {k:'person', label:'Person', cb:'#a855f7'},
  {k:'cat',    label:'Katze',  cb:'#ec4899'},
  {k:'bird',   label:'Vogel',  cb:'#06b6d4'},
  {k:'car',    label:'Auto',   cb:'#f59e0b'},
  {k:'dog',    label:'Hund',   cb:'#7c2d12'},
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

// Read-only status rows shown at the top of the Erkennung tab. Values are
// global (Coral + motion detector state) so the rows link back to Coral
// settings rather than offering an inline toggle here.
function _renderGlobalStatusRows(){
  const host=byId('camGlobalStatus'); if(!host) return;
  const proc=state.config?.processing||{};
  // Motion is on by default; only "off" if explicitly disabled in config.
  const motionOn=proc.motion?.enabled!==false;
  // Coral / CPU / motion_only → derived from the first camera's runtime state.
  const cam0=state.cameras?.[0];
  const coralOn=!!(proc.coral_enabled ?? (cam0?.detection_mode!=='motion_only'));
  const coralAvail=!!cam0?.coral_available;
  let kiText, kiOn;
  if(!coralOn){kiText='KI-Objekterkennung deaktiviert'; kiOn=false;}
  else if(coralAvail){kiText='KI-Objekterkennung aktiv (Coral TPU)'; kiOn=true;}
  else if(cam0?.detection_mode==='cpu'){kiText='KI-Objekterkennung aktiv (CPU)'; kiOn=true;}
  else{kiText='KI-Objekterkennung nicht verfügbar'; kiOn=false;}

  const row=(on, text)=>`
    <div class="cam-gs-row${on?'':' cam-gs-row--off'}">
      <span class="cam-gs-dot"></span>
      <span class="cam-gs-text">${esc(text)}</span>
      <span class="cam-gs-tag">Global-Einstellung</span>
    </div>`;
  host.innerHTML = row(motionOn, motionOn?'Bewegungserkennung aktiv':'Bewegungserkennung deaktiviert')
                 + row(kiOn, kiText)
                 + `<a href="#coral-settings" class="cam-gs-link" onclick="_scrollToCoralSettings(event)">In Coral-Settings ändern →</a>`;
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

function _updateMotionOffState(){
  const f=byId('cameraForm')?.elements; if(!f) return;
  const off=!(f['motion_enabled']?.checked);
  const block=document.querySelector('.cam-det-block'); if(!block) return;
  block.classList.toggle('motion-off',off);
  const hint=block.querySelector('.cam-det-motionoff'); if(hint) hint.hidden=!off;
}

// Wildlife-only form fields are hidden when the global wildlife model
// switch is off — there's nothing to tune in that case. Read the global
// checkbox state (populated by hydrateSettings) and toggle the wrap.
function _updateWildlifeFormVisibility(){
  const on = !!byId('wildlifeEnabled')?.checked;
  document.querySelectorAll('.field-wrap--wildlife-only,.field-help--wildlife-only').forEach(el=>{
    el.style.display = on ? '' : 'none';
  });
}
window._updateWildlifeFormVisibility = _updateWildlifeFormVisibility;
function editCamera(camId){
  const c=(state.config?.cameras||[]).find(x=>x.id===camId)||(state.cameras||[]).find(x=>x.id===camId);
  if(!c){console.error('editCamera: not found',camId); return;}
  // Toggle: clicking same camera closes the panel
  if(_currentEditCamId===camId){_closeEditPanel(); return;}
  // Switch camera: restore immediately then open new
  _restoreEditWrapper();
  _initCameraFormListeners();
  initCameraEditTabs();
  initRtspBuilder();
  _updateWildlifeFormVisibility();
  const f=byId('cameraForm').elements;
  f['id'].value=c.id||''; f['id'].dataset.autoGen='0';
  f['name'].value=c.name||'';
  if(f['icon']) f['icon'].value=c.icon||getCameraIcon(c.name||c.id);
  byId('cameraEditTitle').textContent=`Kamera bearbeiten · ${c.name||c.id}`;
  const p=parseRtspUrl(c.rtsp_url||'');
  f['rtsp_ip'].value=p.host||''; f['rtsp_user'].value=p.user||''; f['rtsp_pass'].value=p.pass||''; f['rtsp_port'].value=p.port||'554';
  const matchedPath=RTSP_PATH_OPTS.find(o=>o.value===p.path);
  if(f['rtsp_path']) f['rtsp_path'].value=matchedPath?matchedPath.value:RTSP_PATH_OPTS[0].value;
  f['rtsp_url'].value=c.rtsp_url||'';
  f['snapshot_url'].value=c.snapshot_url||'';
  // Apply password masking to the URL display fields. Eye toggle reveals.
  delete f['rtsp_url'].dataset.real; delete f['snapshot_url'].dataset.real;
  _applyUrlMask(f['rtsp_url']);
  _applyUrlMask(f['snapshot_url']);
  // Reset eye buttons to masked-state icon
  byId('cameraForm').querySelectorAll('.url-eye').forEach(b=>{b.classList.remove('revealed'); b.textContent='👁';});
  // Load telegram / mqtt toggles (now on the Alerting tab)
  if(f['telegram_enabled']) f['telegram_enabled'].checked=(c.telegram_enabled!==false);
  if(f['mqtt_enabled']) f['mqtt_enabled'].checked=(c.mqtt_enabled!==false);
  // Populate global status rows on the Erkennung tab
  _renderGlobalStatusRows();
  // Object filter is now rendered as a pill bar; keep the hidden input in
  // sync so the existing save flow (reads from f['object_filter'].value)
  // still works unchanged.
  _camObjectFilterState=[...(c.object_filter||['person','cat','bird'])];
  f['object_filter'].value=_camObjectFilterState.join(',');
  _renderCamObjectPills();
  // Alarm profile — empty string means "inherit" for back-compat; default
  // the dropdown to "soft" in that case.
  const apSel=byId('camAlarmProfileSelect');
  if(apSel){ apSel.value=(c.alarm_profile||'soft'); _updateAlarmProfileHint(); }
  if(f['enabled']) f['enabled'].checked=!!c.enabled; f['armed'].checked=!!c.armed;
  f['schedule_start'].value=(c.schedule&&c.schedule.start)||''; f['schedule_end'].value=(c.schedule&&c.schedule.end)||''; f['schedule_enabled'].checked=!!(c.schedule&&c.schedule.enabled);
  if(f['telegram_enabled']) f['telegram_enabled'].checked=(c.telegram_enabled!==false);
  if(f['mqtt_enabled']) f['mqtt_enabled'].checked=(c.mqtt_enabled!==false);
  if(f['bottom_crop_px']) f['bottom_crop_px'].value=c.bottom_crop_px||0;
  if(f['motion_sensitivity']){const ms=c.motion_sensitivity!=null?c.motion_sensitivity:0.5; f['motion_sensitivity'].value=ms; const lbl=byId('motionSensLabel'); if(lbl) lbl.textContent=Math.round(parseFloat(ms)*100)+'%';}
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
    const el=byId('detectionMinScoreLabel'); if(el) el.textContent=Number(cms).toFixed(2);
  }
  if(f['label_threshold_person']){
    const lt=(c.label_thresholds||{}).person;
    const v=(lt!=null && !Number.isNaN(parseFloat(lt))) ? parseFloat(lt) : 0.72;
    f['label_threshold_person'].value=v;
    const el=byId('labelThresholdPersonLabel'); if(el) el.textContent=v.toFixed(2);
  }
  // Erkennung & Aufnahme trio
  if(f['motion_enabled']){
    f['motion_enabled'].checked=(c.motion_enabled!==false);
    _updateMotionOffState();
  }
  if(f['detection_trigger']) f['detection_trigger'].value=c.detection_trigger||'motion_and_objects';
  if(f['post_motion_tail_s']){
    // Normalise: 0 or null → "0" (global default), otherwise match closest preset
    const tail=c.post_motion_tail_s||0;
    const presets=['0','3','5','8','10','15'];
    f['post_motion_tail_s'].value=presets.includes(String(tail))?String(tail):'0';
  }
  if(f['recording_schedule_enabled']) f['recording_schedule_enabled'].checked=!!c.recording_schedule_enabled;
  if(f['recording_schedule_start']) f['recording_schedule_start'].value=c.recording_schedule_start||'08:00';
  if(f['recording_schedule_end']) f['recording_schedule_end'].value=c.recording_schedule_end||'22:00';
  if(f['resolution']) f['resolution'].value=c.resolution||'auto';
  // frame_interval_ms / snapshot_interval_s are hidden inputs since the
  // Qualität tab was removed; their visible labels (#frameIntervalLabel /
  // #snapshotIntervalLabel) no longer exist. Guard the textContent write
  // so a null byId() lookup doesn't throw and abort the whole expand.
  if(f['frame_interval_ms']){
    const fi=c.frame_interval_ms||350;
    f['frame_interval_ms'].value=fi;
    const el=byId('frameIntervalLabel'); if(el) el.textContent=fi+'ms';
  }
  if(f['snapshot_interval_s']){
    const si=c.snapshot_interval_s||3;
    f['snapshot_interval_s'].value=si;
    const el=byId('snapshotIntervalLabel'); if(el) el.textContent=si+'s';
  }
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
  if(camRow){ camRow.appendChild(wrapper); camRow.classList.add('editing'); }
  requestAnimationFrame(()=>wrapper.classList.add('slide-open'));
  _currentEditCamId=camId;
  setTimeout(()=>wrapper.scrollIntoView({behavior:'smooth',block:'nearest'}),120);
  // Populate connection diagnostics panel
  _loadCamDiagnostics(camId);
}

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
  const server=state.config.server||{}, mqtt=state.config.mqtt||{};
  const proc=state.config.processing||{}, coral=state.config.coral||{};
  // App section
  const pubEl=byId('set_public_base_url'); if(pubEl) pubEl.value=server.public_base_url||'';
  const subEl=byId('set_discovery_subnet'); if(subEl) subEl.value=state.config.default_discovery_subnet||'';
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
  const chip=byId('coralStatusChip');
  if(chip){
    let label='aus', cls='set-status-badge--off';
    if(coralActive){
      if(coralAvail){label='Coral TPU';cls='set-status-badge--on';}
      else{label='CPU Fallback';cls='set-status-badge--cpu';}
    }
    chip.textContent=label;
    chip.className='set-status-badge '+cls;
  }
  const hint=byId('coralStatusHint');
  if(hint){
    const reason=cam0?.coral_reason||'—';
    const lines=[coralAvail?'✅ Coral TPU erkannt und aktiv.':(coralActive?`💻 CPU Fallback aktiv (${esc(reason)})`:'⏸ Erkennung deaktiviert')];
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
      </div>`;
  }catch(e){/* silent — system info optional */}
}

let _appSaveTimer=null;
window.saveAppSettingsDebounced=function(){
  clearTimeout(_appSaveTimer);
  _appSaveTimer=setTimeout(()=>saveAppSettings(),600);
};

// ── Telegram page hydrate & logic ─────────────────────────────────────────────

function hydrateTelegram(){
  const tg=state.config?.telegram||{};
  const el=byId('tg_enabled'); if(el) el.checked=!!tg.enabled;
  const tgBadge=byId('tgStatusBadge');
  if(tgBadge){tgBadge.textContent=tg.enabled?'aktiv':'aus';tgBadge.className='set-status-badge '+(tg.enabled?'set-status-badge--on':'set-status-badge--off');}
  const tok=byId('tg_token'); if(tok) tok.value=tg.token||'';
  const cid=byId('tg_chat_id'); if(cid) cid.value=tg.chat_id||'';
  const fmt=tg.format||'photo';
  document.querySelectorAll('[name="tg_format"]').forEach(r=>r.checked=r.value===fmt);
  renderTgFormatPreview(fmt);
}

function initCameraEditTabs(){
  const bar=document.querySelector('.cam-tab-bar'); if(!bar) return;
  // Reset to first tab
  bar.querySelectorAll('.cam-tab-btn').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.cam-tab-panel').forEach(p=>p.classList.remove('active'));
  const first=bar.querySelector('.cam-tab-btn[data-tab="cam-tab-verbindung"]');
  if(first) first.classList.add('active');
  const firstPanel=byId('cam-tab-verbindung'); if(firstPanel) firstPanel.classList.add('active');
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
  bar.querySelectorAll('.tg-tab-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      bar.querySelectorAll('.tg-tab-btn').forEach(b=>b.classList.remove('active'));
      document.querySelectorAll('.tg-tab-panel').forEach(p=>p.classList.remove('active'));
      btn.classList.add('active');
      const panel=byId(btn.dataset.tab); if(panel) panel.classList.add('active');
    });
  });
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
  {k:'person', l:'Person'},
  {k:'cat',    l:'Katze'},
  {k:'bird',   l:'Vogel'},
  {k:'car',    l:'Auto'},
  {k:'dog',    l:'Hund'},
];
function _polyLabels(p){
  if(!p || typeof p!=='object') return [];
  return Array.isArray(p.labels) ? p.labels.slice() : [];
}
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
    const checks=`<label class="shape-lbl-chip${allOn?' shape-lbl-chip--on':''}"><input type="checkbox" ${allOn?'checked':''} onclick="event.stopPropagation();_setShapeAllLabels('${kind}',${i},this.checked)"><span>Alle</span></label>`
      +_SHAPE_LABEL_OPTS.map(o=>{
        const on=polyLabels.has(o.k);
        return `<label class="shape-lbl-chip${on?' shape-lbl-chip--on':''}"><input type="checkbox" ${on?'checked':''} onclick="event.stopPropagation();_toggleShapeLabel('${kind}',${i},'${o.k}',this.checked)"><span>${o.l}</span></label>`;
      }).join('');
    return `<div class="shape-row${shapeState.pulse===pulseKey?' pulse':''}" data-kind="${kind}" data-idx="${i}" onclick="_pulseShape('${kind}',${i})">
      <div class="shape-row-head">
        <span class="shape-row-dot shape-row-dot--${kind}"></span>
        <span class="shape-row-label">${esc(label)}</span>
        <span class="shape-row-count">${pts.length} Punkte</span>
        <button type="button" class="shape-row-del" title="Löschen" onclick="event.stopPropagation();_deleteShape('${kind}',${i})"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,4 14,4"/><path d="M5 4V2h6v2"/><path d="M3 4l1 10h8l1-10"/></svg></button>
      </div>
      <div class="shape-lbl-row">${checks}</div>
    </div>`;
  };
  host.innerHTML =
      zones.map((p,i)=>row(p,i,'zone')).join('')
    + masks.map((p,i)=>row(p,i,'mask')).join('');
}
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
    cameras: camId ? [{id:camId,name:byId('wiz_cam_name').value||camId,location:byId('wiz_cam_location').value||'',rtsp_url:byId('wiz_cam_rtsp').value||'',snapshot_url:byId('wiz_cam_snapshot').value||'',enabled:true,armed:true,object_filter:['person','cat','bird'],timelapse:{enabled:false,fps:25},zones:[],masks:[],schedule:{enabled:false,start:'22:00',end:'06:00'},telegram_enabled:true,mqtt_enabled:true,whitelist_names:[]}] : []
  };
  await fetch('/api/wizard/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  closeWizard();
  await loadAll();
}

byId('reloadConfigBtn').onclick=()=>loadAll();

byId('tlRangeSlider').addEventListener('input',e=>{
  state.tlHours=parseInt(e.target.value);
  j(`/api/timeline?hours=${state.tlHours}${state.label?`&label=${encodeURIComponent(state.label)}`:''}`).then(data=>{state.timeline=data;renderTimeline();});
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
    schedule:{enabled:f['schedule_enabled'].checked,start:f['schedule_start'].value||'22:00',end:f['schedule_end'].value||'06:00'},
    bottom_crop_px:parseInt(f['bottom_crop_px']?.value||0),
    motion_sensitivity:parseFloat(f['motion_sensitivity']?.value||0.5),
    wildlife_motion_sensitivity:parseFloat(f['wildlife_motion_sensitivity']?.value||0),
    motion_enabled:f['motion_enabled']?f['motion_enabled'].checked:true,
    detection_trigger:f['detection_trigger']?.value||'motion_and_objects',
    post_motion_tail_s:parseFloat(f['post_motion_tail_s']?.value||0),
    recording_schedule_enabled:!!f['recording_schedule_enabled']?.checked,
    recording_schedule_start:f['recording_schedule_start']?.value||'08:00',
    recording_schedule_end:f['recording_schedule_end']?.value||'22:00',
    alarm_profile:f['alarm_profile']?.value||'soft',
    detection_min_score:parseFloat(f['detection_min_score']?.value||0),
    label_thresholds:(()=>{
      // Per-label thresholds: only persist values that differ from the
      // global detection_min_score, and never persist NaN. Currently only
      // wires the person slider; structure is open for future labels.
      const out={};
      const p=parseFloat(f['label_threshold_person']?.value);
      if(!Number.isNaN(p)) out.person=p;
      return out;
    })(),
    resolution:f['resolution']?.value||'auto',
    frame_interval_ms:parseInt(f['frame_interval_ms']?.value||350),
    snapshot_interval_s:parseInt(f['snapshot_interval_s']?.value||3),
    zones:JSON.parse(f['zones_json'].value||'[]'),masks:JSON.parse(f['masks_json'].value||'[]')};
  const _savedId=payload.id; _restoreEditWrapper();
  await fetch('/api/settings/cameras',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  await loadAll(); editCamera(_savedId);
};
byId('closeCameraEdit')?.addEventListener('click',()=>_closeEditPanel());
// ── Section-level save functions ──────────────────────────────────────────────
window.saveAppSettings=async function(){
  const payload={
    server:{public_base_url:byId('set_public_base_url')?.value||'',default_discovery_subnet:byId('set_discovery_subnet')?.value||'192.168.1.0/24'}
  };
  await fetch('/api/settings/app',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  showToast('App-Einstellungen gespeichert.','success');
  await loadAll();
};
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
  // Reflect the new toggle state in any currently-open camera form +
  // the pipeline-tree opacity before loadAll() rebuilds everything.
  _updateWildlifeFormVisibility?.();
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
const _CORAL_LABEL_COLORS={person:'#6e6eff',cat:'#a06eff',bird:'#54d662',dog:'#00b0ff',fox:'#ff7a1a',squirrel:'#c8651a',hedgehog:'#a67c52'};
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
    const img=item.image_b64
      ? `<img src="${item.image_b64}" alt="${esc(item.filename)}" loading="lazy"/>`
      : '<div class="cb-noimg">Kein Bild</div>';
    return `<div class="cb-card">
      <div class="cb-imgwrap">${img}<span class="cb-ms">${item.inference_ms||0} ms</span></div>
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
      // Stable stem order: active-first, then alphabetical
      const stemKeys=Object.keys(stems).sort();
      for(const stem of stemKeys){
        const variants=stems[stem];
        const cpu=variants.find(v=>!v.edgetpu);
        const tpu=variants.find(v=>v.edgetpu);
        const anyActive=variants.find(v=>v.active_in_category);
        const labelInfo=(anyActive||variants[0]).labels||{};
        const labelPill=labelInfo.filename
          ? (labelInfo.exists
              ? `<span class="mpair-labels" title="${esc(labelInfo.path||'')}">Labels: ${esc(labelInfo.filename)}${labelInfo.count?` (${labelInfo.count} Einträge)`:''}</span>`
              : `<span class="mpair-labels mpair-labels--missing">⚠ Labels fehlen: ${esc(labelInfo.filename)}</span>`)
          : '';
        const mkVariantHtml=(v,label)=>{
          if(!v) return `<div class="mvar mvar--missing"><span class="mvar-kind">${esc(label)}</span><span class="mvar-empty">nicht vorhanden</span></div>`;
          const active=v.active_in_category;
          return `<div class="mvar${active?' mvar--active':''}" data-path="${esc(v.path)}">
            <span class="mvar-kind mvar-kind--${label.toLowerCase()}">${esc(label)}</span>
            <span class="mvar-size">${v.size_mb!=null?v.size_mb+' MB':''}</span>
            ${active?'<span class="mvar-badge">aktiv</span>':''}
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
          <div class="mpair-note">EdgeTPU: ~5 ms auf Coral TPU · CPU: ~130 ms Fallback · Automatische Auswahl</div>
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
  showCameraReloadAnimation(camId);
  await fetch(`/api/camera/${encodeURIComponent(camId)}/reload`,{method:'POST'}).catch(()=>{});
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
    return `<button type="button" class="sec-tab-btn${i===0?' active':''}" id="tlTab_${esc(cam.id)}" onclick="selectTlCam('${esc(cam.id)}')">
      ${getCameraIcon(cam.name)} ${esc(cam.name)}
    </button>`;
  }).join('');
  return `<div class="sec-tabs" id="tlCamTabs" style="margin-bottom:0">${tabs}</div>
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
    <button class="settings-save-btn" style="margin-top:4px" onclick="saveTlCameraProfiles('${esc(cam.id)}')">💾 Speichern</button>`;
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
  document.querySelectorAll('#tlCamTabs .sec-tab-btn').forEach(b=>b.classList.toggle('active',b.id===`tlTab_${camId}`));
  const cam=(state.cameras||[]).find(c=>c.id===camId);
  const content=byId('tlCamContent');
  if(cam&&content) content.innerHTML=_renderTlModesGrid(cam);
};
function _tlPeriodLabel(s){
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
  const periodLabel=_tlPeriodLabel(pN);
  const intervalLabel=_tlFmtInterval(intervalS);
  const compression=Math.round(pN/Math.max(1,tN));
  // ~40 KB per JPEG at q≈72; sub-1s interval drops to q=50 ≈ 26 KB.
  const perFrameKb=intervalS<1?26:40;
  const diskMb=Math.max(1, Math.round(totalFrames*perFrameKb/1024));
  return `<div class="tl-drow"><span class="tl-drow-ico">⏱</span><span class="tl-drow-text">${periodLabel} → ${tN}s Video · ${fN} fps</span></div><div class="tl-drow"><span class="tl-drow-ico">📸</span><span class="tl-drow-text">${totalFrames} Frames · Alle ${intervalLabel} ein Foto</span></div><div class="tl-drow tl-drow-accent"><span class="tl-drow-ico">⚡</span><span class="tl-drow-text">${compression}× Zeitraffer · ~${diskMb} MB Speicher</span></div>`;
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
document.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('.set-section[data-accent]').forEach(el=>{
    el.style.setProperty('--sa',el.dataset.accent);
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
  const sectionIds=['dashboard','statistik','media','achievements','cameras','settings','logs'];
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
window.togglePwField=function(btn,fieldName){
  const f=btn.closest('form');
  const input=f?.elements[fieldName]; if(!input) return;
  input.type=input.type==='password'?'text':'password';
  btn.textContent=input.type==='password'?'👁':'🙈';
};
window.togglePwFieldById=function(id){
  const input=byId(id); if(!input) return;
  input.type=input.type==='password'?'text':'password';
};

// ── Media storage stats ───────────────────────────────────────────────────────
async function loadMediaStorageStats(){
  const bar=byId('mediaStorageBar'); if(!bar) return;
  try{
    const r=await j('/api/media/storage-stats');
    state.mediaStats=r.cameras||[];
    state.mediaArchived=r.archived||[];
    bar.innerHTML='';
    renderMediaOverview();
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
  const hamburger=byId('hamburgerBtn');
  const overlay=byId('sidebarOverlay');
  const STORAGE_KEY='tspy_sidebar_collapsed';

  function setCollapsed(yes){
    sidebar.classList.toggle('collapsed',yes);
    try{localStorage.setItem(STORAGE_KEY,yes?'1':'0');}catch{}
  }

  // Desktop (>1024px): always collapsed; CSS hover expands — no localStorage interaction
  // Tablet (768-1024px): collapsed by default, hamburger toggles + saves to localStorage
  // Mobile (≤768px): hidden, hamburger slides in as overlay
  if(window.innerWidth>1024){
    sidebar.classList.add('collapsed');
  } else if(window.innerWidth>768){
    const saved=localStorage.getItem(STORAGE_KEY);
    setCollapsed(saved!=='0');
  }

  if(hamburger) hamburger.onclick=()=>{
    if(window.innerWidth<=768){
      sidebar.classList.add('mobile-open');
      overlay.classList.add('visible');
      document.body.style.overflow='hidden';
    } else if(window.innerWidth<=1024){
      setCollapsed(!sidebar.classList.contains('collapsed'));
    }
    // Desktop: hamburger does nothing — hover handles expand/collapse
  };

  if(overlay) overlay.onclick=()=>{
    sidebar.classList.remove('mobile-open');
    overlay.classList.remove('visible');
    document.body.style.overflow='';
  };

  document.querySelectorAll('.nav a').forEach(a=>a.addEventListener('click',e=>{
    if(window.innerWidth<=768){
      sidebar.classList.remove('mobile-open');
      overlay.classList.remove('visible');
      document.body.style.overflow='';
    }
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
  _lbIndex=(state.media||[]).findIndex(x=>x.event_id===item.event_id);
  if(_lbIndex===-1) return;
  _lbItem=state.media[_lbIndex];
  _lbDeletePending=false;
  _lbResetToPhoto();
  const delBtn=byId('lightboxDelete');
  if(delBtn){delBtn.classList.remove('confirm-delete');delBtn.innerHTML=_LB_TRASH_HTML;delBtn.title=_lbItem.confirmed?'Bestätigt — trotzdem löschen?':'Löschen';}
  _updateLbConfirmBtn(_lbItem.confirmed);
  // Show video player for motion clips, image for snapshots
  const vidSrc=_lbItem.video_relpath?`/media/${_lbItem.video_relpath}`:(_lbItem.video_url||'');
  const imgSrc=_lbItem.snapshot_relpath?`/media/${_lbItem.snapshot_relpath}`:(_lbItem.snapshot_url||'');
  const hasVideoLabel=(_lbItem.labels||[]).some(l=>['motion','car','person','cat','bird','dog'].includes(l));
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
  byId('lightboxPrev').style.opacity=_lbIndex>0?'1':'0.2';
  byId('lightboxNext').style.opacity=_lbIndex<(state.media||[]).length-1?'1':'0.2';
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
function _lbNavList(){return _lbItem?.type==='timelapse'?_tlNavItems():(state.media||[]);}
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
// Swipe navigation on the lightbox media area (mobile)
(function initLightboxSwipe(){
  const wrap=byId('lightboxMediaWrap');
  if(!wrap) return;
  let _tx=0,_dragging=false;
  wrap.addEventListener('touchstart',e=>{
    if(e.touches.length!==1) return;
    _tx=e.touches[0].clientX;
    _dragging=true;
  },{passive:true});
  wrap.addEventListener('touchend',e=>{
    if(!_dragging) return;
    _dragging=false;
    const dx=e.changedTouches[0].clientX-_tx;
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
    _decrementMediaOverviewCount(camera_id);
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
function fmtMediaTime(ts){
  if(!ts) return '';
  try{
    const d=new Date(ts.replace(' ','T'));
    return d.toLocaleString('de-DE',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
  }catch{return ts;}
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
      <div class="mmc-meta-bar"><span>${fmtMediaTime(item.time||'')}</span></div>`;
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
const _MOC_ALL_SVG=`<svg width="140" height="88" viewBox="0 0 80 50" fill="none" aria-hidden="true"><rect x="1" y="1" width="34" height="21" rx="3.5" fill="#0d1522" stroke="#2a4460" stroke-width="1.3"/><rect x="45" y="1" width="34" height="21" rx="3.5" fill="#0d1522" stroke="#2a4460" stroke-width="1.3"/><rect x="1" y="28" width="34" height="21" rx="3.5" fill="#0d1522" stroke="#2a4460" stroke-width="1.3"/><rect x="45" y="28" width="34" height="21" rx="3.5" fill="#0d1522" stroke="#2a4460" stroke-width="1.3"/><circle cx="6" cy="6" r="2" fill="#2a4460"/><circle cx="50" cy="6" r="2" fill="#2a4460"/><circle cx="6" cy="33" r="2" fill="#2a4460"/><circle cx="50" cy="33" r="2" fill="#2a4460"/><!-- TL: timelapse hourglass (violet) --><line x1="9" y1="7.5" x2="25" y2="7.5" stroke="#c4b5fd" stroke-width="1.2" stroke-linecap="round" opacity=".9"/><polygon points="9,8.5 25,8.5 17,13" fill="#c4b5fd" opacity=".75"/><polygon points="17,13 9,17 25,17" fill="#c4b5fd" opacity=".5"/><line x1="9" y1="17.5" x2="25" y2="17.5" stroke="#c4b5fd" stroke-width="1.2" stroke-linecap="round" opacity=".9"/><!-- TR: running person / motion (blue) --><circle cx="64" cy="7" r="2" fill="#93c5fd" opacity=".8"/><path d="M63.5 9L61 14L59 19" stroke="#93c5fd" stroke-width="1.4" stroke-linecap="round" fill="none" opacity=".75"/><path d="M62 11L59.5 9.5" stroke="#93c5fd" stroke-width="1.2" stroke-linecap="round" opacity=".7"/><path d="M62 11L65 10.5" stroke="#93c5fd" stroke-width="1.2" stroke-linecap="round" opacity=".7"/><path d="M61 14L59 19" stroke="#93c5fd" stroke-width="1.4" stroke-linecap="round" opacity=".75"/><path d="M61 14L64 19" stroke="#93c5fd" stroke-width="1.4" stroke-linecap="round" opacity=".75"/><!-- BL: person detection (sky blue) --><circle cx="18" cy="34" r="2.8" fill="#60a5fa" opacity=".7"/><path d="M12 48C12 42 24 42 24 48" stroke="#60a5fa" stroke-width="1.5" stroke-linecap="round" fill="none" opacity=".65"/><!-- BR: object box (amber) --><rect x="57" y="34" width="14" height="10" rx="1.5" fill="#f59e0b" opacity=".55"/><rect x="59.5" y="31.5" width="5" height="3" rx="1" fill="#f59e0b" opacity=".45"/><!-- Center connector --><circle cx="40" cy="25" r="5.5" fill="#1a2a40" stroke="#3a5878" stroke-width="1.2"/><polygon points="38,22.5 44,25 38,27.5" fill="#4a7090"/></svg>`;
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
  const order=['person','cat','bird','car','dog'];
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

  // Category filter bar — full-width row above camera cards
  const _CAT_DEFS=[
    {label:'motion',    name:'Bewegung',  clr:CAT_COLORS.motion},
    {label:'person',    name:'Person',    clr:CAT_COLORS.person},
    {label:'cat',       name:'Katze',     clr:CAT_COLORS.cat},
    {label:'bird',      name:'Vogel',     clr:CAT_COLORS.bird},
    {label:'car',       name:'Auto',      clr:CAT_COLORS.car},
    {label:'dog',       name:'Hund',      clr:CAT_COLORS.dog},
    {label:'timelapse', name:'Timelapse', clr:CAT_COLORS.timelapse},
  ];
  const catBtns=_CAT_DEFS.map(({label,name,clr})=>{
    const icon=(label==='timelapse'?objIconSvg('timelapse',18):(OBJ_SVG[label]||'').replace('width="16" height="16"','width="18" height="18"'));
    return `<button class="cat-filter-btn" data-val="${esc(label)}" onclick="openCategoryDrilldown('${esc(label)}')" style="--cb:${clr}">
      <span class="cfb-icon">${icon}</span><span>${esc(name)}</span>
    </button>`;
  }).join('');
  const catSection=`<div class="moc-cat-section">
    <div class="moc-cat-bar">${catBtns}</div>
  </div>`;

  ov.innerHTML=catSection+`<div class="media-overview-grid">${allCard}${camCards}</div>`+archivedHtml;
}
window.openCategoryDrilldown=async function(label){
  state.mediaCamera=null;
  state.mediaLabels=new Set(label?[label]:[]);
  state.mediaPeriod='week'; state.mediaPage=0;
  syncMediaPills();
  byId('mediaOverview').style.display='none';
  byId('mediaDrilldown').style.display='';
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
  requestAnimationFrame(()=>{grid.style.transition='opacity .18s ease,transform .18s ease';grid.style.opacity='1';grid.style.transform='';});
  renderMediaPagination();
  window._openMediaItem=id=>{const item=items.find(x=>x.event_id===id); if(item) openLightbox(item);};
  // Refresh label-pill visibility against current data
  updateAvailableLabelPills();
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
async function openAllMediaDrilldown(){
  state.mediaCamera=null;
  state.mediaLabels=new Set(); state.mediaPeriod='week'; state.mediaPage=0;
  state.media=[]; state._allMedia=[];
  const grid=byId('mediaGrid');
  if(grid) grid.innerHTML='<div style="padding:32px;text-align:center;color:var(--muted)">Lade Medien…</div>';
  const pag=byId('mediaPagination'); if(pag) pag.innerHTML='';
  syncMediaPills();
  byId('mediaOverview').style.display='none';
  byId('mediaDrilldown').style.display='';
  _setActiveMocCard('__all__');
  await loadMedia();
  renderMediaGrid();
}
window.openAllMediaDrilldown=openAllMediaDrilldown;
async function openMediaDrilldown(camId){
  state.mediaCamera=camId;
  state.mediaLabels=new Set(); state.mediaPeriod='week'; state.mediaPage=0;
  // Clear stale state and grid immediately so the previous camera's thumbnails
  // don't flash before the new fetch resolves.
  state.media=[]; state._allMedia=[];
  const grid=byId('mediaGrid');
  if(grid) grid.innerHTML='<div style="padding:32px;text-align:center;color:var(--muted)">Lade Medien…</div>';
  const pag=byId('mediaPagination'); if(pag) pag.innerHTML='';
  syncMediaPills();
  byId('mediaOverview').style.display='none';
  byId('mediaDrilldown').style.display='';
  _setActiveMocCard(camId);
  await loadMedia();
  renderMediaGrid();
}
function closeMediaDrilldown(){
  state.mediaCamera=null; state.media=[];
  byId('mediaDrilldown').style.display='none';
  byId('mediaOverview').style.display='';
  _setActiveMocCard(null);
}
function syncMediaPills(){
  const labels=state.mediaLabels;
  document.querySelectorAll('.media-pill[data-type="label"]').forEach(p=>{
    const val=p.dataset.val;
    if(val==='') p.classList.toggle('active',labels.size===0);
    else p.classList.toggle('active',labels.has(val));
  });
  document.querySelectorAll('.media-pill[data-type="period"]').forEach(p=>{
    p.classList.toggle('active',p.dataset.val===state.mediaPeriod);
  });
}
(function initMediaPills(){
  document.querySelectorAll('.media-pill[data-label-key]').forEach(p=>{
    const key=p.dataset.labelKey;
    if(key&&OBJ_SVG[key]){
      p.innerHTML=`<span class="cfb-icon" style="pointer-events:none">${objIconSvg(key,18)}</span><span style="pointer-events:none">${OBJ_LABEL[key]||key}</span>`;
    }
  });
  document.querySelectorAll('.media-pill').forEach(p=>{
    p.addEventListener('click',()=>{
      if(p.dataset.type==='label'){
        const val=p.dataset.val;
        if(val===''){
          // "All" — clear all label filters
          state.mediaLabels=new Set();
        } else if(state.mediaLabels.has(val)){
          // Toggle off
          state.mediaLabels.delete(val);
        } else {
          // Toggle on (add to selection)
          state.mediaLabels.add(val);
        }
      } else {
        state.mediaPeriod=p.dataset.val;
      }
      state.mediaPage=0;
      syncMediaPills();
      // Reload whenever the drilldown is open, regardless of which camera is active
      if(byId('mediaDrilldown')?.style.display!=='none'){
        loadMedia().then(()=>{renderMediaGrid();renderMediaPagination();});
      }
    });
  });
  syncMediaPills();
})();
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
      _decrementMediaOverviewCount(camId);
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
function _decrementMediaOverviewCount(camId){
  const s=state.mediaStats.find(x=>x.camera_id===camId||x.id===camId);
  if(s){
    if(s.event_count>0) s.event_count--;
    if(s.jpg_count>0) s.jpg_count--;
  }
  renderMediaOverview();
}

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
'eichhoernchen_orange':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><path d="M 52 70 Q 72 58 70 34 Q 68 18 54 20 Q 40 22 44 40 Q 48 56 52 70Z" fill="#c04010"/><path d="M 52 70 Q 66 56 64 36 Q 62 24 54 26 Q 46 28 48 42 Q 50 58 52 70Z" fill="#b84416"/><ellipse cx="36" cy="60" rx="15" ry="11" fill="#b84416"/><circle cx="38" cy="42" r="14" fill="#b84416"/><circle cx="28" cy="29" r="7" fill="#b84416"/><circle cx="28" cy="29" r="4" fill="#cc5520"/><circle cx="44" cy="27" r="7" fill="#b84416"/><circle cx="44" cy="27" r="4" fill="#cc5520"/><circle cx="44" cy="39" r="3.5" fill="#111"/><circle cx="43" cy="38" r="1.2" fill="#fff"/><ellipse cx="48" cy="45" rx="5" ry="3.5" fill="#aa5515"/><circle cx="50" cy="44" r="1.5" fill="#333"/><ellipse cx="28" cy="68" rx="4" ry="7" fill="#7a2808"/><ellipse cx="38" cy="69" rx="4" ry="6" fill="#7a2808"/></svg>`,
'eichhoernchen_schwarz':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><path d="M 52 70 Q 72 58 70 34 Q 68 18 54 20 Q 40 22 44 40 Q 48 56 52 70Z" fill="#2a2a4a"/><path d="M 52 70 Q 66 56 64 36 Q 62 24 54 26 Q 46 28 48 42 Q 50 58 52 70Z" fill="#1a1a2e"/><ellipse cx="36" cy="60" rx="15" ry="11" fill="#1a1a2e"/><circle cx="38" cy="42" r="14" fill="#1a1a2e"/><circle cx="28" cy="29" r="7" fill="#1a1a2e"/><circle cx="28" cy="29" r="4" fill="#3a3a5e"/><circle cx="44" cy="27" r="7" fill="#1a1a2e"/><circle cx="44" cy="27" r="4" fill="#3a3a5e"/><circle cx="44" cy="39" r="3.5" fill="#ddd"/><circle cx="43" cy="38" r="1.2" fill="#fff"/><ellipse cx="48" cy="45" rx="5" ry="3.5" fill="#2a2a4a"/><circle cx="50" cy="44" r="1.5" fill="#555"/><ellipse cx="28" cy="68" rx="4" ry="7" fill="#111"/><ellipse cx="38" cy="69" rx="4" ry="6" fill="#111"/></svg>`,
'eichhoernchen_hell':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><path d="M 52 70 Q 72 58 70 34 Q 68 18 54 20 Q 40 22 44 40 Q 48 56 52 70Z" fill="#c4a878"/><path d="M 52 70 Q 66 56 64 36 Q 62 24 54 26 Q 46 28 48 42 Q 50 58 52 70Z" fill="#b49460"/><ellipse cx="36" cy="60" rx="15" ry="11" fill="#d4bea0"/><circle cx="38" cy="42" r="14" fill="#d4bea0"/><circle cx="28" cy="29" r="7" fill="#d4bea0"/><circle cx="28" cy="29" r="4" fill="#e0cca8"/><circle cx="44" cy="27" r="7" fill="#d4bea0"/><circle cx="44" cy="27" r="4" fill="#e0cca8"/><circle cx="44" cy="39" r="3.5" fill="#111"/><circle cx="43" cy="38" r="1.2" fill="#fff"/><ellipse cx="48" cy="45" rx="5" ry="3.5" fill="#c4b088"/><circle cx="50" cy="44" r="1.5" fill="#333"/><ellipse cx="28" cy="68" rx="4" ry="7" fill="#a08458"/><ellipse cx="38" cy="69" rx="4" ry="6" fill="#a08458"/></svg>`
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
  // Säugetiere
  {id:'eichhoernchen_orange',  name:'Eichhörnchen (rot)',     icon:'🐿️', cat:'mammals', freq:'haeufig',      rank:1},
  {id:'eichhoernchen_schwarz', name:'Eichhörnchen (schwarz)', icon:'🐿️', cat:'mammals', freq:'selten',       rank:2},
  {id:'eichhoernchen_hell',    name:'Eichhörnchen (hell)',    icon:'🐿️', cat:'mammals', freq:'selten',       rank:3},
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

function _medalSVG(achId, tier, birdSvg, isUnlocked){
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
    return `<svg viewBox="0 0 100 100" width="88" height="88" xmlns="http://www.w3.org/2000/svg">
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
  return `<svg viewBox="0 0 100 100" width="88" height="88" xmlns="http://www.w3.org/2000/svg">
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
    <span class="ach-progress-text">🌿 ${unlocked.length} von ${total} gesichtet</span>
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
    const iconSvg=a.cat==='birds'?(BIRD_SVGS[a.id]||null):(MAMMAL_SVGS[a.id]||null);
    const medalHtml=_medalSVG(a.id,tier,iconSvg,isUnlocked);
    const emojiOverlay=!iconSvg
      ?`<span class="medal-emoji${isUnlocked?'':' medal-emoji-locked'}">${isUnlocked?a.icon:'🔒'}</span>`
      :'';
    // When unlocked: count-badge on medal. When locked: lock badge ABOVE medal (overlapping top).
    const badge=isUnlocked
      ?`<span class="medal-count-badge ${tier}">${count}×</span>`
      :`<div class="medal-lock-overlay"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" stroke-width="2.2" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="3"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg></div>`;
    // Bottom row: count + plain muted-colour rarity text.
    const countColors={bronze:'#d4894a',silver:'#90a8be',gold:'#d4a820'};
    const rarityTxt=_rarityText(a.freq, isUnlocked);
    const countSpan=isUnlocked
      ?`<span class="medal-count" style="color:${countColors[tier]||'#d4a820'}">${count}× gesehen</span>`
      :'';
    const footline=`<div class="medal-footline">${countSpan}${rarityTxt}</div>`;
    // Split "Eichhörnchen (rot)" → base name + muted variant suffix
    const nameParts=a.name.match(/^(.+?)\s*(\(.+\))?$/);
    const baseName=nameParts?.[1]||a.name;
    const variantSuffix=nameParts?.[2]||'';
    const nameHtml=`${esc(baseName)}${variantSuffix?`<span style="font-size:10px;font-weight:400;color:rgba(255,255,255,0.3);font-style:italic;margin-left:3px">${esc(variantSuffix)}</span>`:''}`;
    const clickable=isUnlocked?`onclick="toggleAchDrilldown('${esc(a.id)}','${esc(a.name)}')" style="cursor:pointer"`:'';
    const activeCls = (isUnlocked && _achOpenId === a.id) ? ' ach-card--active' : '';
    return `<div class="ach-card ${tier}${activeCls}" ${clickable}>
      <div class="medal-wrap">
        ${medalHtml}
        ${emojiOverlay}
        ${badge}
      </div>
      <div class="medal-name">${nameHtml}</div>
      ${footline}
    </div>`;
  };

  // Single flat grid: birds first (by rank, 1 = most common), then
  // mammals (by rank). No sub-headings, no category dividers.
  const sorted = [...ACH_DEFS].sort((a,b)=>{
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
byId('confirmOk')?.addEventListener('click',()=>_resolveConfirm(true));
byId('confirmCancel')?.addEventListener('click',()=>_resolveConfirm(false));
byId('confirmModal')?.addEventListener('click',e=>{if(e.target===byId('confirmModal'))_resolveConfirm(false);});

// Inject random squirrel into hero on page load
(()=>{const sq=SQUIRREL_CHARS[Math.floor(Math.random()*SQUIRREL_CHARS.length)];const el=byId('heroSquirrel');if(el)el.innerHTML=sq;})();

// ── Statistics dashboard ──────────────────────────────────────────────────
const _STAT_LABEL_ICONS={motion:'👁',person:'🧍',cat:'🐈',bird:'🐦',car:'🚗',dog:'🐕',fox:'🦊',hedgehog:'🦔',squirrel:'🐿️',horse:'🐴'};
const _STAT_LABEL_COLORS={motion:'#36a2ff',person:'#ff6b6b',cat:'#9b8cff',bird:'#62d26f',car:'#00c2ff',dog:'#7c2d12',fox:'#ff7a1a',hedgehog:'#a67c52',squirrel:'#c8651a'};
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
  const maxCam=Math.max(1,...cameras.map(c=>camCounts[c.id]||0));

  const labelCounts={};
  allMonth.forEach(e=>(e.labels||[]).forEach(l=>{ labelCounts[l]=(labelCounts[l]||0)+1; }));
  const totalLabels=Object.values(labelCounts).reduce((a,b)=>a+b,0)||1;
  const top3=Object.entries(labelCounts).sort((a,b)=>b[1]-a[1]).slice(0,3);

  const hmData={};
  cameras.forEach(c=>{ hmData[c.id]=new Array(24).fill(0); });
  (dayData.tracks||[]).forEach(t=>{
    if(!hmData[t.camera_id]) hmData[t.camera_id]=new Array(24).fill(0);
    (t.points||[]).forEach(e=>{
      const h=new Date(e.time).getHours();
      if(h>=0&&h<24) hmData[t.camera_id][h]++;
    });
  });
  const hmMax=Math.max(1,...cameras.flatMap(c=>hmData[c.id]||[]));
  const hmHasData=cameras.some(c=>(hmData[c.id]||[]).some(v=>v>0));

  const periodPills=[['Heute',todayCount],['Diese Woche',weekCount],['Dieser Monat',monthCount]]
    .map(([label,count])=>`<div class="stat-period-pill"><div class="stat-period-num">${count}</div><div class="stat-period-label">${label}</div></div>`).join('');

  const camBars=cameras.length
    ?cameras.map(c=>{
      const cnt=camCounts[c.id]||0;
      const pct=Math.round(cnt/maxCam*100);
      const rowCls=STAT_MEDIA_DRILLDOWN?'stat-cam-bar-row stat-drillable':'stat-cam-bar-row';
      const rowClick=STAT_MEDIA_DRILLDOWN?`onclick="_statOpenMedia('${esc(c.id)}','')"`:'' ;
      return `<div class="${rowCls}" ${rowClick}>
        <div class="stat-cam-bar-name" title="${esc(c.name||c.id)}">${getCameraIcon(c.name||c.id)}&nbsp;${esc(c.name||c.id)}</div>
        <div class="stat-cam-bar-track"><div class="stat-cam-bar-fill" style="width:${pct}%"></div></div>
        <div class="stat-cam-bar-count">${cnt}</div>
      </div>`;}).join('')
    :'<div class="stat-empty">Keine Kameras</div>';

  const topLabels=top3.length
    ?top3.map(([label,cnt])=>{
      const pct=Math.round(cnt/totalLabels*100);
      // Pull colour + icon from the central tables so this list always
      // matches the rest of the UI. Wildlife species not in OBJ_SVG fall
      // back to the legacy emoji so they still render.
      const color=colors[label]||_STAT_LABEL_COLORS[label]||'var(--accent)';
      const icon=OBJ_SVG[label]?objIconSvg(label,18):(_STAT_LABEL_ICONS[label]||'🔍');
      const name=OBJ_LABEL[label]||label;
      const lblCls=STAT_MEDIA_DRILLDOWN?'stat-label-row stat-drillable':'stat-label-row';
      const lblClick=STAT_MEDIA_DRILLDOWN?`onclick="_statOpenMedia('','${esc(label)}')"`:'' ;
      return `<div class="${lblCls}" ${lblClick}>
        <div class="stat-label-icon">${icon}</div>
        <div class="stat-label-info">
          <div class="stat-label-name">${esc(name)}</div>
          <div class="stat-label-bar-wrap"><div class="stat-label-bar" style="width:${pct}%;background:${color}"></div></div>
        </div>
        <div class="stat-label-meta">${cnt}&thinsp;·&thinsp;${pct}%</div>
      </div>`;}).join('')
    :'<div class="stat-empty">Keine Erkennungen</div>';

  const heatmap=hmHasData
    ?`<div class="stat-heatmap-wrap"><div class="stat-hm-grid">
        <div class="stat-hm-header">
          <div class="stat-hm-cam-col"></div>
          <div class="stat-hm-hours">${Array.from({length:24},(_,h)=>`<div class="stat-hm-hlabel">${h}</div>`).join('')}</div>
        </div>
        ${cameras.map(c=>{
          const hours=hmData[c.id]||new Array(24).fill(0);
          const hmCamCls=STAT_MEDIA_DRILLDOWN?'stat-hm-cam stat-drillable':'stat-hm-cam';
          const hmCamClick=STAT_MEDIA_DRILLDOWN?`onclick="_statOpenMedia('${esc(c.id)}','')"`:'' ;
          return `<div class="stat-hm-row">
            <div class="${hmCamCls}" title="${esc(c.name||c.id)}" ${hmCamClick}>${getCameraIcon(c.name||c.id)}&nbsp;${esc(c.name||c.id)}</div>
            <div class="stat-hm-cells">${hours.map((cnt,h)=>{
              const alpha=cnt===0?0.12:Math.max(0.25,0.15+cnt/hmMax*0.8);
              const bg=cnt===0?'rgba(41,48,74,0.5)':`rgba(59,130,246,${alpha.toFixed(2)})`;
              const h0=String(h).padStart(2,'0');
              const h1=String(h+1).padStart(2,'0');
              return `<div class="stat-hm-cell" style="background:${bg}" data-tip="${h0}:00–${h1}:00 · ${cnt} Events"></div>`;
            }).join('')}</div>
          </div>`;}).join('')}
      </div></div>`
    :'<div class="stat-empty">Keine Ereignisse in den letzten 24h</div>';

  // 1–3: overview + per-camera + top detections
  content.innerHTML=`
    <div class="stat-period-row">${periodPills}</div>
    <div class="stat-split">
      <div class="stat-card"><div class="stat-card-title">Events pro Kamera · letzter Monat</div>${camBars}</div>
      <div class="stat-card"><div class="stat-card-title">Top Erkennungen · letzter Monat</div>${topLabels}</div>
    </div>`;

  // 5: last 24h heatmap — rendered after the static timeline block (#4)
  const hmBlock=byId('statHeatmapBlock');
  if(hmBlock) hmBlock.innerHTML=`<div class="stat-card" style="margin-top:0"><div class="stat-card-title">Letzte 24h · Aktivität nach Stunde</div>${heatmap}</div>`;

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
