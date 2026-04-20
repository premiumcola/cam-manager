
const state={config:null,cameras:[],groups:[],timeline:null,media:[],_allMedia:[],camera:'',label:'',period:'week',bootstrap:null,mediaCamera:null,mediaStats:[],mediaLabels:new Set(),mediaPeriod:'week',tlHours:168,mediaPage:0,mediaTotalPages:1,_tlInitialized:false};
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
const colors={person:'#7c4dff',cat:'#e91e8c',bird:'#0ea5e9',car:'#f59e0b',motion:'#93c5fd',alarm:'#ef4444',unknown:'#4a6477',timelapse:'#c4b5fd',motion_objects:'#818cf8'};
const OBJ_LABEL={person:'Person',cat:'Katze',bird:'Vogel',car:'Auto',motion:'Bewegung',alarm:'Alarm',timelapse:'Timelapse',motion_objects:'Motion · Objekte'};
const OBJ_SVG={
  // Person: head circle + body arc — clean silhouette, purple
  person:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="7" r="4.5" fill="#7c4dff"/><path d="M4 22c0-4.4 3.6-8 8-8s8 3.6 8 8" stroke="#7c4dff" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>`,
  // Cat: round face with ear triangles and dot eyes — clear face, pink
  cat:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><polygon points="5,11 2,4 9.5,9" fill="#e91e8c"/><polygon points="19,11 22,4 14.5,9" fill="#e91e8c"/><circle cx="12" cy="15" r="7" fill="#e91e8c"/><circle cx="9" cy="14.5" r="1.6" fill="#fff" opacity=".9"/><circle cx="15" cy="14.5" r="1.6" fill="#fff" opacity=".9"/><circle cx="9" cy="14.5" r=".7" fill="#c0175e"/><circle cx="15" cy="14.5" r=".7" fill="#c0175e"/><path d="M10 18q2 1.5 4 0" stroke="#fff" stroke-width="1.2" stroke-linecap="round" fill="none" opacity=".75"/></svg>`,
  // Bird: spread wings (M-shape) + oval body + round head — clear flight silhouette, blue
  bird:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M2 12C5.5 7 9.5 9 12 13C14.5 9 18.5 7 22 12" fill="#0ea5e9"/><ellipse cx="12" cy="15.5" rx="3.5" ry="2.5" fill="#0ea5e9"/><circle cx="17.5" cy="10.5" r="2" fill="#0ea5e9"/><circle cx="18.5" cy="10" r=".85" fill="#fff" opacity=".9"/><path d="M12 18v3" stroke="#0ea5e9" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  // Car: body + cab + wheels — amber, clear vehicle shape
  car:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="2" y="11" width="20" height="8" rx="2.5" fill="#f59e0b"/><rect x="6" y="7" width="11" height="5" rx="2" fill="#fbbf24"/><circle cx="7" cy="20" r="2.5" fill="#92400e"/><circle cx="17" cy="20" r="2.5" fill="#92400e"/><circle cx="7" cy="20" r="1.2" fill="#f59e0b"/><circle cx="17" cy="20" r="1.2" fill="#f59e0b"/><rect x="14.5" y="8" width="3" height="3.5" rx=".75" fill="rgba(0,0,0,.2)"/></svg>`,
  // Motion: horizontal sine wave 1.5 periods — light blue
  motion:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M1 12 C4 5 7 5 9 12 C11 19 14 19 16 12 C18 5 21 5 23 12" stroke="#93c5fd" stroke-width="2.5" stroke-linecap="round" fill="none"/></svg>`,
  // Alarm: bell body + clapper dot + handle — red, classic bell shape
  alarm:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 3C7 3 4 7.5 4 12C4 17 7 19 7 19H17C17 19 20 17 20 12C20 7.5 17 3 12 3Z" fill="#ef4444"/><rect x="11" y="19" width="2" height="2.5" rx=".75" fill="#ef4444"/><rect x="9.5" y="21.5" width="5" height="1.5" rx=".75" fill="#ef4444"/><rect x="11.2" y="8" width="1.6" height="5.5" rx=".75" fill="#fff"/><circle cx="12" cy="15.5" r="1.1" fill="#fff"/></svg>`,
  // Timelapse: hourglass — top bar + filled top triangle + empty bottom triangle + bottom bar, purple
  timelapse:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="4.5" y="2" width="15" height="2.5" rx="1.2" fill="#c4b5fd"/><path d="M5.5 4.5L12 13L18.5 4.5Z" fill="#c4b5fd" opacity=".75"/><path d="M5.5 19.5L12 11L18.5 19.5Z" stroke="#c4b5fd" stroke-width="1.5" stroke-linejoin="round" fill="none"/><rect x="4.5" y="19.5" width="15" height="2.5" rx="1.2" fill="#c4b5fd"/></svg>`,
  // Motion+Objects: left sine wave + center divider + right wireframe 3D box — blue/indigo split
  motion_objects:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M1 12 C2.5 7.5 4.5 7.5 6 12 C7.5 16.5 9.5 16.5 11 12" stroke="#93c5fd" stroke-width="1.8" stroke-linecap="round" fill="none"/><line x1="12.5" y1="5" x2="12.5" y2="19" stroke="#a5b4fc" stroke-width=".8" stroke-linecap="round"/><rect x="14.5" y="9.5" width="6" height="6" stroke="#818cf8" stroke-width="1.4" fill="none"/><path d="M14.5 9.5L16.5 7L22.5 7L22.5 13.5" stroke="#818cf8" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/><line x1="20.5" y1="9.5" x2="22.5" y2="7" stroke="#818cf8" stroke-width="1.4" stroke-linecap="round"/><line x1="20.5" y1="15.5" x2="22.5" y2="13.5" stroke="#818cf8" stroke-width="1.4" stroke-linecap="round"/></svg>`
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
const TL_LABELS=['person','cat','bird','car','motion','alarm'];
function _renderLbLabels(){
  const el=byId('lightboxLabels');
  if(!el||!_lbItem) return;
  const active=new Set(_lbItem.labels||[]);
  el.innerHTML=TL_LABELS.map(l=>{
    const isActive=active.has(l);
    const rawSvg=OBJ_SVG[l]||OBJ_SVG.alarm;
    const svg=rawSvg.replace('width="16" height="16"','width="38" height="38"');
    const title=OBJ_LABEL[l]||l;
    const c=colors[l]||colors.unknown;
    return `<span data-label="${l}" title="${title}" style="width:54px;height:54px;border-radius:50%;background:${isActive?c+'30':'rgba(0,0,0,0.60)'};box-shadow:0 1px 8px rgba(0,0,0,0.55);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;cursor:pointer;transition:background .15s,opacity .15s,border-color .15s;opacity:${isActive?'1':'0.6'};border:2px solid ${isActive?c+'cc':'rgba(255,255,255,0.08)'}">${svg}</span>`;
  }).join('');
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
          const idx=(state.media||[]).findIndex(x=>x.event_id===_lbItem.event_id);
          if(idx>=0) state.media[idx].labels=res.labels;
          _renderLbLabels();
          // sync thumbnail in media grid
          const thumbCard=byId('mediaGrid')?.querySelector(`[data-event-id="${CSS.escape(_lbItem.event_id)}"]`);
          if(thumbCard){const bubblesEl=thumbCard.querySelector('.media-label-bubbles');if(bubblesEl) bubblesEl.innerHTML=res.labels.slice(0,3).map(l=>objBubble(l,26)).join('');}
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
function startPreviewRefresh(){
  if(_previewRefreshInterval) clearInterval(_previewRefreshInterval);
  _previewRefreshInterval=setInterval(()=>{
    if(document.hidden) return; // don't burn requests when tab is backgrounded
    const grid=byId('cameraCards');
    if(!grid) return;
    grid.querySelectorAll('.cv-img.loaded').forEach(img=>{
      const base=img.src.split('?')[0];
      img.src=base+'?t='+Date.now();
    });
  },200); // 5fps
}

function startLiveUpdate(){
  if(_liveUpdateInterval) clearInterval(_liveUpdateInterval);
  state.cameras.forEach(c=>_prevCamStatuses.set(c.id,c.status));
  _liveUpdateInterval=setInterval(async()=>{
    try{
      const r=await j('/api/cameras');
      (r.cameras||[]).forEach(c=>{
        const prev=_prevCamStatuses.get(c.id);
        _prevCamStatuses.set(c.id,c.status);
        if(prev!==c.status){
          // Show squirrel whenever camera starts reconnecting
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
            // Update measured FPS display in pill
            const fpsEl=livePill.querySelector('.cv-lp-fps-val');
            if(fpsEl) fpsEl.textContent=(c.preview_fps||0)>0?(c.preview_fps+' fps'):'—';
            // Update stream mode badge
            const modeEl=livePill.querySelector('.cv-stream-mode');
            if(modeEl){
              const mode=c.stream_mode||'baseline';
              modeEl.textContent=mode==='live'?'● Live':'○ Vorschau';
              modeEl.className='cv-stream-mode '+(mode==='live'?'cv-mode-live':'cv-mode-base');
            }
          }
        }
      });
    }catch{/* silent */}
  },3000);
  ['liveIndicator'].forEach(id=>{const el=byId(id);if(el)el.classList.remove('hidden');});
}

async function loadAll(){
  _restoreEditWrapper();
  state.bootstrap=await j('/api/bootstrap');
  state.config=await j('/api/config');
  state.groups=(await j('/api/groups')).groups||[];
  state.cameras=(await j('/api/cameras')).cameras||[];
  state.timeline=await j(`/api/timeline?hours=${state.tlHours||168}${state.label?`&label=${encodeURIComponent(state.label)}`:''}`);
  await loadMediaStorageStats();
  renderShell();
  renderDashboard();
  renderTimeline();
  renderGroups();
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
function calcItemsPerPage(){
  const GAP=10,MIN_CARD=160;
  const grid=byId('mediaGrid');
  let containerW=0,cardW=0;
  if(grid){
    const gr=grid.getBoundingClientRect();
    if(gr.width>MIN_CARD) containerW=gr.width;
    const firstCard=grid.querySelector('.media-card');
    if(firstCard) cardW=firstCard.getBoundingClientRect().width;
  }
  if(!containerW){
    const isMobile=window.innerWidth<=768;
    const mediaEl=byId('media');
    let w=mediaEl&&mediaEl.clientWidth>MIN_CARD?mediaEl.clientWidth-24:window.innerWidth-(isMobile?24:320);
    containerW=Math.max(MIN_CARD+1,w);
  }
  const cols=cardW>0?Math.max(1,Math.floor(containerW/cardW)):Math.max(1,Math.floor((containerW+GAP)/(MIN_CARD+GAP)));
  const rowSlider=byId('mediaRowSlider');
  const rows=rowSlider?Math.max(2,Math.min(8,parseInt(rowSlider.value)||4)):4;
  return rows*cols;
}
let _cachedPageSize=0;
async function loadMedia(){
  // Timelapse-only shortcut: no API call needed, renderMediaGrid uses window._tlItems
  const labels=state.mediaLabels;
  const onlyTL=labels.size===1&&labels.has('timelapse');
  if(onlyTL){state.media=[];state._allMedia=[];state.mediaTotalPages=1;return;}
  const ps=calcItemsPerPage(); _cachedPageSize=ps;
  const cams=state.mediaCamera?[state.mediaCamera]:state.cameras.map(c=>c.id);
  const periodParams=_mediaPeriodParams();
  // Build label filter param — exclude 'timelapse' (handled separately in grid)
  const motionLabels=[...labels].filter(l=>l!=='timelapse');
  const labelParam=motionLabels.length===1?`&label=${encodeURIComponent(motionLabels[0])}`
    :motionLabels.length>1?`&labels=${encodeURIComponent(motionLabels.join(','))}`:'';
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
  byId('appTagline').textContent=state.config.app.tagline||'Schlicht, funktional, analytisch';
  byId('groupSelect').innerHTML=state.groups.map(g=>`<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
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
  const shieldSm=`<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M12 2 4 5v6c0 5.3 3.5 10.2 8 11.4 4.5-1.2 8-6.1 8-11.4V5Z"/></svg>`;
  const shieldMd=`<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 2 4 5v6c0 5.3 3.5 10.2 8 11.4 4.5-1.2 8-6.1 8-11.4V5Z"/></svg>`;
  const pencil=`<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>`;
  const playIcon=`<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><polygon points="5,3 19,12 5,21"/></svg>`;
  byId('cameraCards').innerHTML=cams.map(c=>{
    const snapUrl=`/api/camera/${esc(c.id)}/snapshot.jpg?t=${Date.now()}`;
    const isActive=c.status==='active';
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

    // Timelapse filmstrip icon with bars + optional scan line
    const barCol=tlOn?'#d8b4fe':'rgba(255,255,255,.18)';
    const tlIcon=`<div class="cv-tl-icon"><div class="cv-tl-bar" style="background:${barCol}"></div><div class="cv-tl-bar hi" style="background:${barCol}"></div><div class="cv-tl-bar" style="background:${barCol}"></div><div class="cv-tl-bar hi" style="background:${barCol}"></div>${tlOn?'<div class="cv-tl-scan"></div>':''}</div>`;

    return `<article class="cv-card" data-camid="${esc(c.id)}" onclick="_cvCardClick(event,'${esc(c.id)}')">
  <div class="cv-frame">
    <div class="cv-img-wrap">
      <div class="cv-loading-placeholder">${!isActive?_makeSquirrelHTML():'<div class="cv-loading-icon">⟳</div><div class="cv-loading-text">Verbinde…</div>'}</div>
      <img class="cv-img cam-snap" src="${snapUrl}" alt="${esc(c.name)}"
        onload="this.classList.add('loaded');this.previousElementSibling.style.display='none'"
        onerror="_camImgRetry(this)" />
    </div>
    <div class="cv-grad-top"></div>
    <div class="cv-grad-bot"></div>

    <!-- top-left: name + group -->
    <div class="cv-title-wrap">
      <div class="cv-name">${esc(c.name)}</div>
      ${c.location?`<div class="cv-loc">${esc(c.location)}</div>`:''}
      <span class="cv-group-pill">${esc(c.group_id||'—')}</span>
    </div>

    <!-- top-right: live pill + alarm pill -->
    <div class="cv-tr">
      <div class="cv-pill-live-wrap ${isActive?'cv-live-active':'cv-live-off'}">
        <div class="cv-live-collapsed">
          <div class="cv-pdot"></div>
          <span>Live</span>
          ${previewFps?`<span class="cv-fps-badge">${previewFps}</span>`:''}
        </div>
        <div class="cv-live-expanded">
          <div class="cv-live-exp-header">
            <div class="cv-pdot"></div>
            <span>Livestream ${isActive?'aktiv':'inaktiv'}</span>
          </div>
          <div class="cv-lp-row"><span>Stream-Modus</span><strong class="cv-stream-mode ${streamMode==='live'?'cv-mode-live':'cv-mode-base'}">${streamMode==='live'?'● Live':'○ Vorschau'}</strong></div>
          <div class="cv-lp-row"><span>Preview-FPS<br><small>Gemessen (Sub-Stream)</small></span><strong class="cv-lp-fps-val">${previewFps!=null?previewFps+' fps':'—'}</strong></div>
          <div class="cv-lp-row"><span>Auflösung</span><strong>${esc(c.preview_resolution||c.resolution||'—')}</strong></div>
          <div class="cv-lp-row"><span>Analyse-Framerate<br><small>Wie oft TAM-spy analysiert</small></span><strong>${fps!=null?fps+' fps':'—'}</strong></div>
        </div>
      </div>
      <div class="cv-pill ${c.armed?'cv-pill-alarm-on':'cv-pill-alarm-off'}">${shieldSm}${c.armed?'Alarm an':'Alarm aus'}</div>
    </div>

    <!-- bottom-left: always-visible icon bubbles (hides on hover) -->
    <div class="cv-bl">
      ${tlOn?`<span style="width:24px;height:24px;border-radius:8px;background:#c4b5fd20;border:1.5px solid #c4b5fd50;backdrop-filter:blur(3px);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${objIconSvg('timelapse',15)}</span>`:''}
      ${(isActive||c.coral_available)?`<span style="padding:3px 7px;border-radius:18px;background:#818cf820;border:1.5px solid #818cf840;backdrop-filter:blur(3px);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${objIconSvg('motion_objects',15)}</span>`:''}
    </div>
    <!-- bottom-right: timelapse + motion·objects chips -->
    <div class="cv-br">
      <div class="cv-pill ${tlOn?'cv-pill-tl':'cv-pill-tl-off'}">${objIconSvg('timelapse',13)}Timelapse${tlOn?' aktiv':' aus'}</div>
      <div class="cv-pill" style="${(isActive||c.coral_available)?'background:rgba(129,140,248,.18);border:1.5px solid rgba(129,140,248,.5);color:#e0e7ff':'background:rgba(255,255,255,.1);border:1.5px solid rgba(255,255,255,.2);color:rgba(255,255,255,.4)'}">${objIconSvg('motion_objects',13)}<span>Motion · Objekte</span></div>
    </div>

    <!-- bottom: hover action buttons (icon + label) -->
    <div class="cv-actions">
      <button class="cv-abt cv-abt-live" onclick="event.stopPropagation();openLiveView('${esc(c.id)}','${esc(c.name)}')">${playIcon}<span>Live</span></button>
      <button class="cv-abt cv-abt-edit" onclick="event.stopPropagation();editCamera('${esc(c.id)}')">${pencil}<span>Einstellungen</span></button>
      <button class="cv-abt ${c.armed?'cv-abt-arm-on':'cv-abt-arm-off'}" onclick="event.stopPropagation();toggleArm('${esc(c.id)}',${!c.armed})">${shieldMd}<span>${c.armed?'Alarm aus':'Alarm an'}</span></button>
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
const CAT_COLORS={alle:'#8888aa',motion:'#93c5fd',person:'#a855f7',cat:'#ec4899',bird:'#06b6d4',car:'#f59e0b',timelapse:'#c4b5fd'};
const TL_LANES=['person','cat','bird','car','motion'];
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

  // Legend as filter pills (TASK 5) — render before tracks so pills are always visible
  const leg=byId('tlLegend');
  if(leg){
    leg.innerHTML=`<span class="tl-leg-prefix">Filter:</span>`+
      TL_LANES.map(l=>`<button class="cat-filter-btn${_tlActiveLanes.has(l)?' active':''}" data-lane="${l}" style="--cb:${CAT_COLORS[l]||'#8888aa'}"><span class="cfb-icon">${objIconSvg(l,18)}</span><span>${OBJ_LABEL[l]||l}</span></button>`).join('');
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
    if(!ip){f['rtsp_url'].value='';return;}
    const auth=user?(user+(pass?':'+_rtspEnc(pass):'')+'@'):'';
    const portPart=port&&port!=='554'?':'+port:'';
    f['rtsp_url'].value=`rtsp://${auth}${ip}${portPart}${path}`;
    // auto-fill snapshot if empty
    if(!f['snapshot_url']?.value && user)
      f['snapshot_url'].value=`http://${user}:${_rtspEnc(pass)}@${ip}/cgi-bin/snapshot.cgi`;
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
  byId('cameraSettingsList').innerHTML=state.cameras.map(c=>`
    <div class="cam-item" data-camid="${esc(c.id)}">
      <div class="cam-item-head" style="cursor:pointer" onclick="editCamera('${esc(c.id)}')">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:22px;line-height:1;flex-shrink:0">${getCameraIcon(c.name)}</span>
          <div>
            <div style="font-weight:700;font-size:15px">${esc(c.name)}</div>
            <div class="small muted">${esc(c.group_id||'—')}</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center" onclick="event.stopPropagation()">
          <span class="io-switch${c.enabled?' on':''}"
            onclick="toggleCameraEnabled('${esc(c.id)}',${!c.enabled})"
            title="${c.enabled?'Aktiv · klicken zum Deaktivieren':'Inaktiv · klicken zum Aktivieren'}">
            <span class="io-lbl io-lbl-0">0</span>
            <span class="io-track"><span class="io-thumb"></span></span>
            <span class="io-lbl io-lbl-1">1</span>
          </span>
          <button class="btn-reconnect" title="Neu verbinden" onclick="event.stopPropagation();_reconnectCam('${esc(c.id)}',this)">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2.5 8A5.5 5.5 0 0 1 13 5M13.5 8A5.5 5.5 0 0 1 3 11"/>
              <polyline points="12,2 12,5.5 8.5,5.5"/>
              <polyline points="4,14 4,10.5 7.5,10.5"/>
            </svg>
            Verbinden
          </button>
          <button class="btn-cam-delete" title="Kamera löschen" onclick="event.stopPropagation();_quickDeleteCamera('${esc(c.id)}','${esc(c.name)}')">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="2,4 14,4"/><path d="M5 4V2h6v2"/><path d="M3 4l1 10h8l1-10"/>
              <line x1="6.5" y1="7" x2="6.5" y2="11"/><line x1="9.5" y1="7" x2="9.5" y2="11"/>
            </svg>
          </button>
        </div>
      </div>
    </div>`).join('');
}
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
  f['motion_sensitivity']?.addEventListener('input',()=>{ byId('motionSensLabel').textContent=f['motion_sensitivity'].value; });
  // Frame interval slider
  f['frame_interval_ms']?.addEventListener('input',()=>{ byId('frameIntervalLabel').textContent=f['frame_interval_ms'].value+'ms'; });
  // Snapshot interval slider
  f['snapshot_interval_s']?.addEventListener('input',()=>{ byId('snapshotIntervalLabel').textContent=f['snapshot_interval_s'].value+'s'; });
}

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
  f['snapshot_url'].value=c.snapshot_url||''; f['group_id'].value=c.group_id||'';
  f['object_filter'].value=(c.object_filter||[]).join(',');
  if(f['enabled']) f['enabled'].checked=!!c.enabled; f['armed'].checked=!!c.armed;
  f['schedule_start'].value=(c.schedule&&c.schedule.start)||''; f['schedule_end'].value=(c.schedule&&c.schedule.end)||''; f['schedule_enabled'].checked=!!(c.schedule&&c.schedule.enabled);
  if(f['telegram_enabled']) f['telegram_enabled'].checked=(c.telegram_enabled!==false);
  if(f['mqtt_enabled']) f['mqtt_enabled'].checked=(c.mqtt_enabled!==false);
  if(f['bottom_crop_px']) f['bottom_crop_px'].value=c.bottom_crop_px||0;
  if(f['motion_sensitivity']){const ms=c.motion_sensitivity!=null?c.motion_sensitivity:0.5; f['motion_sensitivity'].value=ms; byId('motionSensLabel').textContent=ms;}
  if(f['resolution']) f['resolution'].value=c.resolution||'auto';
  if(f['frame_interval_ms']){const fi=c.frame_interval_ms||350; f['frame_interval_ms'].value=fi; byId('frameIntervalLabel').textContent=fi+'ms';}
  if(f['snapshot_interval_s']){const si=c.snapshot_interval_s||3; f['snapshot_interval_s'].value=si; byId('snapshotIntervalLabel').textContent=si+'s';}
  _whitelistState=[...(c.whitelist_names||[])]; _updateWhitelistHidden();
  shapeState.camera=camId; shapeState.zones=JSON.parse(JSON.stringify(c.zones||[])); shapeState.masks=JSON.parse(JSON.stringify(c.masks||[])); shapeState.points=[];
  f['zones_json'].value=JSON.stringify(shapeState.zones); f['masks_json'].value=JSON.stringify(shapeState.masks);
  byId('deleteCameraBtn').dataset.camId=camId;
  loadMaskSnapshot(camId); drawShapes();
  // Slide down inside the clicked camera card
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
    panel.style.display='';
  }catch(e){/* no diagnostics available — stay hidden */}
}
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

function renderGroups(){
  const groups=state.groups||[];
  const grpList=byId('groupList'); if(!grpList) return;
  if(!groups.length){
    grpList.innerHTML='<div class="small muted" style="padding:8px 2px">Noch keine Gruppen.</div>';
    return;
  }
  const tabs=groups.map((g,i)=>`<button type="button" class="sec-tab-btn${i===0?' active':''}" id="grpTab_${esc(g.id)}" onclick="selectGroup('${esc(g.id)}')">${esc(g.name)}</button>`).join('');
  grpList.innerHTML=`<div class="sec-tabs" id="grpTabs" style="margin-bottom:0">${tabs}</div><div class="sec-content" id="grpContent"></div>`;
  _renderGroupContent(groups[0]);
}
function _renderGroupContent(g){
  const content=byId('grpContent'); if(!content) return;
  const s=g.schedule||{};
  const isNew=!g.id;
  const active=new Set(g.coarse_objects||[]);
  const fm=new Set(g.fine_models||[]);
  const pills=_GRP_COARSE.map(obj=>{
    const on=active.has(obj);
    return `<button type="button" class="grp-obj-pill${on?' active':''}" data-obj="${obj}"
      style="padding:7px 14px;border-radius:999px;border:none;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;gap:6px;background:${on?'var(--accent)':'var(--surface)'};color:${on?'#fff':'var(--muted)'}">${objBubble(obj,18)} ${OBJ_LABEL[obj]||obj}</button>`;
  }).join('');
  content.innerHTML=`<form class="group-edit-grid" onsubmit="saveGroup(event)" style="padding-top:4px">
    <input type="hidden" name="id" value="${esc(g.id||'')}" />
    <div style="grid-column:1/-1">
      <input name="name" value="${esc(g.name||'')}" placeholder="Anzeigename" required style="${_GRP_INPUT}"
        oninput="(()=>{const f=this.closest('form');const el=f.querySelector('.grp-gen-id');if(el&&!f.elements['id'].value)el.textContent='ID: '+_groupGenId(this.value);})()"/>
      <div class="grp-gen-id small muted" style="margin-top:4px;padding-left:4px">${isNew?'ID: auto':'ID: '+esc(g.id)}</div>
    </div>
    <div><select name="category" style="${_GRP_SELECT}">${_GRP_CATS.map(c=>`<option${g.category===c?' selected':''}>${esc(c)}</option>`).join('')}</select><span class="field-label">Kategorie</span></div>
    <div><select name="alarm_profile" style="${_GRP_SELECT}">${['hard','medium','soft','info'].map(p=>`<option${g.alarm_profile===p?' selected':''}>${p}</option>`).join('')}</select><span class="field-label">Alarmprofil</span></div>
    <div style="grid-column:1/-1">
      <div class="grp-obj-pills" style="display:flex;gap:8px;flex-wrap:wrap">${pills}</div>
      <input type="hidden" name="coarse_objects" value="${esc((g.coarse_objects||[]).join(','))}" />
      <span class="field-label" style="margin-top:6px;display:block">Grob-Objekte</span>
    </div>
    <div style="grid-column:1/-1;display:flex;gap:20px;align-items:center;flex-wrap:wrap;padding:4px 0">
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer"><input type="checkbox" name="fm_bird"${fm.has('bird_species')?' checked':''} style="width:auto;accent-color:var(--accent)" /> Vogelarten</label>
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer"><input type="checkbox" name="fm_cat"${fm.has('cat_identity')?' checked':''} style="width:auto;accent-color:var(--accent)" /> Katzen-ID</label>
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer"><input type="checkbox" name="fm_person"${fm.has('person_identity')?' checked':''} style="width:auto;accent-color:var(--accent)" /> Personen-ID</label>
      <span class="field-label" style="margin-left:auto">Fine-Models</span>
    </div>
    <div style="grid-column:1/-1;display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-height:44px">
      <label class="switch"><input type="checkbox" name="schedule_enabled"${s.enabled?' checked':''}
        onchange="this.closest('form').querySelector('.grp-sched-times').style.display=this.checked?'flex':'none'" /><span class="slider"></span></label>
      <span style="font-size:13px;font-weight:600">Zeitplan</span>
      <div class="grp-sched-times" style="display:${s.enabled?'flex':'none'};align-items:center;gap:8px">
        ${_groupTimeSelect('schedule_start',s.start||'22:00')}
        <span class="muted" style="font-size:13px">→</span>
        ${_groupTimeSelect('schedule_end',s.end||'06:00')}
      </div>
    </div>
    <div style="grid-column:1/-1">
      <button type="submit" style="width:100%;min-height:42px;background:var(--accent);color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer">Gruppe speichern</button>
    </div>
  </form>`;
  _wireGroupPills(content.querySelector('form'));
}
window.selectGroup=function(groupId){
  document.querySelectorAll('#grpTabs .sec-tab-btn').forEach(b=>b.classList.toggle('active',b.id===`grpTab_${groupId}`));
  const g=(state.groups||[]).find(g=>g.id===groupId);
  if(g) _renderGroupContent(g);
};

const _GRP_COARSE=['person','cat','bird','car','motion'];
// _GRP_ICONS replaced by OBJ_SVG + OBJ_LABEL
const _GRP_CATS=['Sicherheit','Bereichsübersicht','Tierbeobachtung','Eingangskamera','Sonstiges'];
function _groupGenId(name){
  return name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
}
function _groupTimeOpts(sel){
  let s='';for(let h=0;h<24;h++)for(let m of[0,30]){const v=String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');s+=`<option${v===sel?' selected':''}>${v}</option>`;}return s;
}
function _groupTimeSelect(name,val){
  return `<select name="${name}" style="background:var(--surface);color:var(--text);border:none;border-radius:10px;padding:7px 10px;font:inherit;font-size:13px">${_groupTimeOpts(val)}</select>`;
}
const _GRP_INPUT='background:var(--surface);color:var(--text);border:none;border-radius:10px;padding:9px 12px;width:100%;font:inherit;box-sizing:border-box';
const _GRP_SELECT='background:var(--surface);color:var(--text);border:none;border-radius:10px;padding:9px 12px;width:100%;font:inherit';
function groupEditHTML(g){
  const s=g.schedule||{};
  const isNew=!g.id;
  const active=new Set(g.coarse_objects||[]);
  const fm=new Set(g.fine_models||[]);
  const pills=_GRP_COARSE.map(obj=>{
    const on=active.has(obj);
    return `<button type="button" class="grp-obj-pill${on?' active':''}" data-obj="${obj}"
      style="padding:7px 14px;border-radius:999px;border:none;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;gap:6px;background:${on?'var(--accent)':'var(--surface)'};color:${on?'#fff':'var(--muted)'}">${objBubble(obj,18)} ${OBJ_LABEL[obj]||obj}</button>`;
  }).join('');
  return `<div class="group-inline"><form class="group-edit-grid" onsubmit="saveGroup(event)">
    <input type="hidden" name="id" value="${esc(g.id||'')}" />
    <div style="grid-column:1/-1">
      <input name="name" value="${esc(g.name||'')}" placeholder="Anzeigename" required style="${_GRP_INPUT}"
        oninput="(()=>{const f=this.closest('form');const el=f.querySelector('.grp-gen-id');if(el&&!f.elements['id'].value)el.textContent='ID: '+_groupGenId(this.value);})()"/>
      <div class="grp-gen-id small muted" style="margin-top:4px;padding-left:4px">${isNew?'ID: auto':'ID: '+esc(g.id)}</div>
    </div>
    <div><select name="category" style="${_GRP_SELECT}">${_GRP_CATS.map(c=>`<option${g.category===c?' selected':''}>${esc(c)}</option>`).join('')}</select><span class="field-label">Kategorie</span></div>
    <div><select name="alarm_profile" style="${_GRP_SELECT}">${['hard','medium','soft','info'].map(p=>`<option${g.alarm_profile===p?' selected':''}>${p}</option>`).join('')}</select><span class="field-label">Alarmprofil</span></div>
    <div style="grid-column:1/-1">
      <div class="grp-obj-pills" style="display:flex;gap:8px;flex-wrap:wrap">${pills}</div>
      <input type="hidden" name="coarse_objects" value="${esc((g.coarse_objects||[]).join(','))}" />
      <span class="field-label" style="margin-top:6px;display:block">Grob-Objekte</span>
    </div>
    <div style="grid-column:1/-1;display:flex;gap:20px;align-items:center;flex-wrap:wrap;padding:4px 0">
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer"><input type="checkbox" name="fm_bird"${fm.has('bird_species')?' checked':''} style="width:auto;accent-color:var(--accent)" /> Vogelarten</label>
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer"><input type="checkbox" name="fm_cat"${fm.has('cat_identity')?' checked':''} style="width:auto;accent-color:var(--accent)" /> Katzen-ID</label>
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer"><input type="checkbox" name="fm_person"${fm.has('person_identity')?' checked':''} style="width:auto;accent-color:var(--accent)" /> Personen-ID</label>
      <span class="field-label" style="margin-left:auto">Fine-Models</span>
    </div>
    <div style="grid-column:1/-1;display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-height:44px">
      <label class="switch"><input type="checkbox" name="schedule_enabled"${s.enabled?' checked':''}
        onchange="this.closest('form').querySelector('.grp-sched-times').style.display=this.checked?'flex':'none'" /><span class="slider"></span></label>
      <span style="font-size:13px;font-weight:600">Zeitplan</span>
      <div class="grp-sched-times" style="display:${s.enabled?'flex':'none'};align-items:center;gap:8px">
        ${_groupTimeSelect('schedule_start',s.start||'22:00')}
        <span class="muted" style="font-size:13px">→</span>
        ${_groupTimeSelect('schedule_end',s.end||'06:00')}
      </div>
    </div>
    <div style="grid-column:1/-1;display:flex;gap:10px;margin-top:4px">
      <button type="button" style="background:var(--surface);color:var(--text);border:none;border-radius:12px;padding:10px 18px;font-size:14px;font-weight:600;cursor:pointer" onclick="this.closest('.group-inline').remove()">Abbrechen</button>
      <button type="submit" style="flex:1;min-height:42px;background:var(--accent);color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer">Gruppe speichern</button>
    </div>
  </form></div>`;
}
function _wireGroupPills(form){
  form.querySelectorAll('.grp-obj-pill').forEach(btn=>{
    btn.addEventListener('click',()=>{
      btn.classList.toggle('active');
      const on=btn.classList.contains('active');
      btn.style.background=on?'var(--accent)':'var(--surface)';
      btn.style.color=on?'#fff':'var(--muted)';
      const h=form.querySelector('[name="coarse_objects"]');
      if(h) h.value=[...form.querySelectorAll('.grp-obj-pill.active')].map(b=>b.dataset.obj).join(',');
    });
  });
}
function toggleGroupEdit(g){
  document.querySelectorAll('.group-inline').forEach(el=>el.remove());
  const item=document.querySelector('[data-gid="'+g.id+'"]');
  if(!item) return;
  item.insertAdjacentHTML('afterend',groupEditHTML(g));
  const form=item.nextElementSibling?.querySelector('form');
  if(form) _wireGroupPills(form);
  item.nextElementSibling?.scrollIntoView({behavior:'smooth',block:'nearest'});
}
window.toggleGroupEdit=toggleGroupEdit;
async function saveGroup(e){
  e.preventDefault();
  const f=e.target.elements;
  const name=f['name'].value;
  const id=f['id'].value||_groupGenId(name);
  const fine_models=[
    ...(f['fm_bird']?.checked?['bird_species']:[]),
    ...(f['fm_cat']?.checked?['cat_identity']:[]),
    ...(f['fm_person']?.checked?['person_identity']:[]),
  ];
  const payload={id,name,category:f['category'].value,alarm_profile:f['alarm_profile'].value,
    coarse_objects:f['coarse_objects'].value.split(',').map(x=>x.trim()).filter(Boolean),
    fine_models,
    schedule:{enabled:f['schedule_enabled'].checked,start:f['schedule_start'].value||'22:00',end:f['schedule_end'].value||'06:00'}};
  await fetch('/api/groups',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  await loadAll();
  // Re-select saved group so tabs update correctly
  const savedId=id;
  setTimeout(()=>{ const tab=byId(`grpTab_${savedId}`); if(tab) selectGroup(savedId); },50);
}
window.saveGroup=saveGroup;

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
  _liveViewCamId=camId; _liveViewHd=false;
  byId('liveViewTitle').textContent=camName||camId;
  _setLiveViewStream(false);
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
  const hdBtn=byId('liveViewHdBtn');
  if(hdBtn){
    hdBtn.textContent=hd?'◀ Vorschau':'HD';
    hdBtn.title=hd?'Zurück zur Vorschau (Sub-Stream)':'Hochauflösend (Haupt-Stream, annotiert)';
    hdBtn.classList.toggle('cv-livebtn-active',hd);
  }
  const modeLabel=byId('liveViewModeLabel');
  if(modeLabel) modeLabel.textContent=hd?'HD · Haupt-Stream':'Vorschau · Sub-Stream';
}
function closeLiveView(){
  const modal=byId('liveViewModal'); if(!modal) return;
  const img=byId('liveViewImg'); if(img) img.src=''; // disconnect MJPEG stream → remove_viewer
  if(document.fullscreenElement||document.webkitFullscreenElement){
    (document.exitFullscreen||document.webkitExitFullscreen||function(){}).call(document).catch(()=>{});
  }
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
    const req=targetEl.requestFullscreen||targetEl.webkitRequestFullscreen;
    if(req) req.call(targetEl).catch(()=>{});
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
  updateAppInfoPanel();
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
  // Coral section — io-switch toggles
  const coralActive=!!(proc.coral_enabled ?? coral.mode==='coral');
  const birdActive=!!(proc.bird_species_enabled ?? coral.bird_species_enabled);
  const coralSwitch=byId('coralTpuSwitch'); if(coralSwitch) coralSwitch.classList.toggle('on',coralActive);
  const birdSwitch=byId('birdSpeciesSwitch'); if(birdSwitch) birdSwitch.classList.toggle('on',birdActive);
  const coralBadge=byId('coralStatusBadge');
  if(coralBadge){coralBadge.textContent=coralActive?'aktiv':'aus';coralBadge.className='set-status-badge '+(coralActive?'set-status-badge--on':'set-status-badge--off');}
  const hint=byId('coralStatusHint');
  if(hint){
    const cam=state.cameras[0];
    const available=cam?.coral_available; const reason=cam?.coral_reason||'—';
    hint.textContent=available?'✅ Coral TPU erkannt und aktiv.':`⚠️ Coral nicht verfügbar: ${reason}`;
  }
  // Coral device info from /api/system (async, non-blocking)
  _updateCoralDeviceInfo();
  // Hydrate media settings form
  const storageSec=state.config.storage||{};
  const rdVal=storageSec.retention_days||14;
  const rdEl=byId('ms_retention_days'); if(rdEl) rdEl.value=rdVal;
  const rdLbl=byId('ms_retention_days_val'); if(rdLbl) rdLbl.textContent=rdVal+' Tage';
  const acEl=byId('ms_auto_cleanup'); if(acEl) acEl.checked=!!storageSec.auto_cleanup_enabled;
}

function updateAppInfoPanel(){
  const panel=byId('appInfoPanel'); if(!panel) return;
  const stor=state.config?.storage||{};
  const storagePath=stor.root||'storage/';
  // Build info will be filled by updateSystemPanel via /api/system
  panel.innerHTML=`
    <div class="app-info-item"><span class="app-info-label">Storage-Pfad</span><span class="app-info-val"><code>${esc(storagePath)}</code></span></div>
  `;
}

async function updateSystemPanel(){
  const panel=byId('systemInfoPanel'); if(!panel) return;
  try{
    const s=await j('/api/system');
    const b=s.build||{};
    const commit=b.commit||'dev';
    const date=b.date||'—';
    const count=b.count||'—';
    const memUsed=s.mem_used_mb||0;
    const memTotal=s.mem_total_mb||0;
    const procMem=s.proc_mem_mb||0;
    const uptime=s.uptime_s||0;
    const uptimeStr=uptime>3600?`${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`:uptime>60?`${Math.floor(uptime/60)}m`:`${Math.round(uptime)}s`;
    panel.innerHTML=`
      <div class="app-info-grid" style="margin-bottom:0">
        <div class="app-info-item"><span class="app-info-label">Build</span><span class="app-info-val"><code>${esc(commit)}</code> · ${esc(date)}</span></div>
        <div class="app-info-item"><span class="app-info-label">Commits</span><span class="app-info-val">${esc(String(count))}</span></div>
        ${memTotal?`<div class="app-info-item"><span class="app-info-label">RAM (System)</span><span class="app-info-val">${memUsed} / ${memTotal} MB</span></div>`:''}
        ${procMem?`<div class="app-info-item"><span class="app-info-label">RAM (App)</span><span class="app-info-val">${procMem} MB</span></div>`:''}
        ${uptime?`<div class="app-info-item"><span class="app-info-label">Container-Uptime</span><span class="app-info-val">${uptimeStr}</span></div>`:''}
        ${s.camera_count!==undefined?`<div class="app-info-item"><span class="app-info-label">Aktive Runtimes</span><span class="app-info-val">${s.camera_count}</span></div>`:''}
      </div>`;
  }catch(e){/* silent — system info optional */}
}

let _appSaveTimer=null;
window.saveAppSettingsDebounced=function(){
  clearTimeout(_appSaveTimer);
  _appSaveTimer=setTimeout(()=>saveAppSettings(),600);
};

// ── Telegram page hydrate & logic ─────────────────────────────────────────────
const TG_OBJECTS=['person','cat','bird','car','motion'];

function hydrateTelegram(){
  const tg=state.config?.telegram||{};
  const el=byId('tg_enabled'); if(el) el.checked=!!tg.enabled;
  const tgBadge=byId('tgStatusBadge');
  if(tgBadge){tgBadge.textContent=tg.enabled?'aktiv':'aus';tgBadge.className='set-status-badge '+(tg.enabled?'set-status-badge--on':'set-status-badge--off');}
  const tok=byId('tg_token'); if(tok) tok.value=tg.token||'';
  const cid=byId('tg_chat_id'); if(cid) cid.value=tg.chat_id||'';
  // Format
  const fmt=tg.format||'photo';
  document.querySelectorAll('[name="tg_format"]').forEach(r=>r.checked=r.value===fmt);
  renderTgFormatPreview(fmt);
  // Group rules
  renderTgGroupRules();
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

function renderTgGroupRules(){
  const container=byId('tgGroupRules'); if(!container) return;
  const tgGroups=(state.config?.telegram||{}).groups||{};
  if(!state.groups.length){
    container.innerHTML='<div class="small muted">Keine Kameragruppen konfiguriert.</div>';
    return;
  }
  container.innerHTML=state.groups.map(g=>{
    const rule=tgGroups[g.id]||{enabled:true,from:'',to:'',objects:[...TG_OBJECTS]};
    const objList=rule.objects||TG_OBJECTS;
    return `<div class="tg-group-rule" data-gid="${esc(g.id)}">
      <div class="tg-gr-head">
        <span class="tg-gr-name">${esc(g.name)}</span>
        <label class="tg-gr-toggle"><span class="small muted">Telegram</span><label class="switch switch-sm"><input type="checkbox" class="tg-gr-enabled" ${rule.enabled!==false?'checked':''}><span class="slider"></span></label></label>
      </div>
      <div class="tg-gr-body">
        <div class="tg-gr-time">
          <span class="small muted">Zeitfenster:</span>
          <input class="disc-input tg-gr-from" type="time" value="${esc(rule.from||'')}" title="Von (leer = immer)" style="width:100px"/>
          <span class="small muted">–</span>
          <input class="disc-input tg-gr-to" type="time" value="${esc(rule.to||'')}" title="Bis" style="width:100px"/>
          <span class="small muted">(leer = immer)</span>
        </div>
        <div class="tg-gr-objects">
          ${TG_OBJECTS.map(obj=>`<label class="tg-obj-chip${objList.includes(obj)?' active':''}">
            <input type="checkbox" ${objList.includes(obj)?'checked':''} data-obj="${esc(obj)}" />
            ${objBubble(obj,18)}<span>${OBJ_LABEL[obj]||esc(obj)}</span>
          </label>`).join('')}
        </div>
      </div>
    </div>`;
  }).join('');
  // Wire chip interactivity
  container.querySelectorAll('.tg-obj-chip input').forEach(cb=>{
    cb.addEventListener('change',()=>cb.closest('.tg-obj-chip').classList.toggle('active',cb.checked));
  });
}

function readTgGroupRules(){
  const rules={};
  document.querySelectorAll('#tgGroupRules .tg-group-rule').forEach(row=>{
    const gid=row.dataset.gid;
    const enabled=row.querySelector('.tg-gr-enabled')?.checked??true;
    const from=row.querySelector('.tg-gr-from')?.value||'';
    const to=row.querySelector('.tg-gr-to')?.value||'';
    const objects=[...row.querySelectorAll('.tg-gr-objects input:checked')].map(cb=>cb.dataset.obj);
    rules[gid]={enabled,from,to,objects};
  });
  return rules;
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
    groups:(state.config?.telegram||{}).groups||{}
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

byId('saveTgGroupRulesBtn')?.addEventListener('click',async()=>{
  const rules=readTgGroupRules();
  const existing=state.config?.telegram||{};
  const payload={telegram:{...existing,groups:rules}};
  await fetch('/api/settings/app',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  await loadAll();
  const btn=byId('saveTgGroupRulesBtn');
  if(btn){const orig=btn.textContent;btn.textContent='✓ Gespeichert';setTimeout(()=>btn.textContent=orig,2000);}
});

function getCanvasCtx(){ return byId('maskCanvas').getContext('2d'); }
function loadMaskSnapshot(camId){ if(!camId) return; byId('maskSnapshot').src=`/api/camera/${camId}/snapshot.jpg?t=${Date.now()}`; byId('shapeStatus').textContent=`Bearbeite ${camId} · ${shapeState.mode==='zone'?'Zone':'Maske'}`; }
function scaleForCanvas(el,img){ const rect=el.getBoundingClientRect(); const naturalW=img.naturalWidth||1280, naturalH=img.naturalHeight||720; el.width=naturalW; el.height=naturalH; el.style.width=rect.width+'px'; el.style.height='auto'; }
function drawPoly(ctx,poly,color,fillAlpha){ if(!poly?.length) return; ctx.beginPath(); ctx.moveTo(poly[0].x,poly[0].y); poly.slice(1).forEach(p=>ctx.lineTo(p.x,p.y)); ctx.closePath(); ctx.fillStyle=color.replace('1)', `${fillAlpha})`); ctx.strokeStyle=color; ctx.lineWidth=3; ctx.fill(); ctx.stroke(); }
function drawShapes(){
  const img=byId('maskSnapshot'), canvas=byId('maskCanvas'); if(!img.src) return;
  scaleForCanvas(canvas,img); const ctx=getCanvasCtx(); ctx.clearRect(0,0,canvas.width,canvas.height);
  (shapeState.zones||[]).forEach(poly=>drawPoly(ctx,poly,'rgba(75,163,255,1)',0.17));
  (shapeState.masks||[]).forEach(poly=>drawPoly(ctx,poly,'rgba(255,107,107,1)',0.18));
  if(shapeState.points.length){ ctx.beginPath(); ctx.moveTo(shapeState.points[0].x,shapeState.points[0].y); shapeState.points.slice(1).forEach(p=>ctx.lineTo(p.x,p.y)); ctx.strokeStyle='#ffffff'; ctx.lineWidth=2; ctx.setLineDash([7,6]); ctx.stroke(); ctx.setLineDash([]); shapeState.points.forEach(p=>{ ctx.beginPath(); ctx.arc(p.x,p.y,6,0,Math.PI*2); ctx.fillStyle='#fff'; ctx.fill(); }); }
}
function canvasPoint(evt){ const canvas=byId('maskCanvas'); const rect=canvas.getBoundingClientRect(); const x=(evt.clientX-rect.left)*(canvas.width/rect.width); const y=(evt.clientY-rect.top)*(canvas.height/rect.height); return {x:Math.round(x),y:Math.round(y)}; }
function saveShapesIntoForm(){ const f=byId('cameraForm').elements; f['zones_json'].value=JSON.stringify(shapeState.zones||[]); f['masks_json'].value=JSON.stringify(shapeState.masks||[]); }

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
    cameras: camId ? [{id:camId,name:byId('wiz_cam_name').value||camId,location:byId('wiz_cam_location').value||'',rtsp_url:byId('wiz_cam_rtsp').value||'',snapshot_url:byId('wiz_cam_snapshot').value||'',group_id:byId('wiz_cam_group').value||'bereichsuebersicht',role:byId('wiz_cam_group').selectedOptions[0].textContent,enabled:true,armed:true,object_filter:['person','cat','bird'],timelapse:{enabled:false,fps:12},zones:[],masks:[],schedule:{enabled:false,start:'22:00',end:'06:00'},telegram_enabled:true,mqtt_enabled:true,whitelist_names:[]}] : []
  };
  await fetch('/api/wizard/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  closeWizard();
  await loadAll();
}

byId('reloadConfigBtn').onclick=()=>loadAll();

const _RELOAD_MSGS=["Squirrel catches cam… 🐿️","Nut detected, reconnecting! 🌰","Hold still, camera! 🐿️💨","Signal acquired. Maybe. 📡🐿️","On it. Probably. 🐿️"];
const _SQ_SVG=`<svg viewBox="0 0 40 32" width="40" height="32" xmlns="http://www.w3.org/2000/svg">
  <path d="M28 8 Q36 4 37 12 Q38 18 32 20 Q36 22 35 28" stroke="#c8651a" stroke-width="2.5" fill="none" stroke-linecap="round"/>
  <ellipse cx="18" cy="20" rx="12" ry="8" fill="#c8651a"/>
  <circle cx="10" cy="14" r="7" fill="#c8651a"/>
  <ellipse cx="7" cy="10" rx="3" ry="4" fill="#c8651a"/>
  <circle cx="8" cy="13" r="2" fill="#111"/>
  <circle cx="7.5" cy="12.5" r=".8" fill="#fff"/>
</svg>`;
function showReloadToast(){
  const msg=_RELOAD_MSGS[Math.floor(Math.random()*_RELOAD_MSGS.length)];
  const t=document.createElement('div');
  t.style.cssText='position:fixed;bottom:24px;right:24px;z-index:2000;min-width:220px;background:var(--panel);border-radius:16px;padding:12px 16px;box-shadow:0 4px 24px rgba(0,0,0,.5);pointer-events:none';
  t.innerHTML=`<div style="overflow:hidden;height:36px;position:relative;margin-bottom:6px">
    <span style="position:absolute;animation:squirrel-chase 1.8s linear forwards;display:inline-flex;align-items:center;gap:4px">${_SQ_SVG}<span style="font-size:18px">📷</span></span>
  </div>
  <div style="font-size:12px;color:var(--muted);text-align:center">${esc(msg)}</div>`;
  document.body.appendChild(t);
  setTimeout(()=>{t.style.transition='opacity .4s';t.style.opacity='0';setTimeout(()=>t.remove(),450);},1900);
}
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
  const hideConfigured=byId('discoveryHideConfigured')?.checked;
  const pathOpts=RTSP_PATHS.map(p=>`<option value="${esc(p.value)}">${esc(p.label)}</option>`).join('');
  // Collect IPs from existing configured cameras
  const configuredIPs=new Set((state.config?.cameras||[]).map(c=>{
    try{ return new URL(c.rtsp_url||'http://x').hostname; }catch{ return ''; }
  }).concat((state.cameras||[]).map(c=>c.id)).filter(Boolean));
  // Also check rtsp_url/snapshot_url IPs
  const configuredIPsFromUrl=new Set();
  (state.config?.cameras||[]).forEach(c=>{
    ['rtsp_url','snapshot_url'].forEach(k=>{
      try{ const u=new URL((c[k]||'').replace(/^rtsp:/,'http:')); if(u.hostname) configuredIPsFromUrl.add(u.hostname); }catch{}
    });
  });
  const allConfigured=new Set([...configuredIPs,...configuredIPsFromUrl]);

  const visible=hideConfigured?_discoveryItems.filter(x=>!allConfigured.has(x.ip)):_discoveryItems;
  const alreadyCount=_discoveryItems.filter(x=>allConfigured.has(x.ip)).length;

  if(!visible.length){
    byId('discoveryResults').innerHTML=`<div class="item">Keine Kamera-Kandidaten${hideConfigured&&alreadyCount?' ('+alreadyCount+' bereits konfiguriert ausgeblendet)':''}</div>`;
    return;
  }
  byId('discoveryResults').innerHTML=visible.map(x=>{
    const ports=(x.open_ports||[]).join(', ')||'—';
    const uid=x.ip.replace(/\./g,'_');
    const already=allConfigured.has(x.ip);
    const vendor=x.guess==='Unbekannte Kamera'?`Unbekannte Kamera (${x.ip})`:esc(x.guess||'Unbekannte Kamera');
    const groupOpts=state.groups.map(g=>`<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
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
            <select id="disc_group_${uid}" class="disc-select" style="flex:1">${groupOpts}</select>
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
  const groupId=byId(`disc_group_${uid}`)?.value||state.groups[0]?.id||'';
  const rtsp=`rtsp://${user}:${_rtspEnc(pass)}@${ip}:554${path}`;
  const snap=`http://${user}:${_rtspEnc(pass)}@${ip}/cgi-bin/snapshot.cgi`;
  const _item=_discoveryItems.find(x=>x.ip===ip);
  const camId=_item?.hostname?_hostnameToId(_item.hostname):'cam-'+ip.replace(/\./g,'-');
  const payload={id:camId,name,location:'',rtsp_url:rtsp,snapshot_url:snap,
    group_id:groupId,enabled:true,armed:true,
    object_filter:['person','cat','bird'],
    timelapse:{enabled:false,fps:12},zones:[],masks:[],
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
  const existingCam=(state.cameras||[]).find(x=>x.id===f['id'].value);
  const payload={id:f['id'].value,name:f['name'].value,
    icon:f['icon']?.value||getCameraIcon(f['name'].value),
    rtsp_url:f['rtsp_url'].value,snapshot_url:f['snapshot_url'].value,
    username:f['rtsp_user']?.value||'',password:f['rtsp_pass']?.value||'',
    group_id:f['group_id'].value,role:f['group_id'].selectedOptions[0]?.textContent||f['group_id'].value,
    object_filter:f['object_filter'].value.split(',').map(x=>x.trim()).filter(Boolean),
    enabled:f['enabled']?f['enabled'].checked:(existingCam?.enabled??true),
    armed:f['armed'].checked,
    telegram_enabled:existingCam?.telegram_enabled??true,
    mqtt_enabled:existingCam?.mqtt_enabled??true,
    whitelist_names:_whitelistState.filter(Boolean),
    timelapse:existingCam?.timelapse||{enabled:false,fps:30,period:'day',daily_target_seconds:60,weekly_target_seconds:180,telegram_send:false},
    schedule:{enabled:f['schedule_enabled'].checked,start:f['schedule_start'].value||'22:00',end:f['schedule_end'].value||'06:00'},
    bottom_crop_px:parseInt(f['bottom_crop_px']?.value||0),
    motion_sensitivity:parseFloat(f['motion_sensitivity']?.value||0.5),
    resolution:f['resolution']?.value||'auto',
    frame_interval_ms:parseInt(f['frame_interval_ms']?.value||350),
    snapshot_interval_s:parseInt(f['snapshot_interval_s']?.value||3),
    zones:JSON.parse(f['zones_json'].value||'[]'),masks:JSON.parse(f['masks_json'].value||'[]')};
  const _savedId=payload.id; _restoreEditWrapper();
  await fetch('/api/settings/cameras',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  await loadAll(); editCamera(_savedId);
};
byId('closeCameraEdit')?.addEventListener('click',()=>_closeEditPanel());
byId('addGroupBtn').onclick=(e)=>{
  e.stopPropagation();
  // Deactivate all group tabs
  document.querySelectorAll('#grpTabs .sec-tab-btn').forEach(b=>b.classList.remove('active'));
  // Ensure grpContent exists (if no groups yet, create the shell)
  if(!byId('grpContent')){
    const list=byId('groupList');
    if(list) list.innerHTML=`<div class="sec-tabs" id="grpTabs" style="margin-bottom:0"></div><div class="sec-content" id="grpContent"></div>`;
  }
  _renderGroupContent({id:'',name:'',category:'Sonstiges',alarm_profile:'soft',coarse_objects:[],fine_models:[],schedule:{enabled:false,start:'22:00',end:'06:00'}});
  byId('grpContent')?.scrollIntoView({behavior:'smooth',block:'nearest'});
};
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
window._toggleCoralSetting=async function(key,swEl){
  const nowOn=!swEl.classList.contains('on');
  swEl.classList.toggle('on',nowOn);
  const coralEnabled=key==='coral_enabled'?nowOn:!!(byId('coralTpuSwitch')?.classList.contains('on'));
  const birdEnabled=key==='bird_species_enabled'?nowOn:!!(byId('birdSpeciesSwitch')?.classList.contains('on'));
  await fetch('/api/settings/app',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({processing:{coral_enabled:coralEnabled,bird_species_enabled:birdEnabled}})});
  showToast('Coral gespeichert · Kameras werden neu gestartet.','success');
  await loadAll();
};
window.reloadCoralRuntime=async function(){
  const coralEnabled=!!(byId('coralTpuSwitch')?.classList.contains('on'));
  const birdEnabled=!!(byId('birdSpeciesSwitch')?.classList.contains('on'));
  await fetch('/api/settings/app',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({processing:{coral_enabled:coralEnabled,bird_species_enabled:birdEnabled}})});
  showToast('Coral-Runtime neu gestartet.','success');
  await loadAll();
};
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
function _makeSquirrelHTML(){
  const msg=_RELOAD_MSGS[Math.floor(Math.random()*_RELOAD_MSGS.length)];
  const bigSvg=_SQ_SVG.replace('width="40" height="32"','width="82" height="76"');
  return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:8px">
    <div class="cv-sq-runner"><div class="cv-sq-sprite">${bigSvg}<span class="cv-sq-cam">📷</span></div></div>
    <div class="cv-reload-msg">${esc(msg)}</div>
  </div>`;
}
function _restorePlaceholder(card){
  const placeholder=card.querySelector('.cv-loading-placeholder');
  if(placeholder) placeholder.innerHTML='<div class="cv-loading-icon">⟳</div><div class="cv-loading-text">Verbinde…</div>';
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
    if(placeholder && !placeholder.querySelector('.cv-sq-runner'))
      placeholder.innerHTML=_makeSquirrelHTML();
    if(img){img.classList.remove('loaded');img.style.opacity='0';}
    const targetCamId=card.dataset.camid;
    let attempts=0;
    const poll=setInterval(async()=>{
      attempts++;
      if(attempts>15){clearInterval(poll);_restorePlaceholder(card);return;}
      try{
        const r=await j('/api/cameras');
        const cam=(r.cameras||[]).find(c=>c.id===targetCamId);
        if(cam?.status==='active'){clearInterval(poll);_restorePlaceholder(card);}
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
function _tlClosestPeriod(v){
  const n=parseInt(v)||3600;
  return _TL_PERIOD_OPTIONS.reduce((a,b)=>Math.abs(b.v-n)<Math.abs(a.v-n)?b:a).v;
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
  const fps=parseInt(tl.fps)||30;
  const cols=_TL_PROFILES_DEF.map(p=>{
    const prof=profs[p.key]||{};
    const enabled=!!prof.enabled;
    const targetS=prof.target_seconds??p.defaultTarget;
    const periodS=prof.period_seconds??p.defaultPeriod;
    const isCustom=p.key==='custom';
    const minT=p.minTarget||10, maxT=p.maxTarget||900;
    const clampedTarget=Math.max(minT,Math.min(maxT,targetS));
    return `<div class="tl-mode-col${enabled?' tl-mode-col--on':''}" id="tlProfCard_${esc(cam.id)}_${p.key}">
      <div class="tl-mode-col-head">
        <div>
          <div class="tl-mode-col-name">${esc(p.label)}</div>
        </div>
        <label class="switch switch-sm" onclick="event.stopPropagation()">
          <input type="checkbox" id="tlProf_${esc(cam.id)}_${p.key}" ${enabled?'checked':''}
            onchange="byId('tlProfCard_${esc(cam.id)}_${p.key}').classList.toggle('tl-mode-col--on',this.checked);_tlRefreshDesc('${esc(cam.id)}','${p.key}',${fps})" />
          <span class="slider"></span>
        </label>
      </div>
      <div class="tl-mode-col-desc" id="tlProfDesc_${esc(cam.id)}_${p.key}">${_tlResultDesc(periodS,clampedTarget,fps)}</div>
      <div class="field-wrap">
        <div style="display:flex;align-items:center;gap:8px">
          <input type="range" id="tlProfTarget_${esc(cam.id)}_${p.key}" min="${minT}" max="${maxT}" step="${p.step||10}" value="${clampedTarget}" style="flex:1;accent-color:#a855f7"
            oninput="_tlRefreshDesc('${esc(cam.id)}','${p.key}',${fps})" />
          <span id="tlProfTargetLbl_${esc(cam.id)}_${p.key}" style="font-size:11px;color:#a855f7;font-weight:700;min-width:36px;text-align:right">${_tlTargetLabel(clampedTarget)}</span>
        </div>
        <span class="field-label">Zieldauer Video</span>
      </div>
      ${isCustom?`<div class="field-wrap">
        <select id="tlProfPeriod_${esc(cam.id)}_${p.key}" style="width:100%"
          onchange="_tlRefreshDesc('${esc(cam.id)}','${p.key}',${fps})">
          ${_TL_PERIOD_OPTIONS.map(o=>`<option value="${o.v}"${_tlClosestPeriod(periodS)===o.v?' selected':''}>${o.l}</option>`).join('')}
        </select>
        <span class="field-label">Zeitraum</span>
      </div>`:`<input type="hidden" id="tlProfPeriod_${esc(cam.id)}_${p.key}" value="${periodS}" />`}
    </div>`;
  }).join('');
  return `<div class="tl-modes-grid">${cols}</div>
    <button class="settings-save-btn" style="margin-top:4px" onclick="saveTlCameraProfiles('${esc(cam.id)}')">💾 Speichern</button>`;
}
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
  const pN=parseInt(periodS)||86400, tN=parseInt(targetS)||60, fN=parseInt(fps)||30;
  const interval=_tlCalcInterval(pN,tN,fN);
  const totalFrames=Math.round(tN*fN);
  const periodLabel=_tlPeriodLabel(pN);
  const intervalLabel=_tlIntervalLabel(interval);
  const speedup=_tlSpeedupLabel(Math.round(pN/Math.max(1,tN)));
  const comprPct=(Math.floor((1-tN/Math.max(1,pN))*10000)/100).toFixed(2).replace('.',',');
  return `<div class="tl-drow"><span class="tl-drow-ico">${_TL_ICO_SPAN}</span><span class="tl-drow-text">${periodLabel} mit ${intervalLabel} → ${tN}s Video (${fN} fps)</span></div><div class="tl-drow"><span class="tl-drow-ico">${_TL_ICO_FRAMES}</span><span class="tl-drow-text">${totalFrames} frames → Jede ${intervalLabel} ein Foto</span></div><div class="tl-drow tl-drow-accent"><span class="tl-drow-ico">${_TL_ICO_SPEED}</span><span class="tl-drow-text">${speedup} · Kompression ${comprPct}%</span></div>`;
}
// _renderTlProfileCards replaced by _renderTlModesGrid (4-column grid)
window._tlRefreshDesc=function(camId,profKey,fps){
  const targetEl=byId(`tlProfTarget_${camId}_${profKey}`);
  const periodEl=byId(`tlProfPeriod_${camId}_${profKey}`);
  const descEl=byId(`tlProfDesc_${camId}_${profKey}`);
  const lblEl=byId(`tlProfTargetLbl_${camId}_${profKey}`);
  if(!targetEl||!periodEl) return;
  if(lblEl) lblEl.textContent=_tlTargetLabel(parseInt(targetEl.value)||10);
  if(descEl) descEl.innerHTML=_tlResultDesc(periodEl.value,targetEl.value,fps);
};
// toggleTlCamCard replaced by selectTlCam (tab-based camera selector)
window.openTlNav=function(){
  const section=byId('set-timelapse');
  if(section&&!section.classList.contains('open')){section.classList.add('open');loadTlSettings();}
  byId('settings')?.scrollIntoView({behavior:'smooth',block:'start'});
  return false;
};
window.saveTlCameraProfiles=async function(camId){
  const cam=(state.cameras||[]).find(c=>c.id===camId);
  if(!cam) return;
  const profiles={};
  const tl=cam.timelapse||{};
  const fps=parseInt(tl.fps)||30;
  for(const p of _TL_PROFILES_DEF){
    const enabledEl=byId(`tlProf_${camId}_${p.key}`);
    const targetEl=byId(`tlProfTarget_${camId}_${p.key}`);
    const periodEl=byId(`tlProfPeriod_${camId}_${p.key}`);
    profiles[p.key]={
      enabled:!!(enabledEl?.checked),
      target_seconds:parseInt(targetEl?.value)||p.defaultTarget,
      period_seconds:parseInt(periodEl?.value)||p.defaultPeriod,
    };
  }
  const anyEnabled=Object.values(profiles).some(p=>p.enabled);
  const payload={...cam,timelapse:{...(cam.timelapse||{}),enabled:anyEnabled,profiles}};
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
  const opening=!el.classList.contains('open');
  el.classList.toggle('open',opening);
};

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

byId('maskCanvas').addEventListener('click',(evt)=>{ if(!shapeState.camera) return; shapeState.points.push(canvasPoint(evt)); drawShapes(); });
byId('refreshMaskSnapshotBtn').onclick=()=>loadMaskSnapshot(shapeState.camera||byId('cameraForm').elements['id'].value);
byId('editZoneBtn').onclick=()=>{shapeState.mode='zone'; byId('shapeStatus').textContent='Zone zeichnen';};
byId('editMaskBtn').onclick=()=>{shapeState.mode='mask'; byId('shapeStatus').textContent='Maske zeichnen';};
byId('undoShapeBtn').onclick=()=>{shapeState.points.pop(); drawShapes();};
byId('saveShapeBtn').onclick=()=>{ if(shapeState.points.length<3){showToast('Mindestens 3 Punkte.','warn');return;} if(shapeState.mode==='zone') shapeState.zones.push([...shapeState.points]); else shapeState.masks.push([...shapeState.points]); shapeState.points=[]; saveShapesIntoForm(); drawShapes(); };
byId('clearShapesBtn').onclick=async()=>{ if(!await showConfirm('Alle Zonen und Masken löschen?')) return; shapeState.zones=[]; shapeState.masks=[]; shapeState.points=[]; saveShapesIntoForm(); drawShapes(); };
byId('maskSnapshot').addEventListener('load',drawShapes);

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
    const shellPaddingTop=parseInt(getComputedStyle(document.querySelector('.shell')).paddingTop)||0;
    target.scrollIntoView({behavior:'smooth',block:'start'});
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
function _updateLbConfirmBtn(confirmed){
  const btn=byId('lightboxConfirm');
  if(!btn) return;
  if(confirmed){
    btn.style.background='#166534';btn.style.color='#4ade80';
    btn.innerHTML='<span style="font-size:15px;line-height:1;opacity:.85">↑</span><span style="font-size:22px;line-height:1">✓✓</span>';
  } else {
    btn.style.background='';btn.style.color='';
    btn.innerHTML='<span style="font-size:15px;line-height:1;opacity:.75">↑</span><span style="font-size:22px;line-height:1">✓</span>';
  }
}
function _lbResetToPhoto(){
  // Ensure photo mode is active (cleanup from any prior timelapse view)
  const videoEl=byId('lightboxVideo');
  if(videoEl){videoEl.pause();videoEl.src='';videoEl.style.display='none';}
  byId('lightboxImg').style.display='';
  const confirmBtn=byId('lightboxConfirm');
  if(confirmBtn) confirmBtn.style.display='';
  const labGrad=byId('lightboxLabelsGrad');
  if(labGrad) labGrad.style.display='';
}
function openLightbox(item){
  if(item.type==='timelapse'){openTLPlayer(item);return;}
  _lbIndex=(state.media||[]).findIndex(x=>x.event_id===item.event_id);
  if(_lbIndex===-1) return;
  _lbItem=state.media[_lbIndex];
  _lbDeletePending=false;
  _lbResetToPhoto();
  const delBtn=byId('lightboxDelete');
  if(delBtn){delBtn.classList.remove('confirm-delete');delBtn.innerHTML='<span style="font-size:15px;line-height:1;opacity:.75">↓</span><span style="font-size:22px;line-height:1">🗑</span>';delBtn.title=_lbItem.confirmed?'Bestätigt — trotzdem löschen?':'Löschen';}
  _updateLbConfirmBtn(_lbItem.confirmed);
  // Show video player for motion clips, image for snapshots
  const vidSrc=_lbItem.video_relpath?`/media/${_lbItem.video_relpath}`:(_lbItem.video_url||'');
  const imgSrc=_lbItem.snapshot_relpath?`/media/${_lbItem.snapshot_relpath}`:(_lbItem.snapshot_url||'');
  if(vidSrc){
    const imgEl=byId('lightboxImg'); imgEl.style.display='none';
    const videoEl=byId('lightboxVideo');
    videoEl.style.display='block'; videoEl.src=vidSrc; videoEl.muted=true; videoEl.loop=true;
    videoEl.load(); videoEl.play().catch(()=>{});
    const confirmBtn=byId('lightboxConfirm'); if(confirmBtn) confirmBtn.style.display='none';
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
  // When in the timelapse filter, navigation items are _tlItems; otherwise state.media
  if(state.mediaLabels.has('timelapse')&&state.mediaLabels.size===1) return window._tlItems||[];
  return (state.media||[]).filter(x=>x.type==='timelapse').length>0
    ? (window._tlItems||[])
    : (state.media||[]);
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
  const imgEl=byId('lightboxImg'); imgEl.style.display='none';
  const videoEl=byId('lightboxVideo');
  const videoSrc=item.url||(item.relpath?'/media/'+item.relpath:'');
  videoEl.style.display='block'; videoEl.src=videoSrc; videoEl.load(); videoEl.play().catch(()=>{});
  const confirmBtn=byId('lightboxConfirm'); if(confirmBtn) confirmBtn.style.display='none';
  const labGrad=byId('lightboxLabelsGrad'); if(labGrad) labGrad.style.display='none';
  byId('lightboxLabels').innerHTML='';
  const delBtn=byId('lightboxDelete');
  if(delBtn){delBtn.classList.remove('confirm-delete');delBtn.innerHTML='<span style="font-size:15px;line-height:1;opacity:.75">↓</span><span style="font-size:22px;line-height:1">🗑</span>';delBtn.title='Timelapse löschen';}
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
  const confirmBtn=byId('lightboxConfirm'); if(confirmBtn) confirmBtn.style.display='';
  const labGrad=byId('lightboxLabelsGrad'); if(labGrad) labGrad.style.display='';
}
byId('lightboxClose').onclick=closeLightbox;
byId('lightboxModal').onclick=(e)=>{if(e.target===byId('lightboxModal')) closeLightbox();};
function _lbNavList(){return _lbItem?.type==='timelapse'?_tlNavItems():(state.media||[]);}
byId('lightboxPrev').onclick=()=>{const nav=_lbNavList();const i=nav.findIndex(x=>x.event_id===_lbItem?.event_id);if(i>0) openLightbox(nav[i-1]);};
byId('lightboxNext').onclick=()=>{const nav=_lbNavList();const i=nav.findIndex(x=>x.event_id===_lbItem?.event_id);if(i>=0&&i<nav.length-1) openLightbox(nav[i+1]);};
document.addEventListener('keydown',(e)=>{
  // Live view ESC close (takes priority)
  if(e.key==='Escape'&&!byId('liveViewModal')?.classList.contains('hidden')){closeLiveView();return;}
  if(byId('lightboxModal').classList.contains('hidden')) return;
  if(e.key==='ArrowLeft'){e.preventDefault();const nav=_lbNavList();const i=nav.findIndex(x=>x.event_id===_lbItem?.event_id);if(i>0) openLightbox(nav[i-1]);}
  else if(e.key==='ArrowRight'){e.preventDefault();const nav=_lbNavList();const i=nav.findIndex(x=>x.event_id===_lbItem?.event_id);if(i>=0&&i<nav.length-1) openLightbox(nav[i+1]);}
  else if(e.key==='ArrowUp'){e.preventDefault();byId('lightboxConfirm').click();}
  else if(e.key==='ArrowDown'){e.preventDefault();_lbHandleDeleteKey();}
  else if(e.key==='Escape') closeLightbox();
});
byId('lightboxConfirm').innerHTML='<span style="font-size:15px;line-height:1;opacity:.75">↑</span><span style="font-size:22px;line-height:1">✓</span>';
byId('lightboxDelete').innerHTML='<span style="font-size:15px;line-height:1;opacity:.75">↓</span><span style="font-size:22px;line-height:1">🗑</span>';
_initFsBtn('liveViewFsBtn',byId('liveViewWrap'),()=>byId('liveViewWrap'));
_initFsBtn('lightboxFsBtn',byId('lightboxMediaWrap'),()=>{const v=byId('lightboxVideo');return(v&&v.style.display!=='none')?v:byId('lightboxMediaWrap');});
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
      window._tlItems=(window._tlItems||[]).filter(x=>x.event_id!==deletedId);
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
    _decrementMediaOverviewCount(camera_id);
    renderMediaGrid();
    renderMediaPagination();
    _lbIndex=Math.min(_lbIndex,(state.media||[]).length-1);
    if(_lbIndex<0) closeLightbox();
    else openLightbox(state.media[_lbIndex]);
    await loadMediaStorageStats();
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
const _TL_FILMSTRIP=`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="flex-shrink:0"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="18" x2="8" y2="22"/><line x1="16" y1="18" x2="16" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/></svg>`;
function mediaCardHTML(item){
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
    const badgeStyle='font-size:10px;font-weight:700;color:#e2e8f0;background:rgba(0,0,0,.68);backdrop-filter:blur(3px);padding:2px 6px;border-radius:4px;line-height:1.45;white-space:nowrap';
    const badgeSubStyle='font-size:10px;color:#a5bfce;background:rgba(0,0,0,.55);backdrop-filter:blur(3px);padding:1px 6px;border-radius:4px;line-height:1.45;white-space:nowrap;margin-top:2px';
    return `<article class="media-card mmc-tl" data-event-id="${esc(item.event_id||'')}" data-camera-id="${esc(item.camera_id||'')}">
      <div class="mmc-img-wrap" onclick="window._openMediaItem('${esc(item.event_id||'')}')">
        ${thumbEl}
        <div style="position:absolute;inset:0;z-index:1;display:flex;align-items:center;justify-content:center">
          <div class="mmc-play-btn"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="color:#d8b4fe;margin-left:2px"><polygon points="5,3 19,12 5,21"/></svg></div>
        </div>
        <div class="mmc-meta-bar"></div>
        <div style="position:absolute;bottom:7px;left:8px;z-index:2;pointer-events:none">
          ${datePart?`<div style="${badgeStyle}">${esc(datePart)}</div>`:''}
          ${timePart?`<div style="${badgeSubStyle}">${esc(timePart)}</div>`:''}
        </div>
        ${(durLabel||sizeText)?`<div style="position:absolute;bottom:7px;right:8px;z-index:2;pointer-events:none;display:flex;flex-direction:column;align-items:flex-end;gap:2px">
          ${durLabel?`<div style="${badgeStyle}">${esc(durLabel)}</div>`:''}
          ${sizeText?`<div style="${badgeSubStyle}">${esc(sizeText)}</div>`:''}
        </div>`:''}
        <div style="position:absolute;top:6px;left:6px;z-index:2"><span class="mmc-tl-badge">${_TL_FILMSTRIP}Timelapse</span></div>
        <div class="mmc-actions" style="z-index:3">
          <button class="mmc-btn mmc-delete" title="Löschen" onclick="event.stopPropagation();window.deleteTLCard('${esc(item.camera_id||'')}','${esc(item.filename||'')}','${esc(item.event_id||'')}')">✕</button>
        </div>
      </div>
    </article>`;
  }
  const isVideo=!!(item.video_relpath||item.video_url);
  const imgSrc=item.snapshot_relpath?`/media/${item.snapshot_relpath}`:(item.snapshot_url||'');
  const confirmed=item.confirmed?'mmc-confirmed':'';
  const labelBubbles=(item.labels||[]).slice(0,3).map(l=>objBubble(l,26)).join('');
  const badgeSt='font-size:10px;font-weight:700;color:#e2e8f0;background:rgba(0,0,0,.68);backdrop-filter:blur(3px);padding:2px 6px;border-radius:4px;line-height:1.45;white-space:nowrap';
  const fmtDur=s=>{if(!s||s<=0)return'';const m=Math.floor(s/60),sec=Math.round(s%60);return`${m}:${String(sec).padStart(2,'0')}`;};
  const fmtByt=b=>{if(!b||b<=0)return'';if(b>=1048576)return(b/1048576).toFixed(1)+' MB';return Math.round(b/1024)+' KB';};
  const mediaInner=isVideo
    ?`<div style="position:absolute;inset:0;background:#0a0e1a;display:flex;align-items:center;justify-content:center">
        <div class="mmc-play-btn"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="color:#fff;margin-left:3px"><polygon points="5,3 19,12 5,21"/></svg></div>
      </div>
      <div class="mmc-meta-bar"><span>${fmtMediaTime(item.time||'')}</span></div>
      ${item.duration_s?`<div style="position:absolute;bottom:7px;left:8px;z-index:2;pointer-events:none"><div style="${badgeSt}">${fmtDur(item.duration_s)}</div></div>`:''}
      ${item.file_size_bytes?`<div style="position:absolute;bottom:7px;right:8px;z-index:2;pointer-events:none"><div style="${badgeSt}">${fmtByt(item.file_size_bytes)}</div></div>`:''}`
    :`<img src="${esc(imgSrc)}" alt="event" loading="lazy" onerror="this.style.display='none'" />
      <div class="mmc-meta-bar"><span>${fmtMediaTime(item.time||'')}</span></div>`;
  return `<article class="media-card ${confirmed}" data-event-id="${esc(item.event_id||'')}" data-camera-id="${esc(item.camera_id||'')}">
    <div class="mmc-img-wrap" onclick="window._openMediaItem('${esc(item.event_id||'')}')">
      ${mediaInner}
      <div class="media-label-bubbles">${labelBubbles}</div>
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
// All-media multi-camera grid icon — 4 quads: TL=timelapse(violet), TR=motion(green), BL=person(blue), BR=object(amber)
const _MOC_ALL_SVG=`<svg width="112" height="70" viewBox="0 0 80 50" fill="none" aria-hidden="true"><rect x="1" y="1" width="34" height="21" rx="3.5" fill="#0d1522" stroke="#2a4460" stroke-width="1.3"/><rect x="45" y="1" width="34" height="21" rx="3.5" fill="#0d1522" stroke="#2a4460" stroke-width="1.3"/><rect x="1" y="28" width="34" height="21" rx="3.5" fill="#0d1522" stroke="#2a4460" stroke-width="1.3"/><rect x="45" y="28" width="34" height="21" rx="3.5" fill="#0d1522" stroke="#2a4460" stroke-width="1.3"/><circle cx="6" cy="6" r="2" fill="#2a4460"/><circle cx="50" cy="6" r="2" fill="#2a4460"/><circle cx="6" cy="33" r="2" fill="#2a4460"/><circle cx="50" cy="33" r="2" fill="#2a4460"/><!-- TL: timelapse filmstrip (violet only) --><rect x="8" y="7" width="18" height="11" rx="1.5" stroke="#a855f7" stroke-width="1" fill="none" opacity=".75"/><line x1="11" y1="5.5" x2="11" y2="8" stroke="#a855f7" stroke-width=".9" opacity=".7"/><line x1="15" y1="5.5" x2="15" y2="8" stroke="#a855f7" stroke-width=".9" opacity=".7"/><line x1="19" y1="5.5" x2="19" y2="8" stroke="#a855f7" stroke-width=".9" opacity=".7"/><line x1="11" y1="16" x2="11" y2="18.5" stroke="#a855f7" stroke-width=".9" opacity=".7"/><line x1="15" y1="16" x2="15" y2="18.5" stroke="#a855f7" stroke-width=".9" opacity=".7"/><line x1="19" y1="16" x2="19" y2="18.5" stroke="#a855f7" stroke-width=".9" opacity=".7"/><line x1="8" y1="12.5" x2="26" y2="12.5" stroke="#a855f7" stroke-width=".8" opacity=".4"/><!-- TR: running person / motion (green) --><circle cx="64" cy="7" r="2" fill="#22c55e" opacity=".8"/><path d="M63.5 9L61 14L59 19" stroke="#22c55e" stroke-width="1.4" stroke-linecap="round" fill="none" opacity=".75"/><path d="M62 11L59.5 9.5" stroke="#22c55e" stroke-width="1.2" stroke-linecap="round" opacity=".7"/><path d="M62 11L65 10.5" stroke="#22c55e" stroke-width="1.2" stroke-linecap="round" opacity=".7"/><path d="M61 14L59 19" stroke="#22c55e" stroke-width="1.4" stroke-linecap="round" opacity=".75"/><path d="M61 14L64 19" stroke="#22c55e" stroke-width="1.4" stroke-linecap="round" opacity=".75"/><!-- BL: person detection (sky blue) --><circle cx="18" cy="34" r="2.8" fill="#60a5fa" opacity=".7"/><path d="M12 48C12 42 24 42 24 48" stroke="#60a5fa" stroke-width="1.5" stroke-linecap="round" fill="none" opacity=".65"/><!-- BR: object box (amber) --><rect x="57" y="34" width="14" height="10" rx="1.5" fill="#f59e0b" opacity=".55"/><rect x="59.5" y="31.5" width="5" height="3" rx="1" fill="#f59e0b" opacity=".45"/><!-- Center connector --><circle cx="40" cy="25" r="5.5" fill="#1a2a40" stroke="#3a5878" stroke-width="1.2"/><polygon points="38,22.5 44,25 38,27.5" fill="#4a7090"/></svg>`;
// Count chips for media overview cards
function _mocChip(type,count,title){
  const icons={
    event:`<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="3.8" stroke="#4a7090" stroke-width="1.3"/><path d="M5 3v2l1.5 1" stroke="#4a7090" stroke-width="1.1" stroke-linecap="round"/></svg>`,
    snap:`<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="1" y="2.5" width="8" height="6" rx="1.5" stroke="#4a7090" stroke-width="1.2"/><circle cx="5" cy="5.5" r="1.6" fill="#4a7090"/><path d="M3.5 2.5l.4-1h2.2l.4 1" stroke="#4a7090" stroke-width=".9" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    tl:`<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="1" y="1.5" width="8" height="7" rx="1.5" stroke="#a855f7" stroke-width="1.2"/><line x1="3.5" y1="1" x2="3.5" y2="2.5" stroke="#a855f7" stroke-width="1"/><line x1="6.5" y1="1" x2="6.5" y2="2.5" stroke="#a855f7" stroke-width="1"/><line x1="3.5" y1="7.5" x2="3.5" y2="9" stroke="#a855f7" stroke-width="1"/><line x1="6.5" y1="7.5" x2="6.5" y2="9" stroke="#a855f7" stroke-width="1"/></svg>`
  };
  const clr=type==='tl'?'rgba(168,85,247,.18)':'rgba(74,112,144,.14)';
  const txtClr=type==='tl'?'#c084fc':'var(--muted)';
  return `<span class="moc-count-chip" title="${title}" style="background:${clr};color:${txtClr}">${icons[type]||icons.event} ${count}</span>`;
}
function _mocLabelCounts(counts){
  const LABELS=['person','cat','bird','car','motion'];
  const items=LABELS.filter(l=>counts&&counts[l]>0).map(l=>
    `<span class="moc-label-count-item" style="color:${CAT_COLORS[l]||'var(--muted)'}">${objIconSvg(l,13)} ${counts[l]}</span>`
  );
  if(!items.length) return '';
  return `<div class="moc-label-counts">${items.join('')}</div>`;
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

  const allCard=`<div class="moc-card" onclick="openAllMediaDrilldown()">
    <div class="moc-all-thumb">${_MOC_ALL_SVG}</div>
    <div class="moc-body">
      <div class="moc-name">Alle Medien</div>
      <div class="moc-desc">${cams.length} Kamera${cams.length!==1?'s':''} · Gesamtarchiv</div>
      <div class="moc-storage-row">
        <div class="moc-counts">
          ${_mocChip('event',totalStats.event_count,'Ereignisse')}
          ${_mocChip('snap',totalStats.jpg_count,'Medien')}
          ${_mocChip('tl',totalStats.timelapse_count,'Timelapse')}
        </div>
        <div class="moc-storage-val">${_fmtMb(totalStats.size_mb)}</div>
      </div>
      ${_mocLabelCounts(totalStats.label_counts)}
    </div>
  </div>`;

  const ts=Date.now();
  const camCards=cams.map(c=>{
    const s=statsByid[c.id]||{};
    const icon=getCameraIcon(c.name||c.id);
    const desc=[c.location,c.group_id].filter(Boolean).join(' · ')||'Kamera';
    const storedSnap=s.latest_snap_url||'';
    const liveSnap=`/api/camera/${encodeURIComponent(c.id)}/snapshot.jpg?t=${ts}`;
    const thumbSrc=storedSnap||liveSnap;
    const placeholderInner=`<span style="font-size:48px;opacity:.25">${icon}</span>`;
    const fallback=storedSnap?`this.onerror=function(){this.replaceWith(Object.assign(document.createElement('span'),{innerHTML:'${placeholderInner}',style:'display:flex;align-items:center;justify-content:center;width:100%;height:100%'}))};this.src='${liveSnap}'`
      :`this.replaceWith(Object.assign(document.createElement('span'),{innerHTML:'${placeholderInner}',style:'display:flex;align-items:center;justify-content:center;width:100%;height:100%'}))`;
    return `<div class="moc-card" onclick="openMediaDrilldown('${esc(c.id)}')">
      <div class="moc-thumb"><img src="${esc(thumbSrc)}" alt="${esc(c.name)}" onerror="${esc(fallback)}" loading="lazy"/></div>
      <div class="moc-body">
        <div class="moc-name">${icon} ${esc(c.name)}</div>
        <div class="moc-desc">${esc(desc)}</div>
        <div class="moc-storage-row">
          <div class="moc-counts">
            ${_mocChip('event',s.event_count||0,'Ereignisse')}
            ${_mocChip('snap',s.jpg_count||0,'Medien')}
            ${_mocChip('tl',s.timelapse_count||0,'Timelapse')}
          </div>
          <div class="moc-storage-val">${_fmtMb(s.size_mb||0)}</div>
        </div>
        ${_mocLabelCounts(s.label_counts||{})}
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
      return `<div class="moc-card moc-archived" onclick="openMediaDrilldown('${esc(a.id)}')">
        <div class="moc-thumb moc-arch-thumb">${thumbInner}</div>
        <div class="moc-body">
          <div class="moc-name" style="display:flex;align-items:center;gap:6px">${_ARCHIVE_ICON} <span>${esc(a.name)}</span></div>
          <div class="moc-desc">Archiviert · <code style="font-size:10px;opacity:.6">${esc(a.id)}</code></div>
          <div class="moc-storage-row">
            <div class="moc-counts">
              ${a.event_count?_mocChip('event',a.event_count,'Ereignisse'):''}
              ${a.jpg_count?_mocChip('snap',a.jpg_count,'Medien'):''}
              ${a.timelapse_count?_mocChip('tl',a.timelapse_count,'Timelapse'):''}
            </div>
            <div class="moc-storage-val" style="color:var(--muted)">${_fmtMb(a.size_mb||0)}</div>
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
    {label:'timelapse', name:'Timelapse', clr:CAT_COLORS.timelapse},
  ];
  const _TL_CAT_ICON=`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" style="flex-shrink:0"><rect x="4.5" y="2" width="15" height="2.5" rx="1.2" fill="${CAT_COLORS.timelapse}"/><path d="M5.5 4.5L12 13L18.5 4.5Z" fill="${CAT_COLORS.timelapse}" opacity=".75"/><path d="M5.5 19.5L12 11L18.5 19.5Z" stroke="${CAT_COLORS.timelapse}" stroke-width="1.5" stroke-linejoin="round" fill="none"/><rect x="4.5" y="19.5" width="15" height="2.5" rx="1.2" fill="${CAT_COLORS.timelapse}"/></svg>`;
  const catBtns=_CAT_DEFS.map(({label,name,clr})=>{
    const icon=(label==='timelapse'?_TL_CAT_ICON:(OBJ_SVG[label]||'').replace('width="16" height="16"','width="18" height="18"'));
    return `<button class="cat-filter-btn" onclick="openCategoryDrilldown('${esc(label)}')" style="--cb:${clr}">
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
  window._tlItems=[];
  syncMediaPills();
  byId('mediaOverview').style.display='none';
  byId('mediaDrilldown').style.display='';
  if(label==='timelapse'){
    const tlAll=[];
    for(const c of state.cameras){
      const tlData=await fetch(`/api/camera/${encodeURIComponent(c.id)}/timelapse/list`).then(r=>r.json()).catch(()=>({ok:false,files:[]}));
      if(tlData.ok&&tlData.files&&tlData.files.length){
        tlAll.push(...tlData.files.map(f=>({...f,labels:['timelapse']})));
      }
    }
    window._tlItems=tlAll;
    renderMediaGrid();
  }else{
    await loadMedia();
    renderMediaGrid();
  }
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
function renderMediaGrid(){
  const grid=byId('mediaGrid'); if(!grid) return;
  const tl=window._tlItems||[];
  const labels=state.mediaLabels;
  const onlyTL=labels.size===1&&labels.has('timelapse');
  const hasTL=labels.has('timelapse');
  let items;
  if(onlyTL){
    items=tl;
  } else if(labels.size===0&&tl.length){
    // No filter — merge TL + motion events, sorted by time
    const merged=[...tl,...(state.media||[])].sort((a,b)=>{
      const at=a.mtime||(a.time?new Date(a.time).getTime()/1000:0);
      const bt=b.mtime||(b.time?new Date(b.time).getTime()/1000:0);
      return bt-at;
    });
    items=merged;
  } else if(hasTL&&labels.size>1){
    // TL + other filters: merge TL + filtered motion events
    items=[...tl,...(state.media||[])].sort((a,b)=>{
      const at=a.mtime||(a.time?new Date(a.time).getTime()/1000:0);
      const bt=b.mtime||(b.time?new Date(b.time).getTime()/1000:0);
      return bt-at;
    });
  } else {
    items=state.media||[];
  }
  // Light slide-in on page change
  grid.style.opacity='0';grid.style.transform='translateX(10px)';
  grid.innerHTML=items.map(mediaCardHTML).join('')||'<div class="item muted" style="padding:16px">Keine Medien vorhanden.</div>';
  requestAnimationFrame(()=>{grid.style.transition='opacity .18s ease,transform .18s ease';grid.style.opacity='1';grid.style.transform='';});
  renderMediaPagination();
  window._openMediaItem=id=>{const item=items.find(x=>x.event_id===id); if(item) openLightbox(item);};
}
window._tlItems=[];
async function openAllMediaDrilldown(){
  state.mediaCamera=null;
  state.mediaLabels=new Set(); state.mediaPeriod='week'; state.mediaPage=0;
  window._tlItems=[];
  syncMediaPills();
  byId('mediaOverview').style.display='none';
  byId('mediaDrilldown').style.display='';
  await loadMedia();
  const tlAll=[];
  for(const c of state.cameras){
    const tlData=await fetch(`/api/camera/${encodeURIComponent(c.id)}/timelapse/list`).then(r=>r.json()).catch(()=>({ok:false,files:[]}));
    if(tlData.ok&&tlData.files&&tlData.files.length){
      tlAll.push(...tlData.files.map(f=>({...f,labels:['timelapse']})));
    }
  }
  window._tlItems=tlAll;
  renderMediaGrid();
}
window.openAllMediaDrilldown=openAllMediaDrilldown;
async function openMediaDrilldown(camId){
  state.mediaCamera=camId;
  state.mediaLabels=new Set(); state.mediaPeriod='week'; state.mediaPage=0;
  window._tlItems=[];
  syncMediaPills();
  byId('mediaOverview').style.display='none';
  byId('mediaDrilldown').style.display='';
  document.querySelectorAll('.moc-card').forEach(c=>c.classList.toggle('moc-active',c.onclick?.toString().includes(`'${camId}'`)));
  const [,tlData]=await Promise.all([
    loadMedia(),
    fetch(`/api/camera/${encodeURIComponent(camId)}/timelapse/list`).then(r=>r.json()).catch(()=>({ok:false,files:[]}))
  ]);
  if(tlData.ok && tlData.files && tlData.files.length){
    window._tlItems=tlData.files.map(f=>({...f,labels:['timelapse']}));
  }
  renderMediaGrid();
}
function closeMediaDrilldown(){
  state.mediaCamera=null; state.media=[]; window._tlItems=[];
  byId('mediaDrilldown').style.display='none';
  byId('mediaOverview').style.display='';
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
// ── Row-count slider ─────────────────────────────────────────────────────────
(function(){
  const slider=byId('mediaRowSlider');
  const valEl=byId('mediaRowVal');
  if(!slider||!valEl) return;
  slider.addEventListener('input',()=>{
    valEl.textContent=slider.value;
    if(byId('mediaDrilldown')?.style.display!=='none'&&state._allMedia?.length>=0){
      const ps=calcItemsPerPage(); _cachedPageSize=ps;
      state.mediaTotalPages=Math.max(1,Math.ceil(state._allMedia.length/ps));
      state.mediaPage=0;
      state.media=state._allMedia.slice(0,ps);
      renderMediaGrid();
      renderMediaPagination();
    }
  });
})();
window.deleteMediaCard=async(btn)=>{
  const card=btn.closest('.media-card');
  const eventId=card?.dataset.eventId;
  const camId=card?.dataset.cameraId;
  if(!eventId||!camId) return;
  try{
    await j(`/api/camera/${encodeURIComponent(camId)}/events/${encodeURIComponent(eventId)}`,{method:'DELETE'});
    // Remove from pool, recalculate pages, re-slice so current page stays full
    state._allMedia=(state._allMedia||[]).filter(x=>x.event_id!==eventId);
    const ps_d=calcItemsPerPage();
    state.mediaTotalPages=Math.max(1,Math.ceil(state._allMedia.length/ps_d));
    state.mediaPage=Math.min(state.mediaPage||0,state.mediaTotalPages-1);
    state.media=state._allMedia.slice(state.mediaPage*ps_d,(state.mediaPage+1)*ps_d);
    _decrementMediaOverviewCount(camId);
    renderMediaGrid();
    renderMediaPagination();
  }catch(e){showToast('Löschen fehlgeschlagen: '+e.message,'error');}
};
window.deleteTLCard=async(camId,filename,eventId)=>{
  try{
    await j(`/api/camera/${encodeURIComponent(camId)}/timelapse/${encodeURIComponent(filename)}`,{method:'DELETE'});
    const card=byId('mediaGrid').querySelector(`[data-event-id="${CSS.escape(eventId)}"]`);
    if(card) card.remove();
    state.media=(state.media||[]).filter(x=>x.event_id!==eventId);
    window._tlItems=(window._tlItems||[]).filter(x=>x.event_id!==eventId);
    if(!byId('mediaGrid').querySelector('.media-card')){
      byId('mediaGrid').innerHTML='<div class="item muted" style="padding:16px">Keine Medien vorhanden.</div>';
    }
  }catch(e){showToast('Löschen fehlgeschlagen: '+e.message,'error');}
};
window.confirmMediaCard=async(camId,eventId,btn)=>{
  try{
    await j(`/api/camera/${encodeURIComponent(camId)}/events/${encodeURIComponent(eventId)}/confirm`,{method:'POST'});
    // update state.media in place so lightbox nav stays in sync
    const sIdx=(state.media||[]).findIndex(x=>x.event_id===eventId);
    if(sIdx>=0) state.media[sIdx].confirmed=true;
    const card=byId('mediaGrid').querySelector(`[data-event-id="${CSS.escape(eventId)}"]`);
    if(card){
      card.classList.add('mmc-confirmed');
      const actions=card.querySelector('.mmc-actions');
      if(actions) actions.outerHTML='<span class="media-confirmed-badge">✓</span>';
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

// ── Bird SVG icons ───────────────────────────────────────────────────────────
const BIRD_SVGS={
'blaumeise':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M18 56 L10 58 L12 64 L20 61Z" fill="#4a90d9"/><ellipse cx="36" cy="50" rx="18" ry="12" fill="#f0d060"/><ellipse cx="30" cy="44" rx="17" ry="9" fill="#5a9a40"/><ellipse cx="28" cy="42" rx="15" ry="7" fill="#4a90d9"/><circle cx="52" cy="36" r="11" fill="#f0f0f0"/><ellipse cx="52" cy="27" rx="11" ry="7" fill="#4a90d9"/><rect x="42" y="34" width="18" height="2.5" rx="1.2" fill="#111"/><circle cx="57" cy="32" r="1.8" fill="#111"/><path d="M63 35 L72 34 L63 38Z" fill="#666"/></svg>`,
'kohlmeise':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M18 56 L10 58 L12 64 L20 61Z" fill="#333"/><ellipse cx="36" cy="50" rx="18" ry="12" fill="#f0d060"/><rect x="32" y="40" width="7" height="22" rx="3.5" fill="#111"/><ellipse cx="30" cy="44" rx="17" ry="9" fill="#6a9a30"/><circle cx="52" cy="36" r="11" fill="#111"/><ellipse cx="51" cy="41" rx="7" ry="4.5" fill="#f0f0f0"/><circle cx="57" cy="32" r="1.8" fill="#fff"/><path d="M63 35 L72 34 L63 38Z" fill="#555"/></svg>`,
'rotkehlchen':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M18 57 L10 59 L12 65 L20 62Z" fill="#8b6040"/><ellipse cx="36" cy="51" rx="18" ry="12" fill="#f5f0ea"/><ellipse cx="30" cy="44" rx="16" ry="10" fill="#8b6040"/><circle cx="48" cy="47" r="13" fill="#e05a20"/><circle cx="52" cy="35" r="11" fill="#e05a20"/><circle cx="57" cy="32" r="1.8" fill="#111"/><path d="M63 34 L72 33 L63 37Z" fill="#555"/></svg>`,
'buchfink':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M18 56 L10 58 L12 64 L20 61Z" fill="#a05030"/><ellipse cx="36" cy="50" rx="18" ry="12" fill="#c07060"/><ellipse cx="28" cy="44" rx="17" ry="9" fill="#a05030"/><rect x="18" y="43" width="26" height="3" rx="1.5" fill="#f0f0f0"/><circle cx="52" cy="36" r="11" fill="#7090b0"/><circle cx="57" cy="33" r="1.8" fill="#111"/><path d="M63 35 L72 34 L63 38Z" fill="#606060"/></svg>`,
'amsel':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M14 55 L6 57 L8 64 L16 60Z" fill="#111"/><ellipse cx="36" cy="50" rx="20" ry="13" fill="#111"/><ellipse cx="30" cy="44" rx="18" ry="10" fill="#111"/><circle cx="52" cy="36" r="11" fill="#111"/><circle cx="57" cy="32" r="4" fill="none" stroke="#f08030" stroke-width="2"/><circle cx="57" cy="32" r="1.8" fill="#111"/><path d="M63 35 L74 33 L63 39Z" fill="#f08030"/></svg>`,
'hausspatz':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M18 57 L10 59 L12 65 L20 62Z" fill="#9b6840"/><ellipse cx="36" cy="50" rx="18" ry="12" fill="#d4c4a8"/><ellipse cx="28" cy="44" rx="18" ry="9" fill="#9b6840"/><rect x="16" y="43" width="14" height="2.5" rx="1.2" fill="#c4b090"/><circle cx="52" cy="36" r="11" fill="#d4c4a8"/><ellipse cx="52" cy="27" rx="11" ry="7" fill="#909090"/><ellipse cx="50" cy="41" rx="5.5" ry="3.5" fill="#222"/><circle cx="57" cy="33" r="1.8" fill="#111"/><path d="M63 35 L72 34 L63 38Z" fill="#806040"/></svg>`,
'gruenfink':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M16 55 L8 57 L10 63 L18 60Z" fill="#6a9a20"/><ellipse cx="36" cy="50" rx="19" ry="12" fill="#90bb30"/><ellipse cx="28" cy="44" rx="17" ry="9" fill="#6a9a20"/><rect x="16" y="46" width="24" height="4" rx="2" fill="#e8d020"/><circle cx="52" cy="36" r="11" fill="#90bb30"/><circle cx="57" cy="33" r="1.8" fill="#111"/><path d="M62 34 L74 33 L62 38Z" fill="#d4a010"/></svg>`,
'stieglitz':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M14 55 L6 57 L8 63 L16 60Z" fill="#111"/><ellipse cx="36" cy="50" rx="18" ry="12" fill="#f5f0ea"/><ellipse cx="26" cy="44" rx="17" ry="9" fill="#111"/><rect x="14" y="46" width="28" height="5" rx="2.5" fill="#f0c010"/><circle cx="52" cy="36" r="11" fill="#f5f5f5"/><ellipse cx="46" cy="33" rx="9" ry="9" fill="#111"/><ellipse cx="51" cy="36" rx="8" ry="7" fill="#cc2200"/><circle cx="57" cy="33" r="1.8" fill="#111"/><path d="M62 35 L72 34 L62 38Z" fill="#c0b090"/></svg>`,
'kleiber':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M16 55 L8 57 L10 63 L18 60Z" fill="#6080a0"/><ellipse cx="36" cy="50" rx="18" ry="12" fill="#d07030"/><ellipse cx="28" cy="43" rx="18" ry="9" fill="#6080a0"/><ellipse cx="36" cy="57" rx="12" ry="5" fill="#f5e8d0"/><circle cx="52" cy="36" r="11" fill="#6080a0"/><rect x="40" y="33" width="22" height="3" rx="1.5" fill="#111"/><circle cx="56" cy="30" r="1.8" fill="#fff"/><path d="M62 35 L73 36 L62 40Z" fill="#444"/></svg>`,
'buntspecht':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M12 52 L6 56 L8 62 L14 58Z" fill="#111"/><ellipse cx="36" cy="50" rx="18" ry="12" fill="#111"/><ellipse cx="27" cy="50" rx="9" ry="8" fill="#f5f5f5"/><ellipse cx="36" cy="59" rx="6" ry="4" fill="#cc0000"/><circle cx="52" cy="36" r="11" fill="#111"/><ellipse cx="48" cy="39" rx="6" ry="4.5" fill="#f5f5f5"/><ellipse cx="52" cy="27" rx="9" ry="6" fill="#cc0000"/><circle cx="57" cy="34" r="1.8" fill="#fff"/><path d="M63 35 L74 34 L63 39Z" fill="#555"/></svg>`,
'eichelhaher':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M12 54 L4 57 L6 63 L14 60Z" fill="#c8906c"/><ellipse cx="36" cy="50" rx="20" ry="13" fill="#c8906c"/><ellipse cx="26" cy="46" rx="13" ry="8" fill="#4060e0"/><line x1="18" y1="43" x2="32" y2="43" stroke="#111" stroke-width="1.5"/><line x1="18" y1="47" x2="32" y2="47" stroke="#111" stroke-width="1.5"/><line x1="18" y1="51" x2="32" y2="51" stroke="#111" stroke-width="1.5"/><circle cx="52" cy="36" r="11" fill="#c8906c"/><ellipse cx="52" cy="28" rx="9" ry="6" fill="#f0f0f0"/><rect x="42" y="39" width="14" height="2.5" rx="1.2" fill="#111"/><circle cx="57" cy="33" r="1.8" fill="#111"/><path d="M63 35 L72 34 L63 38Z" fill="#555"/></svg>`,
'elster':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M14 52 L6 48 L4 58 L12 60Z" fill="#111"/><ellipse cx="36" cy="50" rx="18" ry="12" fill="#f5f5f5"/><ellipse cx="27" cy="44" rx="15" ry="9" fill="#111"/><ellipse cx="33" cy="52" rx="9" ry="5" fill="#f5f5f5"/><circle cx="52" cy="36" r="11" fill="#111"/><ellipse cx="48" cy="38" rx="5" ry="4" fill="#1a1a4a" opacity="0.6"/><circle cx="57" cy="32" r="1.8" fill="#fff"/><path d="M63 35 L72 34 L63 38Z" fill="#222"/></svg>`,
'rabenkraehe':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M10 52 L2 55 L4 63 L12 59Z" fill="#111"/><ellipse cx="36" cy="50" rx="22" ry="14" fill="#111"/><ellipse cx="28" cy="43" rx="20" ry="11" fill="#111"/><circle cx="52" cy="35" r="13" fill="#111"/><circle cx="57" cy="31" r="2" fill="#334455"/><path d="M62 33 L76 31 L62 40Z" fill="#111"/><path d="M62 34 L75 32 L62 39Z" fill="#223"/></svg>`,
'maeusebussard':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M14 54 L6 57 L8 63 L16 60Z" fill="#8b5a30"/><ellipse cx="36" cy="50" rx="20" ry="13" fill="#e0c090"/><rect x="20" y="47" width="28" height="3" rx="1.5" fill="#8b5a30" opacity="0.5"/><rect x="22" y="52" width="24" height="2.5" rx="1.2" fill="#8b5a30" opacity="0.4"/><ellipse cx="27" cy="43" rx="18" ry="9" fill="#8b5a30"/><circle cx="52" cy="36" r="11" fill="#c09060"/><circle cx="57" cy="32" r="2" fill="#111"/><path d="M63 34 L73 32 L71 38 L63 38Z" fill="#807060"/></svg>`,
'turmfalke':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="62" width="60" height="3" rx="1.5" fill="#5a3a1a"/><path d="M14 54 L6 57 L8 63 L16 60Z" fill="#cc6030"/><ellipse cx="36" cy="50" rx="20" ry="12" fill="#f0d8a8"/><circle cx="28" cy="50" r="2" fill="#8b5030" opacity="0.6"/><circle cx="36" cy="53" r="2" fill="#8b5030" opacity="0.6"/><circle cx="44" cy="50" r="2" fill="#8b5030" opacity="0.6"/><ellipse cx="26" cy="43" rx="18" ry="9" fill="#cc6030"/><circle cx="52" cy="36" r="11" fill="#7090c0"/><path d="M46 40 L58 38" stroke="#111" stroke-width="2" stroke-linecap="round"/><circle cx="57" cy="32" r="1.8" fill="#111"/><path d="M62 34 L72 32 L70 38 L62 37Z" fill="#807060"/></svg>`
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

// ── Achievement drill-down (placeholder) ─────────────────────────────────────
function openAchievementDrilldown(id, name){
  // navigate to media filtered by species
  state.mediaLabels=new Set();
  state.mediaCamera=null;
  document.querySelector('a[href="#media"]')?.click();
}

// ── Achievements / Trophäen ───────────────────────────────────────────────────
const ACH_DEFS=[
  // Vögel
  {id:'blaumeise',    name:'Blaumeise',     icon:'🐦', cat:'birds'},
  {id:'kohlmeise',    name:'Kohlmeise',     icon:'🐦', cat:'birds'},
  {id:'rotkehlchen',  name:'Rotkehlchen',   icon:'🐦', cat:'birds'},
  {id:'buchfink',     name:'Buchfink',      icon:'🐦', cat:'birds'},
  {id:'amsel',        name:'Amsel',         icon:'🐦', cat:'birds'},
  {id:'hausspatz',    name:'Hausspatz',     icon:'🐦', cat:'birds'},
  {id:'gruenfink',    name:'Grünfink',      icon:'🐦', cat:'birds'},
  {id:'stieglitz',    name:'Stieglitz',     icon:'🐦', cat:'birds'},
  {id:'kleiber',      name:'Kleiber',       icon:'🐦', cat:'birds'},
  {id:'buntspecht',   name:'Buntspecht',    icon:'🐦', cat:'birds'},
  {id:'eichelhaher',  name:'Eichelhäher',   icon:'🦅', cat:'birds'},
  {id:'elster',       name:'Elster',        icon:'🐦', cat:'birds'},
  {id:'rabenkraehe',  name:'Rabenkrähe',    icon:'🐦', cat:'birds'},
  {id:'maeusebussard',name:'Mäusebussard',  icon:'🦅', cat:'birds'},
  {id:'turmfalke',    name:'Turmfalke',     icon:'🦅', cat:'birds'},
  // Säugetiere
  {id:'eichhoernchen_orange',  name:'Eichhörnchen (rot)',     icon:'🐿️', cat:'mammals'},
  {id:'eichhoernchen_schwarz', name:'Eichhörnchen (schwarz)', icon:'🐿️', cat:'mammals'},
  {id:'eichhoernchen_hell',    name:'Eichhörnchen (hell)',    icon:'🐿️', cat:'mammals'},
  {id:'igel',         name:'Igel',          icon:'🦔', cat:'mammals'},
  {id:'feldhase',     name:'Feldhase',      icon:'🐇', cat:'mammals'},
  {id:'reh',          name:'Reh',           icon:'🦌', cat:'mammals'},
  {id:'fuchs',        name:'Fuchs',         icon:'🦊', cat:'mammals'},
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
  const rimC={
    locked:['#0e1820','#283848'],
    bronze:['#4a2408','#c87840'],
    silver:['#303840','#a0b4c4'],
    gold:  ['#402e08','#e0c050'],
  };
  const faceC={
    locked:['#101820','#101820'],
    bronze:['#3a2010','#1e0e04'],
    silver:['#202e38','#101820'],
    gold:  ['#2a2010','#140e04'],
  };
  const hlC={locked:'#4a6888',bronze:'#e09860',silver:'#c0d0e0',gold:'#f0e060'};
  const [rc,re]=rimC[tier];
  const [fc,fe]=faceC[tier];
  const hl=hlC[tier];
  const uid=achId.replace(/[^a-z0-9]/g,'');
  let bird='';
  if(birdSvg){
    const filter=isUnlocked?'':'style="filter:grayscale(1) brightness(0.28)"';
    bird=birdSvg.replace('<svg ',`<svg x="16" y="16" width="68" height="68" ${filter} `);
  }
  return `<svg viewBox="0 0 100 100" width="92" height="92" xmlns="http://www.w3.org/2000/svg">
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

function renderAchievements(){
  const unlocked=ACH_DEFS.filter(a=>_achData[a.id]);
  const total=ACH_DEFS.length;
  const pct=Math.round(unlocked.length/total*100);
  byId('achievementsProgress').innerHTML=`
    <span class="ach-progress-text">🏆 ${unlocked.length} von ${total} entdeckt</span>
    <div class="ach-progress-track"><div class="ach-progress-fill" style="width:${pct}%"></div></div>
    <span class="ach-progress-pct">${pct}%</span>`;

  const legend=`<div class="ach-legend">
    <span><span class="ach-leg-dot" style="background:#c87840;width:14px;height:14px"></span><span style="font-size:13px;font-weight:600">Bronze 1–4×</span></span>
    <span><span class="ach-leg-dot" style="background:#a0b4c4;width:14px;height:14px"></span><span style="font-size:13px;font-weight:600">Silber 5–19×</span></span>
    <span><span class="ach-leg-dot" style="background:#e0c050;width:14px;height:14px"></span><span style="font-size:13px;font-weight:600">Gold 20×+</span></span>
  </div>`;

  const cards=ACH_DEFS.map(a=>{
    const info=_achData[a.id];
    const isUnlocked=!!info;
    const count=isUnlocked?(info.count||1):0;
    const tier=_achTier(count);
    const iconSvg=a.cat==='birds'?(BIRD_SVGS[a.id]||null):(MAMMAL_SVGS[a.id]||null);
    const medalHtml=_medalSVG(a.id,tier,iconSvg,isUnlocked);
    // emoji overlay only when no hand-crafted SVG available
    const emojiOverlay=!iconSvg
      ?`<span class="medal-emoji${isUnlocked?'':' medal-emoji-locked'}">${isUnlocked?a.icon:'🔒'}</span>`
      :'';
    const badge=isUnlocked
      ?`<span class="medal-count-badge ${tier}">${count}×</span>`
      :(iconSvg?`<span class="medal-lock-badge">🔒</span>`:'');
    // count label
    const countColors={bronze:'#d4894a',silver:'#90a8be',gold:'#d4a820'};
    const countLabel=isUnlocked
      ?`<div class="medal-count" style="color:${countColors[tier]||'#d4a820'}">${count}×</div>`
      :`<div class="medal-count locked-text">nicht entdeckt</div>`;
    const clickable=isUnlocked?`onclick="openAchievementDrilldown('${esc(a.id)}','${esc(a.name)}')" style="cursor:pointer"`:'';
    return `<div class="ach-card ${tier}" ${clickable}>
      <div class="medal-wrap">
        ${medalHtml}
        ${emojiOverlay}
        ${badge}
      </div>
      <div class="medal-name">${esc(a.name)}</div>
      ${countLabel}
    </div>`;
  }).join('');

  byId('achievementsGrid').innerHTML=`<div class="ach-cards-grid">${cards}</div>`+legend;
}

// Wire confirm modal
byId('confirmOk')?.addEventListener('click',()=>_resolveConfirm(true));
byId('confirmCancel')?.addEventListener('click',()=>_resolveConfirm(false));
byId('confirmModal')?.addEventListener('click',e=>{if(e.target===byId('confirmModal'))_resolveConfirm(false);});

// Inject random squirrel into hero on page load
(()=>{const sq=SQUIRREL_CHARS[Math.floor(Math.random()*SQUIRREL_CHARS.length)];const el=byId('heroSquirrel');if(el)el.innerHTML=sq;})();

// ── Statistics dashboard ──────────────────────────────────────────────────
const _STAT_LABEL_ICONS={motion:'👁',person:'🧍',cat:'🐈',bird:'🐦',car:'🚗',dog:'🐕',fox:'🦊',hedgehog:'🦔',squirrel:'🐿️',horse:'🐴'};
const _STAT_LABEL_COLORS={motion:'#36a2ff',person:'#ff6b6b',cat:'#9b8cff',bird:'#62d26f',car:'#00c2ff',dog:'#ffb020',fox:'#ff7a1a',hedgehog:'#a67c52',squirrel:'#c8651a'};
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
      const color=_STAT_LABEL_COLORS[label]||'var(--accent)';
      const lblCls=STAT_MEDIA_DRILLDOWN?'stat-label-row stat-drillable':'stat-label-row';
      const lblClick=STAT_MEDIA_DRILLDOWN?`onclick="_statOpenMedia('','${esc(label)}')"`:'' ;
      return `<div class="${lblCls}" ${lblClick}>
        <div class="stat-label-icon">${_STAT_LABEL_ICONS[label]||'🔍'}</div>
        <div class="stat-label-info">
          <div class="stat-label-name">${esc(label)}</div>
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
