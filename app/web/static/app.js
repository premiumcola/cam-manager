
const state={config:null,cameras:[],groups:[],timeline:null,media:[],camera:'',label:'',period:'week',bootstrap:null,mediaCamera:null,mediaStats:[],mediaLabel:'',mediaPeriod:'week'};

// ── Toast & Confirm helpers ───────────────────────────────────────────────────
window.showToast=function(msg,type='info'){
  const c=byId('toastContainer'); if(!c) return;
  const t=document.createElement('div');
  t.className=`toast ${type}`;
  t.innerHTML=`<span class="toast-msg">${esc(msg)}</span><button class="toast-close" onclick="this.closest('.toast').remove()">✕</button>`;
  c.appendChild(t);
  const dismiss=()=>{ t.classList.add('toast-out'); t.addEventListener('animationend',()=>t.remove(),{once:true}); };
  setTimeout(dismiss,4000);
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
const colors={bird:'#70d6ff',cat:'#ff8cc6',person:'#ffd166',car:'#9c89ff',motion:'#7ee787',alarm:'#ff6b6b',unknown:'#91a4b8'};
function getCameraIcon(name){const n=(name||'').toLowerCase();if(/werkstatt|garage|keller|labor/.test(n))return'🔧';if(/eingang|tor|tür|door/.test(n))return'🚪';if(/garten|garden|außen|outdoor/.test(n))return'🌿';if(/eichhörnchen|squirrel|tier|animal|natur/.test(n))return'🐿️';if(/vogel|bird|futter|feeder/.test(n))return'🐦';if(/parkplatz|auto|car/.test(n))return'🚗';if(/pool|wasser|water/.test(n))return'💧';return'📷';}
const shapeState={mode:'zone',points:[],camera:null,zones:[],masks:[]};
const byId=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]));
const j=async(url,opt)=>{const r=await fetch(url,opt); if(!r.ok) throw new Error(await r.text()); return r.json();};
const download=(url)=>window.open(url,'_blank');

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
const _prevCamStatuses=new Map();
function startLiveUpdate(){
  if(_liveUpdateInterval) clearInterval(_liveUpdateInterval);
  state.cameras.forEach(c=>_prevCamStatuses.set(c.id,c.status));
  _liveUpdateInterval=setInterval(async()=>{
    try{
      const r=await j('/api/cameras');
      (r.cameras||[]).forEach(c=>{
        const prev=_prevCamStatuses.get(c.id);
        if(prev===c.status) return;
        _prevCamStatuses.set(c.id,c.status);
        const wasOffline=prev==='starting'||prev==='disabled'||prev==null;
        // Dashboard card: refresh snapshot image on status change
        const card=byId('cameraCards')?.querySelector(`[data-camid="${CSS.escape(c.id)}"]`);
        if(card){
          // Update stream status icon class
          const stIcon=card.querySelector('.cv-st-active,.cv-st-error,.cv-st-warn,.cv-icon[title^="Stream"]');
          if(stIcon){
            stIcon.classList.remove('cv-st-active','cv-st-error','cv-st-warn');
            stIcon.classList.add(c.status==='active'?'cv-st-active':c.status==='error'?'cv-st-error':'cv-st-warn');
          }
          // Always refresh snapshot periodically (every cycle when image is visible)
          const img=card.querySelector('.cv-img');
          if(img){const base=img.src.split('?')[0];img.src=base+'?t='+Date.now();}
        }
        // Camera settings list badge
        const item=byId('cameraSettingsList')?.querySelector(`[data-camid="${CSS.escape(c.id)}"]`);
        if(item){
          const stCol=s=>s==='active'?'good':s==='error'?'danger':'warn';
          const b=item.querySelector('.badge');
          if(b){b.className=`badge ${stCol(c.status)}`;b.textContent=c.status||'—';}
        }
      });
    }catch{/* silent */}
  },3000);
  ['liveIndicator','liveIndicatorDesktop'].forEach(id=>{const el=byId(id);if(el)el.classList.remove('hidden');});
}

async function loadAll(){
  _restoreEditWrapper();
  state.bootstrap=await j('/api/bootstrap');
  state.config=await j('/api/config');
  state.groups=(await j('/api/groups')).groups||[];
  state.cameras=(await j('/api/cameras')).cameras||[];
  state.timeline=await j(`/api/timeline?period=${state.period}${state.label?`&label=${encodeURIComponent(state.label)}`:''}`);
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
  if(state.bootstrap.needs_wizard) openWizard();
  byId('openWizardBtn').classList.toggle('hidden', !!state.bootstrap?.wizard_completed || !state.bootstrap?.needs_wizard);
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
async function loadMedia(append=false){
  const LIMIT=Number(byId('ms_media_limit')?.value)||24;
  if(!append){ state.media=[]; state.mediaOffset=0; }
  const cams = state.mediaCamera ? [state.mediaCamera] : state.cameras.map(c=>c.id);
  const page=[];
  let hasMore=false;
  const periodParams=_mediaPeriodParams();
  for(const camId of cams){
    const data=await j(`/api/camera/${camId}/media?limit=${LIMIT}&offset=${state.mediaOffset||0}${state.mediaLabel?`&label=${encodeURIComponent(state.mediaLabel)}`:''}${periodParams}`);
    const items=data.items||[];
    if(items.length>=LIMIT) hasMore=true;
    for(const item of items) page.push({...item,camera_id:camId});
  }
  page.sort((a,b)=>(b.time||'').localeCompare(a.time||''));
  state.media=[...(state.media||[]),...page];
  state.mediaHasMore=hasMore;
  state.mediaOffset=(state.mediaOffset||0)+LIMIT;
}
async function loadMoreMedia(){
  await loadMedia(true);
  renderMediaGrid();
}

function renderShell(){
  byId('appName').textContent=state.config.app.name||'TAM-spy';
  byId('sideAppName').textContent=state.config.app.name||'TAM-spy';
  const tb=byId('topbarTitle'); if(tb) tb.textContent=state.config.app.name||'TAM-spy';
  byId('appTagline').textContent=state.config.app.tagline||'Schlicht, funktional, analytisch';
  byId('groupSelect').innerHTML=state.groups.map(g=>`<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
  byId('globalSummary').textContent=`${state.cameras.length} Kameras · Coral ${state.config.coral.mode} · Telegram ${state.config.telegram.enabled?'an':'aus'} · MQTT ${state.config.mqtt.enabled?'an':'aus'}`;
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
  byId('cameraCards').innerHTML=cams.map(c=>{
    const stCls=c.status==='active'?'cv-st-active':c.status==='error'?'cv-st-error':'cv-st-warn';
    const armedCls=c.armed?'cv-armed':'cv-unarmed';
    const snapUrl=`/api/camera/${esc(c.id)}/snapshot.jpg?t=${Date.now()}`;
    const groupColor=colors[c.group_id]||'#566d84';
    return `<article class="cv-card" data-camid="${esc(c.id)}" onclick="_cvCardClick(event,'${esc(c.id)}')">
  <div class="cv-frame">
    <div class="cv-img-wrap">
      <div class="cv-loading-placeholder"><div class="cv-loading-icon">⟳</div><div class="cv-loading-text">Verbinde…</div></div>
      <img class="cv-img cam-snap" src="${snapUrl}" alt="${esc(c.name)}"
        onload="this.classList.add('loaded');this.previousElementSibling.style.display='none'"
        onerror="this.style.display='none'" />
    </div>
    <div class="cv-grad-top"></div>
    <div class="cv-grad-bot"></div>

    <!-- top-left: name + group -->
    <div class="cv-title-wrap">
      <div class="cv-name">${esc(c.name)}</div>
      ${c.location?`<div class="cv-loc">${esc(c.location)}</div>`:''}
      <span class="cv-group-pill">${getCameraIcon(c.name)} ${esc(c.group_id||'—')}</span>
    </div>

    <!-- top-right: status icons -->
    <div class="cv-icons">
      <button class="cv-icon ${armedCls}" title="${c.armed?'Scharf – klicken zum Unscharf':'Unscharf – klicken zum Scharf'}"
        onclick="event.stopPropagation();toggleArm('${esc(c.id)}',${!c.armed})">
        ${c.armed?'🔴':'🟢'}
      </button>
      <span class="cv-icon ${stCls}" title="Stream: ${esc(c.status||'—')}">📹</span>
      <span class="cv-icon" title="Heute: ${c.today_events||0} Erkennungen">
        <span class="cv-count">${c.today_events||0}</span>
      </span>
    </div>

    <!-- bottom: hover actions -->
    <div class="cv-actions">
      <button class="cv-act-btn" title="Bearbeiten" onclick="event.stopPropagation();editCamera('${esc(c.id)}')">⚙️</button>
      <button class="cv-act-btn" title="Timelapse" onclick="event.stopPropagation();loadTimelapse('${esc(c.id)}')">⏱️</button>
      <button class="cv-act-btn" title="${c.armed?'Unscharf schalten':'Scharf schalten'}"
        onclick="event.stopPropagation();toggleArm('${esc(c.id)}',${!c.armed})">${c.armed?'🔕':'🔔'}</button>
    </div>
  </div>
</article>`;
  }).join('');
}

// ── Timeline tooltip ─────────────────────────────────────────────────────────
let _tlHoverTarget=null;
function _tlShow(el,evt){
  const tt=byId('tlTooltip'); if(!tt) return;
  const time=el.dataset.time||'';
  const dur=Number(el.dataset.dur||0);
  const labels=(el.dataset.labels||'').split(',').filter(Boolean);
  const snap=el.dataset.snap||'';
  const vid=el.dataset.vid||'';
  const count=Number(el.dataset.count||1);
  let html=`<div class="tl-tt-time">${esc(time.replace('T',' '))}</div>`;
  if(dur>1) html+=`<div class="tl-tt-dur">Dauer: ${dur < 60 ? dur+'s' : Math.round(dur/60)+'min'}</div>`;
  if(count>1) html+=`<div class="tl-tt-dur">${count} Ereignisse</div>`;
  html+=`<div class="tl-tt-labels">${labels.map(l=>`<span class="chip" style="background:${colors[l]||colors.unknown}20;color:${colors[l]||colors.unknown}">${esc(l)}</span>`).join('')}</div>`;
  if(vid){
    html+=`<video class="tl-tt-media" src="${esc(vid)}" autoplay muted loop playsinline></video>`;
  } else if(snap){
    html+=`<img class="tl-tt-media" src="${esc(snap)}" alt="snapshot" loading="lazy"/>`;
  }
  tt.innerHTML=html;
  // Position popup near mouse, avoid overflow
  const svgEl=byId('timelineSvg');
  const svgRect=svgEl.getBoundingClientRect();
  const mx=evt.clientX-svgRect.left, my=evt.clientY-svgRect.top;
  const svgW=svgRect.width, svgH=svgRect.height;
  const ttW=230,ttH=snap||vid?240:100;
  let lx=mx+14, ly=my-20;
  if(lx+ttW>svgW) lx=mx-ttW-14;
  if(ly+ttH>svgH) ly=svgH-ttH-8;
  if(ly<0) ly=4;
  tt.style.left=lx+'px'; tt.style.top=ly+'px';
  tt.classList.remove('hidden');
  _tlHoverTarget=el;
}
function _tlHide(){ const tt=byId('tlTooltip'); if(tt) tt.classList.add('hidden'); _tlHoverTarget=null; }

// ── Group timeline events within GAP_MS ──────────────────────────────────────
function _groupTimelineEvents(points,GAP_MS=30000){
  const groups=[];
  let curr=null;
  for(const p of points){
    const t=new Date(p.time).getTime();
    if(!t) continue;
    if(!curr||t-curr.endTime>GAP_MS){
      curr={startTime:t,endTime:t,events:[p],labels:[...(p.labels||[])],
        top_label:p.top_label,alarm_level:p.alarm_level,
        snapshot_url:p.snapshot_url||'',video_url:p.video_url||'',event_id:p.event_id};
      groups.push(curr);
    } else {
      curr.endTime=t;
      curr.events.push(p);
      const merged=new Set([...curr.labels,...(p.labels||[])]);
      curr.labels=[...merged];
      if(p.alarm_level==='alarm') curr.alarm_level='alarm';
      if(!curr.video_url&&p.video_url) curr.video_url=p.video_url;
      if(!curr.snapshot_url&&p.snapshot_url) curr.snapshot_url=p.snapshot_url;
    }
  }
  return groups;
}

function renderTimeline(){
  const svg=byId('timelineSvg');
  const w=1200,h=340,left=160,top=40,right=24,bottom=34;
  const tracks=state.timeline?.tracks||[];
  if(!tracks.length){ svg.innerHTML=''; return; }
  const points=(state.timeline.merged||[]);
  const times=points.map(p=>new Date(p.time).getTime()).filter(Boolean);
  const tMin=Math.min(...times,Date.now()-3600_000), tMax=Math.max(...times,Date.now());
  const xOf=t=>left+((new Date(t).getTime()-tMin)/Math.max(1,tMax-tMin))*(w-left-right);
  const rowH=Math.max(52,(h-top-bottom)/Math.max(1,tracks.length));
  const yOf=i=>top+rowH*i+rowH/2;
  let out=`<rect x="0" y="0" width="${w}" height="${h}" fill="#0b131b" rx="18"/>`;
  tracks.forEach((tr,i)=>{
    out+=`<line x1="${left}" y1="${yOf(i)}" x2="${w-right}" y2="${yOf(i)}" stroke="#213241" stroke-width="1"/>`;
    const _cam=(state.config?.cameras||[]).find(c=>c.id===tr.camera_id)||{};
    const _icon=_cam.icon||getCameraIcon(_cam.name||tr.camera_id);
    const _name=(_cam.name||tr.camera_id);
    // Two-line label: icon + name (split long names at space/hyphen)
    out+=`<text x="8" y="${yOf(i)-6}" font-size="14">${_icon}</text>`;
    if(_name.length<=18){
      out+=`<text x="8" y="${yOf(i)+9}" fill="#cfe7ff" font-size="12" font-weight="600">${esc(_name)}</text>`;
    } else {
      const splitIdx=_name.slice(0,18).lastIndexOf(' ')>0?_name.slice(0,18).lastIndexOf(' '):_name.slice(0,18).lastIndexOf('-');
      const cut=splitIdx>0?splitIdx:17;
      out+=`<text x="8" y="${yOf(i)-2}" fill="#cfe7ff" font-size="11" font-weight="600">${esc(_name.slice(0,cut))}</text>`;
      out+=`<text x="8" y="${yOf(i)+12}" fill="#cfe7ff" font-size="11" font-weight="600">${esc(_name.slice(cut+1)||_name.slice(cut))}</text>`;
    }
  });
  // X-axis time labels
  for(let k=0;k<6;k++){
    const tx=left+((w-left-right)/5)*k;
    const t=new Date(tMin+((tMax-tMin)/5)*k);
    const lbl=t.getHours().toString().padStart(2,'0')+':'+t.getMinutes().toString().padStart(2,'0');
    out+=`<line x1="${tx}" y1="${top-10}" x2="${tx}" y2="${h-bottom}" stroke="#172532" stroke-width="1"/>`;
    out+=`<text x="${tx}" y="${h-bottom+16}" fill="#566d84" font-size="11" text-anchor="middle">${lbl}</text>`;
  }
  // Draw bars and dots per track
  tracks.forEach((tr,i)=>{
    const groups=_groupTimelineEvents(tr.points||[]);
    groups.forEach(g=>{
      const cx=xOf(g.startTime), cy=yOf(i);
      const topLabel=g.labels.find(l=>l!=='motion')||g.labels[0]||'motion';
      const fill=colors[topLabel]||colors.unknown;
      const durMs=g.endTime-g.startTime;
      const barW=Math.max(8,xOf(g.endTime)-cx);
      const isBar=g.events.length>1||durMs>2000;
      const isAlarm=g.alarm_level==='alarm';
      const barH=isAlarm?14:10;
      const snapEnc=esc(g.snapshot_url||'');
      const vidEnc=esc(g.video_url||'');
      const labEnc=esc(g.labels.join(','));
      const timeEnc=esc(g.events[0]?.time||'');
      const durSec=Math.round(durMs/1000);
      const da=`data-snap="${snapEnc}" data-vid="${vidEnc}" data-labels="${labEnc}" data-time="${timeEnc}" data-dur="${durSec}" data-count="${g.events.length}"`;
      const icon=OBJ_ICONS[isAlarm?'alarm':topLabel]||OBJ_ICONS.unknown;
      if(isBar){
        const iconSize=Math.min(barH*0.9,13);
        out+=`<rect ${da} x="${cx}" y="${cy-barH/2}" width="${barW}" height="${barH}" rx="6" fill="${fill}" fill-opacity="0.4" stroke="#fff" stroke-opacity=".25" class="tl-shape" style="cursor:pointer"/>`;
        if(barW>20) out+=`<text x="${cx+barW/2}" y="${cy+5}" text-anchor="middle" font-size="${iconSize}px" style="pointer-events:none;user-select:none">${icon}</text>`;
      } else {
        const r=isAlarm?9:6;
        out+=`<text ${da} x="${cx+r}" y="${cy+5}" text-anchor="middle" font-size="14px" class="tl-shape" style="cursor:pointer;user-select:none">${icon}</text>`;
      }
    });
  });
  svg.innerHTML=out;
  // Attach hover events via delegation
  svg.onmousemove=evt=>{
    const el=evt.target.closest('.tl-shape');
    if(el&&el!==_tlHoverTarget) _tlShow(el,evt);
    else if(!el) _tlHide();
  };
  svg.onmouseleave=_tlHide;
}

const OBJ_ICONS={person:'👤',cat:'🐱',bird:'🐦',car:'🚗',motion:'〰️',alarm:'🚨',unknown:'❓'};

// ── RTSP path options (shared with discovery) ────────────────────────────────
const RTSP_PATH_OPTS=[
  {label:'Reolink – Main',   value:'/h264Preview_01_main'},
  {label:'Reolink – Sub',    value:'/h264Preview_01_sub'},
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

function renderCameraSettings(){
  const stCol=s=>s==='active'?'good':s==='error'?'danger':'warn';
  byId('cameraSettingsList').innerHTML=state.cameras.map(c=>`
    <div class="cam-item" data-camid="${esc(c.id)}">
      <div class="cam-item-head">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:22px;line-height:1;flex-shrink:0">${getCameraIcon(c.name)}</span>
          <div>
            <div style="font-weight:700;font-size:15px">${esc(c.name)}</div>
            <div class="small">${esc(c.location||'—')} · ${esc(c.group_id||'—')}</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="badge ${stCol(c.status)}">${esc(c.status||'—')}</span>
          <span class="badge ${c.armed?'danger':'good'}">${c.armed?'scharf':'unscharf'}</span>
          <button class="btn-action" onclick="editCamera('${esc(c.id)}')">✏️ Bearbeiten</button>
        </div>
      </div>
    </div>`).join('');
}

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
  // Armed → show/hide schedule
  f['armed']?.addEventListener('change',()=>{ byId('camScheduleSection')?.classList.toggle('hidden',!f['armed'].checked); });
  // Timelapse toggle
  f['timelapse_enabled']?.addEventListener('change',()=>{ byId('timelapseSettingsPanel')?.classList.toggle('hidden',!f['timelapse_enabled'].checked); });
  // Timelapse sliders
  f['tl_daily_seconds']?.addEventListener('input',()=>{ byId('tlDailyLabel').textContent=f['tl_daily_seconds'].value+'s'; });
  f['tl_weekly_seconds']?.addEventListener('input',()=>{ byId('tlWeeklyLabel').textContent=f['tl_weekly_seconds'].value+'s'; });
  // Motion sensitivity slider
  f['motion_sensitivity']?.addEventListener('input',()=>{ byId('motionSensLabel').textContent=f['motion_sensitivity'].value; });
}

function editCamera(camId){
  const c=(state.config?.cameras||[]).find(x=>x.id===camId)||(state.cameras||[]).find(x=>x.id===camId);
  if(!c){console.error('editCamera: not found',camId); return;}
  // Toggle: clicking same camera closes the panel
  if(_currentEditCamId===camId){_closeEditPanel(); return;}
  // Switch camera: restore immediately then open new
  _restoreEditWrapper();
  _initCameraFormListeners();
  initRtspBuilder();
  const f=byId('cameraForm').elements;
  f['id'].value=c.id||''; f['id'].dataset.autoGen='0';
  f['name'].value=c.name||''; f['location'].value=c.location||'';
  if(f['icon']) f['icon'].value=c.icon||getCameraIcon(c.name||c.id);
  byId('cameraEditTitle').textContent=`Kamera bearbeiten · ${c.name||c.id}`;
  const p=parseRtspUrl(c.rtsp_url||'');
  f['rtsp_ip'].value=p.host||''; f['rtsp_user'].value=p.user||''; f['rtsp_pass'].value=p.pass||''; f['rtsp_port'].value=p.port||'554';
  const matchedPath=RTSP_PATH_OPTS.find(o=>o.value===p.path);
  if(f['rtsp_path']) f['rtsp_path'].value=matchedPath?matchedPath.value:RTSP_PATH_OPTS[0].value;
  f['rtsp_url'].value=c.rtsp_url||'';
  f['snapshot_url'].value=c.snapshot_url||''; f['group_id'].value=c.group_id||'';
  f['object_filter'].value=(c.object_filter||[]).join(',');
  f['enabled'].checked=!!c.enabled; f['armed'].checked=!!c.armed;
  byId('camScheduleSection')?.classList.toggle('hidden',!c.armed);
  f['schedule_start'].value=(c.schedule&&c.schedule.start)||''; f['schedule_end'].value=(c.schedule&&c.schedule.end)||''; f['schedule_enabled'].checked=!!(c.schedule&&c.schedule.enabled);
  if(f['telegram_enabled']) f['telegram_enabled'].checked=(c.telegram_enabled!==false);
  if(f['mqtt_enabled']) f['mqtt_enabled'].checked=(c.mqtt_enabled!==false);
  const tlOn=!!(c.timelapse&&c.timelapse.enabled);
  f['timelapse_enabled'].checked=tlOn; byId('timelapseSettingsPanel')?.classList.toggle('hidden',!tlOn);
  const tlDaily=(c.timelapse&&c.timelapse.daily_target_seconds)||60;
  const tlWeekly=(c.timelapse&&c.timelapse.weekly_target_seconds)||180;
  if(f['tl_daily_seconds']){f['tl_daily_seconds'].value=tlDaily; byId('tlDailyLabel').textContent=tlDaily+'s';}
  if(f['tl_weekly_seconds']){f['tl_weekly_seconds'].value=tlWeekly; byId('tlWeeklyLabel').textContent=tlWeekly+'s';}
  if(f['timelapse_telegram']) f['timelapse_telegram'].checked=!!(c.timelapse&&c.timelapse.telegram_send);
  if(f['bottom_crop_px']) f['bottom_crop_px'].value=c.bottom_crop_px||0;
  if(f['motion_sensitivity']){const ms=c.motion_sensitivity!=null?c.motion_sensitivity:0.5; f['motion_sensitivity'].value=ms; byId('motionSensLabel').textContent=ms;}
  j('/api/persons').then(r=>_renderWhitelistChips(r.profiles||[],c.whitelist_names||[])).catch(()=>_renderWhitelistChips([],c.whitelist_names||[]));
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
  byId('groupList').innerHTML=state.groups.map(g=>`<div class="group-row" data-gid="${esc(g.id)}">
    <div class="group-row-info">
      <strong style="font-size:13px">${esc(g.name)}</strong>
      <span class="small muted">${esc(g.category)} · ${esc(g.alarm_profile)} · ${(g.fine_models||[]).join(', ')||'ohne Feinstufe'}</span>
    </div>
    <button style="background:var(--accent);color:#fff;border:none;border-radius:10px;padding:6px 14px;font-size:13px;font-weight:600;cursor:pointer" onclick='toggleGroupEdit(${JSON.stringify(g).replace(/'/g,"&apos;")})'>✏️ Bearbeiten</button>
  </div>`).join('');
}

const _GRP_COARSE=['person','cat','bird','car','motion'];
const _GRP_ICONS={person:'👤',cat:'🐱',bird:'🐦',car:'🚗',motion:'〰️'};
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
      style="padding:7px 14px;border-radius:999px;border:none;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;background:${on?'var(--accent)':'var(--surface)'};color:${on?'#fff':'var(--muted)'}">${_GRP_ICONS[obj]} ${obj}</button>`;
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
window._cvCardClick=function(e,camId){ /* clicking the card itself does nothing extra */ };
async function loadTimelapse(camId){ try{ const r=await j(`/api/camera/${camId}/timelapse`); if(r.url) window.open(r.url,'_blank'); }catch(e){ showToast('Kein Zeitraffer verfügbar.','warn'); } }
window.loadTimelapse=loadTimelapse;

function hydrateSettings(){
  const server=state.config.server||{}, mqtt=state.config.mqtt||{};
  const proc=state.config.processing||{}, coral=state.config.coral||{};
  // App section
  const pubEl=byId('set_public_base_url'); if(pubEl) pubEl.value=server.public_base_url||'';
  const subEl=byId('set_discovery_subnet'); if(subEl) subEl.value=state.config.default_discovery_subnet||'';
  updateAppInfoPanel();
  // MQTT section
  const mqttEn=byId('mqtt_enabled'); if(mqttEn) mqttEn.checked=!!mqtt.enabled;
  const mqttH=byId('mqtt_host'); if(mqttH) mqttH.value=mqtt.host||'';
  const mqttP=byId('mqtt_port'); if(mqttP) mqttP.value=mqtt.port||1883;
  const mqttU=byId('mqtt_username'); if(mqttU) mqttU.value=mqtt.username||'';
  const mqttPw=byId('mqtt_password'); if(mqttPw) mqttPw.value=mqtt.password||'';
  const mqttT=byId('mqtt_base_topic'); if(mqttT) mqttT.value=mqtt.base_topic||'tam-spy';
  // Coral section
  const coralEn=byId('coral_enabled'); if(coralEn) coralEn.checked=!!(proc.coral_enabled ?? coral.mode==='coral');
  const birdEn=byId('bird_species_enabled'); if(birdEn) birdEn.checked=!!(proc.bird_species_enabled ?? coral.bird_species_enabled);
  const hint=byId('coralStatusHint');
  if(hint){
    const cam=state.cameras[0];
    const available=cam?.coral_available; const reason=cam?.coral_reason||'—';
    hint.innerHTML=available
      ? '✅ Coral TPU erkannt und aktiv.'
      : `⚠️ Coral nicht verfügbar: <code>${esc(reason)}</code>`;
  }
  // Hydrate media settings form
  const storageSec=state.config.storage||{};
  const mlVal=storageSec.media_limit_default||24;
  const mlEl=byId('ms_media_limit'); if(mlEl){ mlEl.value=mlVal; }
  const mlLbl=byId('ms_media_limit_val'); if(mlLbl) mlLbl.textContent=mlVal+' Fotos';
  const rdVal=storageSec.retention_days||14;
  const rdEl=byId('ms_retention_days'); if(rdEl) rdEl.value=rdVal;
  const rdLbl=byId('ms_retention_days_val'); if(rdLbl) rdLbl.textContent=rdVal+' Tage';
  const acEl=byId('ms_auto_cleanup'); if(acEl) acEl.checked=!!storageSec.auto_cleanup_enabled;
}

function updateAppInfoPanel(){
  const panel=byId('appInfoPanel'); if(!panel) return;
  const proc=state.config?.processing||{}, coral=state.config?.coral||{};
  const stor=state.config?.storage||{};
  const bs=state.bootstrap||{};
  const coralActive=!!(proc.coral_enabled ?? coral.mode==='coral');
  const coralModeStr=coralActive?'✅ Coral TPU':'⬜ Software only';
  const storagePath=stor.root||bs.storage_root||'storage/';
  const mediaLimit=stor.media_limit_default||24;
  const version=bs.version||'—';
  panel.innerHTML=`
    <div class="app-info-item"><span class="app-info-label">Version</span><span class="app-info-val">${esc(version)}</span></div>
    <div class="app-info-item"><span class="app-info-label">Coral-Modus</span><span class="app-info-val">${coralModeStr}</span></div>
    <div class="app-info-item"><span class="app-info-label">Storage-Pfad</span><span class="app-info-val"><code>${esc(storagePath)}</code></span></div>
    <div class="app-info-item"><span class="app-info-label">Medien-Limit</span><span class="app-info-val">${esc(mediaLimit)} Fotos/Kamera</span></div>
  `;
}

// ── Telegram page hydrate & logic ─────────────────────────────────────────────
const TG_OBJECTS=['person','cat','bird','car','motion'];

function hydrateTelegram(){
  const tg=state.config?.telegram||{};
  const el=byId('tg_enabled'); if(el) el.checked=!!tg.enabled;
  const tok=byId('tg_token'); if(tok) tok.value=tg.token||'';
  const cid=byId('tg_chat_id'); if(cid) cid.value=tg.chat_id||'';
  // Format
  const fmt=tg.format||'photo';
  document.querySelectorAll('[name="tg_format"]').forEach(r=>r.checked=r.value===fmt);
  renderTgFormatPreview(fmt);
  // Group rules
  renderTgGroupRules();
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
            <span>${esc(obj)}</span>
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
// alias so discovery modal code still works
const RTSP_PATHS=RTSP_PATH_OPTS;

function closeDiscoveryModal(){
  byId('discoveryModal').classList.add('hidden');
  document.body.style.overflow='';
}
let _discoveryItems=[];
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
    return `<div class="item" data-disc-ip="${esc(x.ip)}">
      <div class="item-head">
        <div>
          <strong>${esc(x.ip)}</strong>
          ${already?'<span class="badge good" style="margin-left:8px;font-size:11px">✓ Bereits konfiguriert</span>':''}
        </div>
        <span class="small muted">Ports: ${esc(ports)}</span>
      </div>
      <div class="small" style="color:${already?'var(--good)':'var(--muted)'};margin-bottom:6px">${vendor}</div>
      ${already?'':(`<div id="disc_form_wrap_${uid}">
        <div class="discovery-creds">
          <input id="disc_user_${uid}" class="disc-input" placeholder="Benutzer" value="admin" />
          <input id="disc_pass_${uid}" class="disc-input" type="password" placeholder="Passwort" />
          <select id="disc_path_${uid}" class="disc-select">${pathOpts}</select>
        </div>
        <div id="disc_add_form_${uid}" class="disc-add-form hidden">
          <div class="discovery-creds" style="margin-top:8px">
            <input id="disc_name_${uid}" class="disc-input" placeholder="Kameraname" value="${esc(vendor)}" style="flex:1.5"/>
            <select id="disc_group_${uid}" class="disc-select" style="flex:1">${groupOpts}</select>
          </div>
          <div style="display:flex;gap:8px;margin-top:6px">
            <button class="action-btn" style="flex:1;background:var(--accent)" onclick="saveDiscoveryCamera('${esc(x.ip)}')">💾 Kamera speichern</button>
            <button class="action-btn" style="flex:0 0 auto" onclick="byId('disc_add_form_${uid}').classList.add('hidden')">Abbrechen</button>
          </div>
        </div>
        <div class="chip-row" style="margin-top:8px">
          <button class="action-btn" onclick="openDiscoveryAddForm('${esc(x.ip)}')">+ Kamera hinzufügen</button>
        </div>
      </div>`)}
    </div>`;
  }).join('');
}

byId('discoverBtn').onclick=async()=>{
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
};
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
  const camId='cam-'+ip.replace(/\./g,'-');
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
  const payload={id:f['id'].value,name:f['name'].value,location:f['location'].value,
    icon:f['icon']?.value||getCameraIcon(f['name'].value),
    rtsp_url:f['rtsp_url'].value,snapshot_url:f['snapshot_url'].value,
    username:f['rtsp_user']?.value||'',password:f['rtsp_pass']?.value||'',
    group_id:f['group_id'].value,role:f['group_id'].selectedOptions[0]?.textContent||f['group_id'].value,
    object_filter:f['object_filter'].value.split(',').map(x=>x.trim()).filter(Boolean),
    enabled:f['enabled'].checked,armed:f['armed'].checked,
    telegram_enabled:f['telegram_enabled'].checked,mqtt_enabled:f['mqtt_enabled'].checked,
    whitelist_names:_whitelistState.filter(Boolean),
    timelapse:{enabled:f['timelapse_enabled'].checked,fps:12,daily_target_seconds:parseInt(f['tl_daily_seconds']?.value||'60'),weekly_target_seconds:parseInt(f['tl_weekly_seconds']?.value||'180'),telegram_send:!!(f['timelapse_telegram']?.checked)},
    schedule:{enabled:f['schedule_enabled'].checked,start:f['schedule_start'].value||'22:00',end:f['schedule_end'].value||'06:00'},
    bottom_crop_px:parseInt(f['bottom_crop_px']?.value||0),
    motion_sensitivity:parseFloat(f['motion_sensitivity']?.value||0.5),
    zones:JSON.parse(f['zones_json'].value||'[]'),masks:JSON.parse(f['masks_json'].value||'[]')};
  const _savedId=payload.id; _restoreEditWrapper();
  await fetch('/api/settings/cameras',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  await fetch(`/api/camera/${encodeURIComponent(_savedId)}/reload`,{method:'POST'});
  await loadAll(); editCamera(_savedId);
};
byId('closeCameraEdit').onclick=()=>_closeEditPanel();
byId('addGroupBtn').onclick=(e)=>{
  e.stopPropagation();
  document.querySelectorAll('.group-inline').forEach(el=>el.remove());
  byId('groupList').insertAdjacentHTML('beforeend',groupEditHTML({id:'',name:'',category:'Sonstiges',alarm_profile:'soft',coarse_objects:[],fine_models:[],schedule:{enabled:false,start:'22:00',end:'06:00'}}));
  const form=byId('groupList').lastElementChild?.querySelector('form');
  if(form) _wireGroupPills(form);
  byId('groupList').lastElementChild.scrollIntoView({behavior:'smooth',block:'nearest'});
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
window.saveCoralSettings=async function(){
  const payload={processing:{coral_enabled:byId('coral_enabled')?.checked||false,bird_species_enabled:byId('bird_species_enabled')?.checked||false}};
  await fetch('/api/settings/app',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  showToast('Coral-Einstellungen gespeichert · Kameras werden neu gestartet.','success');
  await loadAll();
};
byId('reloadConnectionsBtn')?.addEventListener('click',async()=>{
  await fetch('/api/reload',{method:'POST'});
  showToast('Kameraverbindungen werden neu aufgebaut.','success');
});

byId('exportJsonBtn').onclick=()=>download('/api/settings/export?format=json');
byId('exportYamlBtn').onclick=()=>download('/api/settings/export?format=yaml');
byId('clearImportBtn').onclick=()=>{byId('importBox').value='';};
byId('importJsonBtn').onclick=async()=>{await importConfig('json');};
byId('importYamlBtn').onclick=async()=>{await importConfig('yaml');};
async function importConfig(format){ const content=byId('importBox').value.trim(); if(!content){showToast('Bitte Inhalt einfügen.','warn');return;} const r=await j('/api/settings/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({format,content})}); byId('importBox').value=''; await loadAll(); showToast('Import erfolgreich.','success'); }

// ── Settings collapsible sections ────────────────────────────────────────────
window.toggleSetSection=function(id){
  const el=byId(id); if(!el){console.warn('[toggleSetSection] not found:',id);return;}
  const opening=!el.classList.contains('open');
  el.classList.toggle('open',opening);
  const chevron=el.querySelector('.set-chevron');
  if(chevron) chevron.textContent=opening?'▾':'▶';
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
    const cams=r.cameras||[];
    state.mediaStats=cams;
    bar.innerHTML='';
    renderMediaOverview();
  }catch{bar.innerHTML=''; state.mediaStats=[];}
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
  if(!await showConfirm('Verwaiste Events löschen? Alle Event-Einträge ohne zugehörige Snapshot-Datei werden entfernt.')) return;
  try{
    const r=await j('/api/media/purge-orphans',{method:'POST'});
    showToast(`${r.removed||0} verwaiste Events entfernt.`,'success');
    await loadAll();
  }catch(e){showToast('Fehler: '+e.message,'error');}
};

byId('mediaSettingsForm').onsubmit=async(e)=>{
  e.preventDefault();
  const f=e.target.elements;
  const payload={storage:{retention_days:Number(f['retention_days'].value||14),media_limit_default:Number(f['media_limit_default'].value||24),auto_cleanup_enabled:!!(f['auto_cleanup_enabled']?.checked)}};
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

  // Initial state: desktop=restore from localStorage, tablet=collapsed, mobile=hidden
  if(window.innerWidth>768){
    const saved=localStorage.getItem(STORAGE_KEY);
    // On tablet (<1024px) default to collapsed unless user explicitly pinned open
    setCollapsed(window.innerWidth<=1024 ? saved!=='0' : saved==='1');
  }

  if(hamburger) hamburger.onclick=()=>{
    sidebar.classList.add('mobile-open');
    overlay.classList.add('visible');
    document.body.style.overflow='hidden';
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
    console.log('shell padding-top:',shellPaddingTop);
    target.scrollIntoView({behavior:'smooth',block:'start'});
  }));
})();

// ── Logs ─────────────────────────────────────────────────────────────────────
async function loadLogs(){
  const level=byId('logLevelFilter')?.value||'INFO';
  try{
    const r=await j(`/api/logs?level=${level}`);
    renderLogs(r.logs||[]);
  }catch(e){
    byId('logOutput').innerHTML=`<div class="log-row ERROR"><span class="log-ts">--:--:--</span><span class="log-level">ERROR</span><span>${esc(String(e))}</span></div>`;
  }
}
function renderLogs(logs){
  const out=byId('logOutput');
  if(!logs.length){out.innerHTML='<div class="log-row INFO"><span class="log-ts">—</span><span class="log-level">—</span><span>Keine Log-Einträge auf diesem Level.</span></div>'; return;}
  out.innerHTML=logs.map(l=>`<div class="log-row ${esc(l.level)}"><span class="log-ts">${esc(l.ts||'')}</span><span class="log-level">${esc(l.level||'')}</span><span>${esc(l.msg||'')}</span></div>`).join('');
  out.scrollTop=out.scrollHeight;
}
byId('logRefreshBtn').onclick=loadLogs;
byId('logClearBtn').onclick=()=>{byId('logOutput').innerHTML='';};
byId('logLevelFilter').onchange=loadLogs;

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
  btn.disabled=true; btn.textContent='Scanne …';
  try{
    const r=await j('/api/media/rescan',{method:'POST'});
    showToast(`Scan abgeschlossen: ${r.registered||0} neue Medien registriert.`,'success');
    await loadAll();
  }catch(e){showToast('Fehler beim Scan: '+e.message,'error');}
  finally{btn.disabled=false;btn.textContent='🔍 Neu scannen';}
});

// ── Lightbox / Media viewer ───────────────────────────────────────────────────
let _lbItem=null;
function openLightbox(item){
  _lbItem=item;
  const imgSrc=item.snapshot_relpath?`/media/${item.snapshot_relpath}`:(item.snapshot_url||'');
  byId('lightboxImg').src=imgSrc;
  byId('lightboxMeta').innerHTML=`
    <span class="badge">${esc(item.camera_id||'')}</span>
    <span class="badge">${esc(item.time||'')}</span>
    ${(item.labels||[]).map(l=>`<span class="chip">${esc(l)}</span>`).join('')}`;
  byId('lightboxModal').classList.remove('hidden');
  document.body.style.overflow='hidden';
}
function closeLightbox(){
  byId('lightboxModal').classList.add('hidden');
  document.body.style.overflow='';
  _lbItem=null;
}
byId('lightboxClose').onclick=closeLightbox;
byId('lightboxModal').onclick=(e)=>{if(e.target===byId('lightboxModal')) closeLightbox();};
document.addEventListener('keydown',(e)=>{if(e.key==='Escape') closeLightbox();});
byId('lightboxConfirm').onclick=()=>{closeLightbox();};
byId('lightboxDelete').onclick=async()=>{
  if(!_lbItem) return;
  const{camera_id,event_id}=_lbItem;
  if(!camera_id||!event_id) return;
  try{
    await j(`/api/camera/${encodeURIComponent(camera_id)}/events/${encodeURIComponent(event_id)}`,{method:'DELETE'});
    const card=byId('mediaGrid').querySelector(`[data-event-id="${CSS.escape(event_id)}"]`);
    if(card) card.remove();
    state.media=(state.media||[]).filter(x=>x.event_id!==event_id);
    if(!byId('mediaGrid').querySelector('.media-card')){
      byId('mediaGrid').innerHTML='<div class="item muted" style="padding:16px">Keine Medien vorhanden.</div>';
    }
    _decrementMediaOverviewCount(camera_id);
    closeLightbox();
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
function mediaCardHTML(item){
  const imgSrc=item.snapshot_relpath?`/media/${item.snapshot_relpath}`:(item.snapshot_url||'');
  const color=camColor(item.camera_id);
  const confirmed=item.confirmed?'mmc-confirmed':'';
  const topLabel=(item.labels||[])[0]||'motion';
  return `<article class="media-card ${confirmed}" data-event-id="${esc(item.event_id||'')}" data-camera-id="${esc(item.camera_id||'')}">
    <div class="mmc-img-wrap" onclick="window._openMediaItem('${esc(item.event_id||'')}')">
      <img src="${esc(imgSrc)}" alt="event" loading="lazy" />
      <div class="mmc-meta-bar">
        <span>${fmtMediaTime(item.time||'')}</span>
        <span>${esc(topLabel)}</span>
      </div>
      <div class="mmc-actions">
        <button class="mmc-btn mmc-confirm" title="Bestätigen" onclick="event.stopPropagation();window.confirmMediaCard('${esc(item.camera_id||'')}','${esc(item.event_id||'')}',this)">✓</button>
        <button class="mmc-btn mmc-delete" title="Löschen" onclick="event.stopPropagation();window.deleteMediaCard(this)">✕</button>
      </div>
    </div>
  </article>`;
}
function renderMediaOverview(){
  const ov=byId('mediaOverview'); if(!ov) return;
  const cams=state.cameras;
  if(!cams.length){ov.innerHTML=''; return;}
  const statsByid={};
  (state.mediaStats||[]).forEach(s=>{ statsByid[s.camera_id||s.id||s.name]=s; });
  ov.innerHTML=cams.map(c=>{
    const s=statsByid[c.id]||{};
    const icon=getCameraIcon(c.name||c.id);
    // Use stored snapshot as thumbnail; fall back to live camera feed
    const storedSnap=s.latest_snap_url||'';
    const liveSnap=`/api/camera/${esc(c.id)}/snapshot.jpg?t=${Date.now()}`;
    const thumbSrc=storedSnap||liveSnap;
    const fallbackSrc=storedSnap?liveSnap:'';
    const onerr=fallbackSrc
      ?`this.onerror=function(){this.parentElement.innerHTML='<span class=moc-thumb-placeholder>${icon}</span>'};this.src='${esc(fallbackSrc)}'`
      :`this.parentElement.innerHTML='<span class=moc-thumb-placeholder>${icon}</span>'`;
    return `<div class="moc-card" onclick="openMediaDrilldown('${esc(c.id)}')">
      <div class="moc-thumb"><img src="${esc(thumbSrc)}" alt="${esc(c.name)}" onerror="${esc(onerr)}" /></div>
      <div style="min-width:0">
        <div class="moc-name"><span style="font-size:20px;vertical-align:middle;margin-right:5px">${icon}</span>${esc(c.name)}</div>
        <div class="moc-counts">${s.event_count||0} Events · ${s.jpg_count||0} Fotos</div>
      </div>
    </div>`;
  }).join('');
}
function renderMediaGrid(){
  const grid=byId('mediaGrid'); if(!grid) return;
  const items=state.media||[];
  grid.innerHTML=items.map(mediaCardHTML).join('')||'<div class="item muted" style="padding:16px">Keine Medien vorhanden.</div>';
  const lmBtn=byId('mediaLoadMoreBtn');
  if(lmBtn) lmBtn.style.display=state.mediaHasMore?'':'none';
  window._openMediaItem=id=>{const item=(state.media||[]).find(x=>x.event_id===id); if(item) openLightbox(item);};
}
async function openMediaDrilldown(camId){
  state.mediaCamera=camId;
  state.mediaLabel=''; state.mediaPeriod='week';
  syncMediaPills();
  byId('mediaOverview').style.display='none';
  byId('mediaDrilldown').style.display='';
  // highlight active card
  document.querySelectorAll('.moc-card').forEach(c=>c.classList.toggle('moc-active',c.onclick?.toString().includes(`'${camId}'`)));
  await loadMedia();
  renderMediaGrid();
}
function closeMediaDrilldown(){
  state.mediaCamera=null; state.media=[];
  byId('mediaDrilldown').style.display='none';
  byId('mediaOverview').style.display='';
}
function syncMediaPills(){
  document.querySelectorAll('.media-pill[data-type="label"]').forEach(p=>{
    p.classList.toggle('active',p.dataset.val===state.mediaLabel);
  });
  document.querySelectorAll('.media-pill[data-type="period"]').forEach(p=>{
    p.classList.toggle('active',p.dataset.val===state.mediaPeriod);
  });
}
(function initMediaPills(){
  document.querySelectorAll('.media-pill').forEach(p=>{
    p.addEventListener('click',()=>{
      if(p.dataset.type==='label') state.mediaLabel=p.dataset.val;
      else state.mediaPeriod=p.dataset.val;
      syncMediaPills();
      if(state.mediaCamera) loadMedia().then(()=>renderMediaGrid());
    });
  });
  syncMediaPills();
})();
window.deleteMediaCard=async(btn)=>{
  const card=btn.closest('.media-card');
  const eventId=card?.dataset.eventId;
  const camId=card?.dataset.cameraId;
  if(!eventId||!camId) return;
  try{
    await j(`/api/camera/${encodeURIComponent(camId)}/events/${encodeURIComponent(eventId)}`,{method:'DELETE'});
    if(card) card.remove();
    state.media=(state.media||[]).filter(x=>x.event_id!==eventId);
    _decrementMediaOverviewCount(camId);
    if(!byId('mediaGrid').querySelector('.media-card')){
      byId('mediaGrid').innerHTML='<div class="item muted" style="padding:16px">Keine Medien vorhanden.</div>';
    }
  }catch(e){showToast('Löschen fehlgeschlagen: '+e.message,'error');}
};
window.confirmMediaCard=async(camId,eventId,btn)=>{
  try{
    await j(`/api/camera/${encodeURIComponent(camId)}/events/${encodeURIComponent(eventId)}/confirm`,{method:'POST'});
    const card=byId('mediaGrid').querySelector(`[data-event-id="${CSS.escape(eventId)}"]`);
    if(card) card.classList.add('mmc-confirmed');
    if(btn){btn.classList.remove('mmc-confirm');btn.style.opacity='0.4';}
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
'eichhoernchen':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><path d="M 52 70 Q 72 58 70 34 Q 68 18 54 20 Q 40 22 44 40 Q 48 56 52 70Z" fill="#d4752a"/><path d="M 52 70 Q 66 56 64 36 Q 62 24 54 26 Q 46 28 48 42 Q 50 58 52 70Z" fill="#c8651a"/><ellipse cx="36" cy="60" rx="15" ry="11" fill="#c8651a"/><circle cx="38" cy="42" r="14" fill="#c8651a"/><circle cx="28" cy="29" r="7" fill="#c8651a"/><circle cx="28" cy="29" r="4" fill="#e07820"/><circle cx="44" cy="27" r="7" fill="#c8651a"/><circle cx="44" cy="27" r="4" fill="#e07820"/><circle cx="44" cy="39" r="3.5" fill="#111"/><circle cx="43" cy="38" r="1.2" fill="#fff"/><ellipse cx="48" cy="45" rx="5" ry="3.5" fill="#d4752a"/><circle cx="50" cy="44" r="1.5" fill="#333"/><ellipse cx="28" cy="68" rx="4" ry="7" fill="#a05018"/><ellipse cx="38" cy="69" rx="4" ry="6" fill="#a05018"/></svg>`,
'igel':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><ellipse cx="40" cy="55" rx="26" ry="16" fill="#8b6340"/><ellipse cx="40" cy="47" rx="22" ry="12" fill="#4a3020"/><line x1="40" y1="35" x2="37" y2="19" stroke="#4a3020" stroke-width="2.5" stroke-linecap="round"/><line x1="52" y1="38" x2="56" y2="23" stroke="#4a3020" stroke-width="2.5" stroke-linecap="round"/><line x1="28" y1="38" x2="24" y2="23" stroke="#4a3020" stroke-width="2.5" stroke-linecap="round"/><line x1="62" y1="46" x2="70" y2="36" stroke="#4a3020" stroke-width="2.5" stroke-linecap="round"/><line x1="18" y1="46" x2="10" y2="36" stroke="#4a3020" stroke-width="2.5" stroke-linecap="round"/><ellipse cx="62" cy="57" rx="13" ry="9" fill="#a07850"/><circle cx="66" cy="53" r="2.5" fill="#111"/><circle cx="65.5" cy="52.5" r="1" fill="#fff"/><circle cx="72" cy="57" r="2" fill="#333"/><ellipse cx="28" cy="69" rx="5" ry="3.5" fill="#7a5530"/><ellipse cx="50" cy="70" rx="5" ry="3.5" fill="#7a5530"/></svg>`,
'feldhase':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><ellipse cx="34" cy="17" rx="6" ry="21" fill="#9e8060"/><ellipse cx="34" cy="17" rx="3.5" ry="18" fill="#e8e0d0"/><ellipse cx="47" cy="14" rx="6" ry="23" fill="#9e8060"/><ellipse cx="47" cy="14" rx="3.5" ry="20" fill="#e8e0d0"/><ellipse cx="38" cy="59" rx="20" ry="14" fill="#9e8060"/><ellipse cx="38" cy="64" rx="13" ry="9" fill="#e8e0d0"/><circle cx="50" cy="44" r="14" fill="#9e8060"/><circle cx="56" cy="39" r="3.5" fill="#111"/><circle cx="55" cy="38" r="1.2" fill="#fff"/><ellipse cx="58" cy="47" rx="6" ry="4" fill="#b09070"/><circle cx="61" cy="46" r="1.8" fill="#333"/><ellipse cx="20" cy="65" rx="8" ry="5" fill="#9e8060"/><ellipse cx="56" cy="70" rx="10" ry="4" fill="#9e8060"/></svg>`,
'reh':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><path d="M 36 20 Q 30 12 26 14 Q 22 16 24 20" stroke="#8b6040" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M 36 20 Q 34 10 39 9" stroke="#8b6040" stroke-width="2.5" fill="none" stroke-linecap="round"/><path d="M 44 20 Q 50 12 54 14 Q 58 16 56 20" stroke="#8b6040" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M 44 20 Q 46 10 41 9" stroke="#8b6040" stroke-width="2.5" fill="none" stroke-linecap="round"/><rect x="36" y="24" width="12" height="22" rx="6" fill="#c8a870"/><circle cx="42" cy="23" r="12" fill="#c8a870"/><ellipse cx="48" cy="26" rx="7" ry="5" fill="#e8d8b0"/><ellipse cx="30" cy="19" rx="4" ry="8" fill="#c8a870" transform="rotate(-15 30 19)"/><circle cx="37" cy="20" r="3" fill="#111"/><circle cx="36" cy="19" r="1" fill="#fff"/><ellipse cx="40" cy="61" rx="24" ry="15" fill="#c8a870"/><ellipse cx="18" cy="58" rx="6" ry="7" fill="#f0e8d0"/><rect x="28" y="72" width="5" height="8" rx="2.5" fill="#a08050"/><rect x="36" y="72" width="5" height="8" rx="2.5" fill="#a08050"/><rect x="46" y="72" width="5" height="8" rx="2.5" fill="#a08050"/></svg>`,
'fuchs':`<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><polygon points="22,36 28,16 34,36" fill="#d4521a"/><polygon points="24,34 28,20 32,34" fill="#f0c0a0"/><polygon points="46,36 52,16 58,36" fill="#d4521a"/><polygon points="48,34 52,20 56,34" fill="#f0c0a0"/><ellipse cx="40" cy="46" rx="18" ry="16" fill="#d4521a"/><path d="M 32 50 Q 40 47 48 50 Q 52 55 50 60 Q 44 65 36 63 Q 30 59 32 53Z" fill="#e8e0d0"/><circle cx="32" cy="40" r="3.5" fill="#111"/><circle cx="31" cy="39" r="1.2" fill="#fff"/><circle cx="48" cy="40" r="3.5" fill="#111"/><circle cx="47" cy="39" r="1.2" fill="#fff"/><ellipse cx="40" cy="55" rx="4" ry="3" fill="#333"/><ellipse cx="40" cy="70" rx="20" ry="11" fill="#d4521a"/><ellipse cx="40" cy="69" rx="12" ry="7" fill="#e8e0d0"/><rect x="26" y="73" width="6" height="7" rx="3" fill="#2a1a0a"/><rect x="48" y="73" width="6" height="7" rx="3" fill="#2a1a0a"/></svg>`
};

// ── Achievement drill-down (placeholder) ─────────────────────────────────────
function openAchievementDrilldown(id, name){
  // navigate to media filtered by species
  state.mediaLabel='';
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
  {id:'eichhoernchen',name:'Eichhörnchen',  icon:'🐿️', cat:'mammals'},
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
    <span><span class="ach-leg-dot" style="background:#c87840"></span>Bronze 1–4×</span>
    <span><span class="ach-leg-dot" style="background:#a0b4c4"></span>Silber 5–19×</span>
    <span><span class="ach-leg-dot" style="background:#e0c050"></span>Gold 20×+</span>
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

  byId('achievementsGrid').innerHTML=legend+`<div class="ach-cards-grid">${cards}</div>`;
}

// Wire confirm modal
byId('confirmOk')?.addEventListener('click',()=>_resolveConfirm(true));
byId('confirmCancel')?.addEventListener('click',()=>_resolveConfirm(false));
byId('confirmModal')?.addEventListener('click',e=>{if(e.target===byId('confirmModal'))_resolveConfirm(false);});

loadAll().then(()=>{startLiveUpdate(); loadAchievements();});
loadLogs();
