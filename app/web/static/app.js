
const state={config:null,cameras:[],groups:[],timeline:null,media:[],camera:'',label:'',period:'week',bootstrap:null};
const colors={bird:'#70d6ff',cat:'#ff8cc6',person:'#ffd166',car:'#9c89ff',motion:'#7ee787',alarm:'#ff6b6b',unknown:'#91a4b8'};
const shapeState={mode:'zone',points:[],camera:null,zones:[],masks:[]};
const byId=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]));
const j=async(url,opt)=>{const r=await fetch(url,opt); if(!r.ok) throw new Error(await r.text()); return r.json();};
const download=(url)=>window.open(url,'_blank');

async function loadAll(){
  state.bootstrap=await j('/api/bootstrap');
  state.config=await j('/api/config');
  state.groups=(await j('/api/groups')).groups||[];
  state.cameras=(await j('/api/cameras')).cameras||[];
  if(!state.camera && state.cameras[0]) state.camera='';
  state.timeline=await j(`/api/timeline?period=${state.period}${state.camera?`&camera=${encodeURIComponent(state.camera)}`:''}${state.label?`&label=${encodeURIComponent(state.label)}`:''}`);
  await loadMedia();
  renderShell();
  renderDashboard();
  renderTimeline();
  renderGroups();
  renderCameraSettings();
  await renderProfiles();
  await renderAudit();
  hydrateSettings();
  if(state.bootstrap.needs_wizard) openWizard();
  byId('openWizardBtn').classList.toggle('hidden', !!state.bootstrap?.wizard_completed || !state.bootstrap?.needs_wizard);
}

async function loadMedia(){
  const cams = state.camera ? [state.camera] : state.cameras.map(c=>c.id);
  const all=[];
  for(const camId of cams){
    const data=await j(`/api/camera/${camId}/media?limit=8${state.label?`&label=${encodeURIComponent(state.label)}`:''}`);
    for(const item of data.items||[]) all.push({...item,camera_id:camId});
  }
  all.sort((a,b)=>(b.time||'').localeCompare(a.time||''));
  state.media=all.slice(0,24);
}

function renderShell(){
  byId('appName').textContent=state.config.app.name||'TAM-spy';
  byId('sideAppName').textContent=state.config.app.name||'TAM-spy';
  byId('appTagline').textContent=state.config.app.tagline||'Schlicht, funktional, analytisch';
  byId('cameraFilter').innerHTML='<option value="">Alle Kameras</option>'+state.cameras.map(c=>`<option value="${esc(c.id)}" ${state.camera===c.id?'selected':''}>${esc(c.name)}</option>`).join('');
  byId('groupSelect').innerHTML=state.groups.map(g=>`<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
  byId('globalSummary').textContent=`${state.cameras.length} Kameras · Coral ${state.config.coral.mode} · Telegram ${state.config.telegram.enabled?'an':'aus'} · MQTT ${state.config.mqtt.enabled?'an':'aus'}`;
}

function cardStats(cam){
  const labels=cam.top_labels||{};
  const entries=Object.entries(labels).slice(0,4);
  const legend=entries.map(([k,v])=>`<div class="legend-item"><span class="dot" style="background:${colors[k]||colors.unknown}"></span>${esc(k)} · ${v}</div>`).join('')||'<div class="small">Noch keine Statistik.</div>';
  return `<div class="legend">${legend}</div>`;
}

function renderDashboard(){
  const cams=(state.camera?state.cameras.filter(c=>c.id===state.camera):state.cameras);
  byId('cameraCards').innerHTML=cams.map(c=>`<article class="camera-card">
      <div class="stream">
        <img src="${esc(c.snapshot_url)}&t=${Date.now()}" alt="${esc(c.name)}" />
        <div class="badges">
          <span class="badge ${c.status==='ok'?'good':'warn'}">${esc(c.status||'—')}</span>
          <span class="badge">${esc(c.group_id||'ohne Gruppe')}</span>
          <span class="badge ${c.armed?'danger':'good'}">${c.armed?'scharf':'unscharf'}</span>
          <span class="badge">Heute ${c.today_events||0}</span>
        </div>
      </div>
      <div>
        <div class="section-head compact-head"><div><h3>${esc(c.name)}</h3><div class="small">${esc(c.location||'')}</div></div><div class="small">${esc(c.id)}</div></div>
        <div class="stats-grid">
          <div class="metric"><div class="small">Status</div><div class="v">${esc(c.status||'—')}</div></div>
          <div class="metric"><div class="small">Heute</div><div class="v">${c.today_events||0}</div></div>
          <div class="metric"><div class="small">Gruppe</div><div class="v sm">${esc(c.group_id||'—')}</div></div>
          <div class="metric"><div class="small">Alarm</div><div class="v sm">${c.armed?'aktiv':'aus'}</div></div>
        </div>
        ${cardStats(c)}
        <div class="chip-row">
          <button class="action-btn" onclick="toggleArm('${esc(c.id)}',${!c.armed})">${c.armed?'Unscharf':'Scharf'}</button>
          <button class="action-btn" onclick="loadTimelapse('${esc(c.id)}')">Timelapse</button>
          <button class="action-btn" onclick="editCamera('${esc(c.id)}')">Bearbeiten</button>
        </div>
      </div>
    </article>`).join('');
  byId('mediaGrid').innerHTML=state.media.map(item=>`<article class="media-card">
      <img src="${esc(item.snapshot_url||'')}" alt="event" />
      <div class="media-meta">
        <strong>${esc(item.camera_id)}</strong>
        <div class="small">${esc(item.time||'')}</div>
        <div class="chip-row">${(item.labels||[]).map(l=>`<span class="chip">${esc(l)}</span>`).join('')}</div>
      </div>
    </article>`).join('')||'<div class="item">Noch keine Medien.</div>';
}

function renderTimeline(){
  const svg=byId('timelineSvg');
  const w=1200,h=340,left=140,top=40,right=24,bottom=34;
  const tracks=state.timeline?.tracks||[];
  if(!tracks.length){ svg.innerHTML=''; return; }
  const points=(state.timeline.merged||[]);
  const times=points.map(p=>new Date(p.time).getTime()).filter(Boolean);
  const min=Math.min(...times,Date.now()-3600_000), max=Math.max(...times,Date.now());
  const x=t=> left + ((new Date(t).getTime()-min)/Math.max(1,max-min))*(w-left-right);
  const rowH=(h-top-bottom)/Math.max(1,tracks.length);
  const y=i=> top + rowH*i + rowH/2;
  let out=`<rect x="0" y="0" width="${w}" height="${h}" fill="#0b131b" rx="18"/>`;
  tracks.forEach((tr,i)=>{ out+=`<line x1="${left}" y1="${y(i)}" x2="${w-right}" y2="${y(i)}" stroke="#213241" stroke-width="1"/>`;
    out+=`<text x="18" y="${y(i)+5}" fill="#91a4b8" font-size="14">${esc(tr.camera_id)}</text>`;
  });
  for(let k=0;k<6;k++){ const tx=left+((w-left-right)/5)*k; out+=`<line x1="${tx}" y1="${top-10}" x2="${tx}" y2="${h-bottom}" stroke="#172532" stroke-width="1"/>`; }
  points.forEach(p=>{ const cx=x(p.time), cy=y(tracks.findIndex(t=>t.camera_id===p.camera_id)); const fill=colors[p.top_label]||colors.unknown; const r=p.alarm_level==='alarm'?9:6; out+=`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="#fff" stroke-opacity=".35"/>`; });
  svg.innerHTML=out;
}

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
    const auth=user?(encodeURIComponent(user)+(pass?':'+encodeURIComponent(pass):'')+'@'):'';
    const portPart=port&&port!=='554'?':'+port:'';
    f['rtsp_url'].value=`rtsp://${auth}${ip}${portPart}${path}`;
    // auto-fill snapshot if empty
    if(!f['snapshot_url']?.value && user)
      f['snapshot_url'].value=`http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${ip}/cgi-bin/snapshot.cgi`;
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
  byId('cameraSettingsList').innerHTML=state.cameras.map(c=>`<div class="item"><div class="item-head"><strong>${esc(c.name)}</strong><button class="action-btn" onclick="editCamera('${esc(c.id)}')">Bearbeiten</button></div><div class="small">${esc(c.location||'')} · ${esc(c.group_id||'—')} · ${c.armed?'scharf':'unscharf'}</div></div>`).join('');
}

function editCamera(camId){
  const c=state.config.cameras.find(x=>x.id===camId)||state.cameras.find(x=>x.id===camId); if(!c) return;
  initRtspBuilder();
  const f=byId('cameraForm').elements;
  f['id'].value=c.id||''; f['name'].value=c.name||''; f['location'].value=c.location||'';
  // parse RTSP URL into builder fields
  const p=parseRtspUrl(c.rtsp_url||'');
  f['rtsp_ip'].value=p.host||''; f['rtsp_user'].value=p.user||''; f['rtsp_pass'].value=p.pass||''; f['rtsp_port'].value=p.port||'554';
  // pick closest path option or keep first
  const matchedPath=RTSP_PATH_OPTS.find(o=>o.value===p.path);
  if(f['rtsp_path']) f['rtsp_path'].value=matchedPath?matchedPath.value:RTSP_PATH_OPTS[0].value;
  f['rtsp_url'].value=c.rtsp_url||'';
  f['snapshot_url'].value=c.snapshot_url||''; f['group_id'].value=c.group_id||'';
  f['object_filter'].value=(c.object_filter||[]).join(','); f['enabled'].checked=!!c.enabled; f['armed'].checked=!!c.armed; f['timelapse_enabled'].checked=!!(c.timelapse&&c.timelapse.enabled);
  f['schedule_start'].value=(c.schedule&&c.schedule.start)||''; f['schedule_end'].value=(c.schedule&&c.schedule.end)||''; f['schedule_enabled'].checked=!!(c.schedule&&c.schedule.enabled);
  f['telegram_enabled'].checked=(c.telegram_enabled!==false); f['mqtt_enabled'].checked=(c.mqtt_enabled!==false); f['whitelist_names'].value=(c.whitelist_names||[]).join(',');
  shapeState.camera=camId; shapeState.zones=JSON.parse(JSON.stringify(c.zones||[])); shapeState.masks=JSON.parse(JSON.stringify(c.masks||[])); shapeState.points=[];
  f['zones_json'].value=JSON.stringify(shapeState.zones); f['masks_json'].value=JSON.stringify(shapeState.masks);
  // update delete button state
  byId('deleteCameraBtn').dataset.camId=camId;
  loadMaskSnapshot(camId);
  drawShapes();
  location.hash='#cameras';
}
window.editCamera=editCamera;

byId('deleteCameraBtn').onclick=async()=>{
  const camId=byId('deleteCameraBtn').dataset.camId;
  if(!camId) return;
  if(!confirm(`Kamera "${camId}" wirklich löschen?\n\nDieser Vorgang entfernt die Kamera aus der Konfiguration.\nEreignisse und Medien bleiben im Speicher erhalten.`)) return;
  const r=await j(`/api/settings/cameras/${encodeURIComponent(camId)}`,{method:'DELETE'});
  if(r.event_count>0) alert(`Hinweis: Für diese Kamera existieren noch ${r.event_count} gespeicherte Ereignisse im Storage. Sie wurden NICHT gelöscht.`);
  await loadAll();
};

function renderGroups(){ byId('groupList').innerHTML=state.groups.map(g=>`<div class="item"><div class="item-head"><strong>${esc(g.name)}</strong><button class="action-btn" onclick='fillGroupForm(${JSON.stringify(g).replace(/'/g,"&apos;")})'>Bearbeiten</button></div><div class="small">${esc(g.category)} · ${esc(g.alarm_profile)} · ${(g.fine_models||[]).join(', ')||'ohne Feinstufe'}</div></div>`).join(''); }
function fillGroupForm(g){const f=byId('groupForm').elements; f['id'].value=g.id||''; f['name'].value=g.name||''; f['category'].value=g.category||''; f['alarm_profile'].value=g.alarm_profile||'soft'; f['coarse_objects'].value=(g.coarse_objects||[]).join(','); f['fine_models'].value=(g.fine_models||[]).join(','); f['schedule_start'].value=(g.schedule&&g.schedule.start)||''; f['schedule_end'].value=(g.schedule&&g.schedule.end)||''; f['schedule_enabled'].checked=!!(g.schedule&&g.schedule.enabled); }
window.fillGroupForm=fillGroupForm;

async function renderProfiles(){
  const cats=await j('/api/cats'); const persons=await j('/api/persons');
  byId('profileLists').innerHTML=`<div class="item"><strong>Katzen</strong><div class="small">${cats.profiles.map(p=>`${p.name}`).join(' · ')||'—'}</div></div><div class="item"><strong>Personen</strong><div class="small">${persons.profiles.map(p=>`${p.name}${p.whitelisted?' (Whitelist)':''}`).join(' · ')||'—'}</div></div>`;
}
async function renderAudit(){ const actions=await j('/api/telegram/actions'); byId('auditPanel').innerHTML=actions.items.map(a=>`<div class="audit-item"><strong>${esc(a.action)}</strong><div class="small">${esc(a.time)}${a.camera_id?` · ${esc(a.camera_id)}`:''}</div></div>`).join('')||'<div class="audit-item">Noch keine Telegram-Aktionen.</div>'; }

async function toggleArm(camId,armed){ await fetch(`/api/camera/${camId}/arm`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({armed})}); await loadAll(); }
window.toggleArm=toggleArm;
async function loadTimelapse(camId){ try{ const r=await j(`/api/camera/${camId}/timelapse`); if(r.url) window.open(r.url,'_blank'); }catch(e){ alert('Kein Zeitraffer verfügbar.'); } }
window.loadTimelapse=loadTimelapse;

function hydrateSettings(){
  const app=state.config.app||{}, server=state.config.server||{}, telegram=state.config.telegram||{}, mqtt=state.config.mqtt||{};
  const f=byId('settingsForm').elements;
  f['app_name'].value=app.name||''; f['app_tagline'].value=app.tagline||''; f['app_logo'].value=app.logo||''; f['public_base_url'].value=server.public_base_url||''; f['discovery_subnet'].value=state.config.default_discovery_subnet||'';
  f['telegram_enabled'].checked=!!telegram.enabled; f['telegram_token'].value=telegram.token||''; f['telegram_chat_id'].value=telegram.chat_id||'';
  f['mqtt_enabled'].checked=!!mqtt.enabled; f['mqtt_host'].value=mqtt.host||''; f['mqtt_port'].value=mqtt.port||1883; f['mqtt_username'].value=mqtt.username||''; f['mqtt_password'].value=mqtt.password||''; f['mqtt_base_topic'].value=mqtt.base_topic||'tam-spy';
  const proc=state.config.processing||{}; const coral=state.config.coral||{};
  f['coral_enabled'].checked=!!(proc.coral_enabled ?? coral.mode==='coral');
  f['bird_species_enabled'].checked=!!(proc.bird_species_enabled ?? coral.bird_species_enabled);
  const hint=byId('coralStatusHint');
  if(hint){
    const cam=state.cameras[0];
    const available=cam?.coral_available; const reason=cam?.coral_reason||'—';
    hint.innerHTML=available
      ? '✅ Coral TPU erkannt und aktiv.'
      : `⚠️ Coral nicht verfügbar: <code>${esc(reason)}</code>`;
  }
}

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

byId('reloadBtn').onclick=()=>loadAll();
byId('reloadConfigBtn').onclick=()=>loadAll();
// alias so discovery modal code still works
const RTSP_PATHS=RTSP_PATH_OPTS;

function closeDiscoveryModal(){
  byId('discoveryModal').classList.add('hidden');
  document.body.style.overflow='';
}
byId('discoverBtn').onclick=async()=>{
  byId('discoveryModal').classList.remove('hidden');
  document.body.style.overflow='hidden';
  byId('discoveryStatus').textContent='Suche läuft …';
  byId('discoveryResults').innerHTML='';
  try{
    const r=await j('/api/discover');
    const items=r.results||[];
    const total=r.total_scanned||'?';
    byId('discoveryStatus').innerHTML=`Subnetz <strong>${esc(r.subnet)}</strong> · ${total} Hosts gescannt · <strong>${items.length} Kamera-Kandidaten</strong> <span class="small muted">(nur Kamera-Kandidaten)</span>`;
    const pathOpts=RTSP_PATHS.map(p=>`<option value="${esc(p.value)}">${esc(p.label)}</option>`).join('');
    byId('discoveryResults').innerHTML=items.map(x=>{
      const ports=(x.open_ports||[]).join(', ')||'—';
      const uid=x.ip.replace(/\./g,'_');
      return `<div class="item">
        <div class="item-head"><strong>${esc(x.ip)}</strong><span class="small">Ports: ${esc(ports)}</span></div>
        <div class="small muted">${esc(x.guess||'Host')}</div>
        <div class="discovery-creds">
          <input id="disc_user_${uid}" class="disc-input" placeholder="Benutzer" value="admin" />
          <input id="disc_pass_${uid}" class="disc-input" type="password" placeholder="Passwort" />
          <select id="disc_path_${uid}" class="disc-select">${pathOpts}</select>
        </div>
        <div class="chip-row" style="margin-top:8px">
          <button class="action-btn" onclick="applyDiscoveryRtsp('${esc(x.ip)}')">Als RTSP übernehmen</button>
        </div>
      </div>`;
    }).join('') || '<div class="item">Keine Kamera-Kandidaten gefunden.</div>';
  }catch(err){
    byId('discoveryStatus').textContent='Discovery fehlgeschlagen';
    byId('discoveryResults').innerHTML=`<div class="item">${esc(err.message||err)}</div>`;
  }
};
byId('closeDiscoveryBtn').onclick=()=>closeDiscoveryModal();
byId('discoveryModal').onclick=(e)=>{if(e.target===byId('discoveryModal')) closeDiscoveryModal();};
byId('openWizardBtn').onclick=()=>openWizard();
window.applyDiscoveryRtsp=(ip)=>{
  const uid=ip.replace(/\./g,'_');
  const user=byId(`disc_user_${uid}`)?.value||'admin';
  const pass=byId(`disc_pass_${uid}`)?.value||'';
  const path=byId(`disc_path_${uid}`)?.value||'/Streaming/Channels/101';
  const rtsp=`rtsp://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${ip}:554${path}`;
  const snap=`http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${ip}/cgi-bin/snapshot.cgi`;
  const wizRtsp=byId('wiz_cam_rtsp'); if(wizRtsp) wizRtsp.value=rtsp;
  const wizSnap=byId('wiz_cam_snapshot'); if(wizSnap) wizSnap.value=snap;
  const form=byId('cameraForm');
  if(form?.elements['rtsp_url']) form.elements['rtsp_url'].value=rtsp;
  if(form?.elements['snapshot_url']) form.elements['snapshot_url'].value=snap;
  closeDiscoveryModal();
};
byId('cameraFilter').onchange=e=>{state.camera=e.target.value; loadAll();};
byId('labelFilter').onchange=e=>{state.label=e.target.value; loadAll();};
byId('periodFilter').onchange=e=>{state.period=e.target.value; loadAll();};

byId('cameraForm').onsubmit=async(e)=>{
  e.preventDefault(); const f=e.target.elements;
  const payload={id:f['id'].value,name:f['name'].value,location:f['location'].value,
    rtsp_url:f['rtsp_url'].value,snapshot_url:f['snapshot_url'].value,
    username:f['rtsp_user']?.value||'',password:f['rtsp_pass']?.value||'',
    group_id:f['group_id'].value,role:f['group_id'].selectedOptions[0]?.textContent||f['group_id'].value,
    object_filter:f['object_filter'].value.split(',').map(x=>x.trim()).filter(Boolean),
    enabled:f['enabled'].checked,armed:f['armed'].checked,
    telegram_enabled:f['telegram_enabled'].checked,mqtt_enabled:f['mqtt_enabled'].checked,
    whitelist_names:f['whitelist_names'].value.split(',').map(x=>x.trim()).filter(Boolean),
    timelapse:{enabled:f['timelapse_enabled'].checked,fps:12},
    schedule:{enabled:f['schedule_enabled'].checked,start:f['schedule_start'].value||'22:00',end:f['schedule_end'].value||'06:00'},
    zones:JSON.parse(f['zones_json'].value||'[]'),masks:JSON.parse(f['masks_json'].value||'[]')};
  await fetch('/api/settings/cameras',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); await loadAll(); editCamera(payload.id);
};
byId('groupForm').onsubmit=async(e)=>{e.preventDefault(); const f=e.target.elements; const payload={id:f['id'].value,name:f['name'].value,category:f['category'].value,alarm_profile:f['alarm_profile'].value,coarse_objects:f['coarse_objects'].value.split(',').map(x=>x.trim()).filter(Boolean),fine_models:f['fine_models'].value.split(',').map(x=>x.trim()).filter(Boolean),schedule:{enabled:f['schedule_enabled'].checked,start:f['schedule_start'].value||'22:00',end:f['schedule_end'].value||'06:00'}}; await fetch('/api/groups',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); await loadAll();};
byId('settingsForm').onsubmit=async(e)=>{e.preventDefault(); const f=e.target.elements; const payload={app:{name:f['app_name'].value||'TAM-spy',tagline:f['app_tagline'].value||'',logo:f['app_logo'].value||'🐈‍⬛'},server:{public_base_url:f['public_base_url'].value||'',default_discovery_subnet:f['discovery_subnet'].value||'192.168.1.0/24'},telegram:{enabled:f['telegram_enabled'].checked,token:f['telegram_token'].value||'',chat_id:f['telegram_chat_id'].value||''},mqtt:{enabled:f['mqtt_enabled'].checked,host:f['mqtt_host'].value||'',port:Number(f['mqtt_port'].value||1883),username:f['mqtt_username'].value||'',password:f['mqtt_password'].value||'',base_topic:f['mqtt_base_topic'].value||'tam-spy'},processing:{coral_enabled:f['coral_enabled'].checked,bird_species_enabled:f['bird_species_enabled'].checked}}; await fetch('/api/settings/app',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); await loadAll();};

byId('exportJsonBtn').onclick=()=>download('/api/settings/export?format=json');
byId('exportYamlBtn').onclick=()=>download('/api/settings/export?format=yaml');
byId('clearImportBtn').onclick=()=>{byId('importBox').value='';};
byId('importJsonBtn').onclick=async()=>{await importConfig('json');};
byId('importYamlBtn').onclick=async()=>{await importConfig('yaml');};
async function importConfig(format){ const content=byId('importBox').value.trim(); if(!content) return alert('Bitte Inhalt einfügen.'); const r=await j('/api/settings/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({format,content})}); byId('importBox').value=''; await loadAll(); alert('Import erfolgreich.'); }

byId('maskCanvas').addEventListener('click',(evt)=>{ if(!shapeState.camera) return; shapeState.points.push(canvasPoint(evt)); drawShapes(); });
byId('refreshMaskSnapshotBtn').onclick=()=>loadMaskSnapshot(shapeState.camera||byId('cameraForm').elements['id'].value);
byId('editZoneBtn').onclick=()=>{shapeState.mode='zone'; byId('shapeStatus').textContent='Zone zeichnen';};
byId('editMaskBtn').onclick=()=>{shapeState.mode='mask'; byId('shapeStatus').textContent='Maske zeichnen';};
byId('undoShapeBtn').onclick=()=>{shapeState.points.pop(); drawShapes();};
byId('saveShapeBtn').onclick=()=>{ if(shapeState.points.length<3) return alert('Mindestens 3 Punkte.'); if(shapeState.mode==='zone') shapeState.zones.push([...shapeState.points]); else shapeState.masks.push([...shapeState.points]); shapeState.points=[]; saveShapesIntoForm(); drawShapes(); };
byId('clearShapesBtn').onclick=()=>{ if(!confirm('Alle Zonen und Masken löschen?')) return; shapeState.zones=[]; shapeState.masks=[]; shapeState.points=[]; saveShapesIntoForm(); drawShapes(); };
byId('maskSnapshot').addEventListener('load',drawShapes);

byId('wiz_cam_rtsp').value='rtsp://user:pass@192.168.X.X:554/Streaming/Channels/101';
byId('wiz_cam_snapshot').value='http://user:pass@192.168.X.X/cgi-bin/snapshot.cgi';
let wizStep=1;
document.querySelectorAll('.wiz-tab').forEach(btn=>btn.onclick=()=>{ wizStep=Number(btn.dataset.step); showWizardStep(wizStep); });
byId('wizPrev').onclick=()=>{ wizStep=Math.max(1,wizStep-1); showWizardStep(wizStep); };
byId('wizNext').onclick=()=>{ wizStep=Math.min(4,wizStep+1); showWizardStep(wizStep); };
byId('wizFinish').onclick=()=>finishWizard();

loadAll();
