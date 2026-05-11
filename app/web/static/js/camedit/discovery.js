// ─── camedit/discovery.js ──────────────────────────────────────────────────
// Stage 25 of the legacy.js → ES modules refactor — Camera-Discovery
// modal (subnet scan, results grid, "add cam" inline form, apply-RTSP
// to current edit panel). Pure code move from legacy.js, no behaviour
// changes.
//
// editCamera still lives in legacy.js until the camera-settings root
// extraction; we reach it via window.editCamera. Once that extraction
// ships the lookup becomes a direct named import.
import { byId, esc } from "../core/dom.js";
import { state } from "../core/state.js";
import { j } from "../core/api.js";
import { showToast, showConfirm } from "../core/toast.js";
import { getCameraIcon } from "../core/icons.js";
import { loadAll } from "../live-update.js";
import { RTSP_PATH_OPTS, _rtspEnc, _unmaskUrlsForSubmit } from "./rtsp.js";
import { getWhitelistState } from "./whitelist.js";
import { _restoreEditWrapper } from "./panel.js";
import { openWizard } from "./wizard.js";
import { _collectClassSeverity, _collectAlertCooldown } from "../alerting.js";
import { _collectLabelThresholds, _collectConfirmationWindow } from "./detection.js";

// alias so discovery modal code still works
const RTSP_PATHS=RTSP_PATH_OPTS;

function closeDiscoveryModal(){
  byId('discoveryModal').classList.add('hidden');
  document.body.style.overflow='';
  // Tear down any running SSE stream so we don't leak connections
  // when the user closes mid-scan.
  if(typeof _closeDiscoveryStream==='function') _closeDiscoveryStream();
  // Cancel any in-flight credential probes and forget per-IP state so
  // a second open of the modal starts fresh — passwords from the prior
  // session never live across opens.
  if(typeof _credAbort!=='undefined'){
    for(const ac of _credAbort.values()){ try{ac.abort();}catch{} }
    _credAbort.clear(); _credTimers.forEach(clearTimeout); _credTimers.clear();
    _credState.clear();
  }
}
let _discoveryItems=[];
function _hostnameToId(h){return h.toLowerCase().replaceAll(/[^a-z0-9-]+/g,'-').replaceAll(/^-+|-+$/g,'').slice(0,40);}
function _defaultRtspPath(x){
  const g=(x.guess||'').toLowerCase();
  if(g.includes('reolink')) return '/h264Preview_01_main';
  if(g.includes('hikvision')) return '/Streaming/Channels/101';
  if(g.includes('dahua')||g.includes('amcrest')) return '/cam/realmonitor?channel=1&subtype=0';
  return RTSP_PATH_OPTS[0].value;
}
function _renderDiscoveryResults(){
  const hideConfigured=!!byId('discoveryHideConfigured')?.checked;
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
    const uid=x.ip.replaceAll('.','_');
    const already=allConfigured.has(x.ip);
    const vendor=x.guess==='Unbekannte Kamera'?`Unbekannte Kamera (${x.ip})`:esc(x.guess||'Unbekannte Kamera');
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
      ${already?'':(`<div id="disc_form_wrap_${uid}" data-disc-ip="${esc(x.ip)}">
        ${reolinkNote}
        <div class="discovery-creds">
          <input id="disc_user_${uid}" class="disc-input" placeholder="Benutzer" value="admin" autocomplete="off" />
          <input id="disc_pass_${uid}" class="disc-input" type="password" placeholder="Passwort" autocomplete="off" />
          <select id="disc_path_${uid}" class="disc-select">${pathOptsForCam}</select>
        </div>
        <div id="disc_cred_status_${uid}" class="disc-cred-status" data-state="idle" hidden>
          <span class="dcs-icon" aria-hidden="true"></span>
          <span class="dcs-text"></span>
          <button type="button" class="dcs-retry" data-disc-retry="${esc(x.ip)}">erneut prüfen</button>
        </div>
        <div id="disc_add_form_${uid}" class="disc-add-form hidden">
          <div class="discovery-creds" style="margin-top:8px">
            <input id="disc_name_${uid}" class="disc-input" placeholder="${x.hostname?'Kameraname':esc(vendor)}" value="${displayName}" style="flex:1.5"/>
          </div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button id="disc_save_btn_${uid}" class="btn-action accent" style="flex:1;min-height:40px" onclick="saveDiscoveryCamera('${esc(x.ip)}')"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3,8 7,12 13,4"/></svg> <span class="dcs-save-label">Kamera speichern</span></button>
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
  // After innerHTML re-renders, wire cred-probing per candidate. Each
  // re-render wipes listeners — _wireCredProbes re-attaches and paints
  // any state already known from _credState (so a filter toggle keeps
  // the green check that was already there).
  _wireCredProbes(visible);
}

// ── Inline credential validation ────────────────────────────────────────
// Per-IP state survives re-renders so a filter toggle ("Bereits
// konfigurierte ausblenden") doesn't wipe a freshly-painted "ok" pill.
// Shape: { state, vendor, detail, ts }
const _credState=new Map();
const _credAbort=new Map();    // ip → AbortController of an in-flight probe
const _credTimers=new Map();   // ip → debounce timer id
const _DEBOUNCE_MS=600;

function _credPaint(ip){
  const uid=ip.replaceAll('.','_');
  const row=byId(`disc_cred_status_${uid}`);
  if(!row) return;
  const st=_credState.get(ip);
  // No probe yet → keep idle (hidden).
  if(!st){
    row.hidden=true;
    row.dataset.state='idle';
    _credSetSaveButton(ip,'enabled');
    return;
  }
  row.hidden=false;
  row.dataset.state=st.state;
  const iconEl=row.querySelector('.dcs-icon');
  const textEl=row.querySelector('.dcs-text');
  const ICON={
    probing:`<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M7 1.5a5.5 5.5 0 0 1 5.5 5.5"><animateTransform attributeName="transform" type="rotate" from="0 7 7" to="360 7 7" dur="0.9s" repeatCount="indefinite"/></path></svg>`,
    ok:`<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,8.5 7,12.5 13,4.5"/></svg>`,
    bad:`<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`,
    warn:`<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5L14.5 13.5h-13z"/><line x1="8" y1="6.5" x2="8" y2="9.5"/><circle cx="8" cy="11.5" r="0.6" fill="currentColor"/></svg>`,
    unknown:`<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M6 6.5c0-1.2 1-2 2-2s2 .8 2 2c0 1.5-2 1.5-2 3"/><circle cx="8" cy="11.5" r="0.6" fill="currentColor"/></svg>`,
  };
  const variant=({
    probing:'probing', ok:'ok', bad:'bad',
    unreachable:'warn', timeout:'warn', unknown:'warn',
  })[st.state]||'warn';
  row.classList.remove('ok','bad','warn','probing');
  row.classList.add(variant);
  iconEl.innerHTML=ICON[variant]||'';
  const vendorLabel=({reolink:'Reolink',rtsp:'RTSP'})[st.vendor]||'Kamera';
  let txt=st.detail||'';
  if(st.state==='probing') txt='Prüfe Zugangsdaten …';
  else if(st.state==='ok') txt=`Passwort korrekt · ${vendorLabel}`;
  else if(st.state==='bad') txt='Passwort falsch — bitte korrigieren';
  else if(st.state==='unreachable') txt=`Kamera nicht erreichbar (${ip}:${st.port||554})`;
  else if(st.state==='timeout') txt=`Kamera antwortet nicht (${ip}:${st.port||554})`;
  else if(st.state==='unknown') txt='Konnte nicht eindeutig prüfen — speichern auf eigene Verantwortung';
  textEl.textContent=txt;
  // Red ring on the password field for bad_auth only.
  const passEl=byId(`disc_pass_${uid}`);
  if(passEl){
    if(st.state==='bad') passEl.classList.add('is-bad');
    else passEl.classList.remove('is-bad');
  }
  _credSetSaveButton(ip, st.state==='probing'?'probing':(st.state==='bad'?'disabled':'enabled'));
}

function _credSetSaveButton(ip, mode){
  const uid=ip.replaceAll('.','_');
  const btn=byId(`disc_save_btn_${uid}`);
  if(!btn) return;
  const lbl=btn.querySelector('.dcs-save-label');
  if(mode==='disabled'){
    btn.disabled=true;
    btn.setAttribute('aria-disabled','true');
    if(lbl) lbl.textContent='Kamera speichern';
  }else if(mode==='probing'){
    btn.disabled=true;
    btn.setAttribute('aria-disabled','true');
    if(lbl) lbl.textContent='Prüfe …';
  }else{
    btn.disabled=false;
    btn.removeAttribute('aria-disabled');
    if(lbl) lbl.textContent='Kamera speichern';
  }
}

async function _credProbeNow(ip){
  const uid=ip.replaceAll('.','_');
  const passEl=byId(`disc_pass_${uid}`);
  const userEl=byId(`disc_user_${uid}`);
  const pathEl=byId(`disc_path_${uid}`);
  if(!passEl) return;
  const pw=passEl.value||'';
  if(!pw){
    // Empty password → idle. Cancel any running probe so a fast typist
    // who clears the field gets immediate feedback.
    _credState.delete(ip);
    const ac=_credAbort.get(ip); if(ac){ ac.abort(); _credAbort.delete(ip); }
    _credPaint(ip);
    return;
  }
  // Cancel any in-flight probe for this IP first.
  const prev=_credAbort.get(ip); if(prev){ try{prev.abort();}catch{} }
  const ac=new AbortController();
  _credAbort.set(ip, ac);
  _credState.set(ip,{state:'probing',vendor:'unknown',detail:'',port:554});
  _credPaint(ip);
  let r;
  try{
    r=await fetch('/api/discover/test-credentials',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      signal:ac.signal,
      body:JSON.stringify({
        ip,
        user:(userEl?.value||'admin'),
        password:pw,
        path:(pathEl?.value||'/'),
        port:554,
      }),
    });
  }catch(err){
    if(err?.name==='AbortError') return;  // superseded by a newer probe
    _credState.set(ip,{state:'unknown',vendor:'unknown',detail:'',port:554});
    _credPaint(ip);
    return;
  }finally{
    if(_credAbort.get(ip)===ac) _credAbort.delete(ip);
  }
  let d;
  try{ d=await r.json(); }catch{ d={ok:false,reason:'error',detail:''}; }
  // Translate the backend's ``reason`` into our internal state vocabulary.
  const stateMap={
    auth_ok:'ok', auth_failed:'bad', unreachable:'unreachable',
    timeout:'timeout', auth_unknown:'unknown', error:'unknown',
  };
  const state=stateMap[d.reason]||'unknown';
  _credState.set(ip,{state,vendor:d.vendor||'unknown',detail:d.detail||'',port:554});
  _credPaint(ip);
}

function _credSchedule(ip){
  // Debounce — restart the timer on every keystroke / select change.
  const prev=_credTimers.get(ip); if(prev) clearTimeout(prev);
  const tid=setTimeout(()=>{
    _credTimers.delete(ip);
    _credProbeNow(ip);
  }, _DEBOUNCE_MS);
  _credTimers.set(ip,tid);
}

function _wireCredProbes(items){
  for(const x of items){
    if(!x||!x.ip) continue;
    const ip=x.ip;
    const uid=ip.replaceAll('.','_');
    // Skip already-configured candidates (no form rendered for them).
    if(!byId(`disc_form_wrap_${uid}`)) continue;
    // Repaint any state we already had from a previous render.
    _credPaint(ip);
    const userEl=byId(`disc_user_${uid}`);
    const passEl=byId(`disc_pass_${uid}`);
    const pathEl=byId(`disc_path_${uid}`);
    const onChange=()=>{
      // The instant feedback rule: peeling the red ring off the password
      // field on the very next keystroke makes the bad_auth state feel
      // self-correcting rather than nagging.
      if(passEl) passEl.classList.remove('is-bad');
      _credSchedule(ip);
    };
    if(userEl) userEl.addEventListener('input',onChange);
    if(passEl) passEl.addEventListener('input',onChange);
    if(pathEl) pathEl.addEventListener('change',onChange);
    const retry=byId(`disc_cred_status_${uid}`)?.querySelector('.dcs-retry');
    if(retry) retry.addEventListener('click',(e)=>{e.preventDefault(); _credProbeNow(ip);});
  }
}

// Live-log helpers — pushed-by-EventSource updates render here. Each
// log line is one node so we can keep the autoscroll cheap (no full
// re-render) and so phase1_hit lines can de-dupe on re-emission.
let _discoveryES=null;
let _discoverySubnet='';
const _phase1Lines=new Map(); // ip → DOM node
function _logPush(html, opts){
  const panel=byId('discoveryLogPanel'); if(!panel) return;
  const div=document.createElement('div');
  div.innerHTML=html;
  if(opts?.id) div.dataset.id=opts.id;
  if(opts?.muted) div.style.color='#64748b';
  panel.appendChild(div);
  // Autoscroll only if user hasn't manually scrolled up.
  const nearBottom=(panel.scrollHeight-panel.scrollTop-panel.clientHeight)<24;
  if(nearBottom) panel.scrollTop=panel.scrollHeight;
  return div;
}
function _setProgress(scanned, total, currentIp){
  const wrap=byId('discoveryProgressWrap'); if(!wrap) return;
  wrap.style.display='block';
  const pct=total?Math.min(100,Math.round((scanned/total)*100)):0;
  const fill=byId('discoveryProgressFill'); if(fill) fill.style.width=pct+'%';
  const lbl=byId('discoveryProgressLabel');
  if(lbl){
    lbl.textContent=`Phase 1 · ${scanned} / ${total} Hosts${currentIp?' · '+currentIp:''}`;
  }
}
function _resetDiscoveryUI(){
  byId('discoveryLogPanel').innerHTML='';
  byId('discoveryProgressFill').style.width='0%';
  byId('discoveryProgressLabel').textContent='';
  byId('discoveryProgressWrap').style.display='none';
  byId('discoveryResults').innerHTML='';
  _phase1Lines.clear();
  _discoveryItems=[];
}
function _closeDiscoveryStream(){
  if(_discoveryES){ try{_discoveryES.close();}catch{} _discoveryES=null; }
}
byId('discoverBtn')?.addEventListener('click',()=>{
  byId('discoveryModal').classList.remove('hidden');
  document.body.style.overflow='hidden';
  byId('discoveryStatus').textContent='Suche läuft …';
  _resetDiscoveryUI();
  // Honor the toggle's current state (default ON via `checked` attr).
  const showLog=!!byId('discoveryShowLog')?.checked;
  byId('discoveryLogPanel').style.display=showLog?'block':'none';
  _closeDiscoveryStream();
  // Use EventSource for live progress. Browsers without EventSource
  // (very rare in 2026) fall back to the sync /api/discover via the
  // catch handler below.
  if(typeof EventSource!=='function'){
    return _legacyDiscoverFallback();
  }
  const es=new EventSource('/api/discover/stream');
  _discoveryES=es;
  es.addEventListener('phase',(ev)=>{
    const d=JSON.parse(ev.data||'{}');
    _discoverySubnet=d.subnet||_discoverySubnet;
    if(d.phase==='1'){
      _logPush(`<strong>Phase 1</strong> · Subnetz ${esc(d.subnet)} · ${d.total_hosts} Hosts werden gescannt`);
    }else if(d.phase==='2'){
      _logPush(`<strong>Phase 2</strong> · ${d.total_hosts} Kandidat${d.total_hosts===1?'':'en'} werden geprüft`);
    }
  });
  es.addEventListener('progress',(ev)=>{
    const d=JSON.parse(ev.data||'{}');
    _setProgress(d.scanned||0, d.total||0, d.current_ip||'');
  });
  es.addEventListener('phase1_hit',(ev)=>{
    const d=JSON.parse(ev.data||'{}');
    const id='hit_'+d.ip;
    const ports=(d.ports||[]).join(',');
    const html=`<span style="color:#22c55e">✓</span> ${esc(d.ip)} — ports ${esc(ports)}`;
    const existing=_phase1Lines.get(d.ip);
    if(existing){
      existing.innerHTML=html;
    }else{
      const n=_logPush(html,{id});
      _phase1Lines.set(d.ip, n);
    }
  });
  es.addEventListener('phase2_check',(ev)=>{
    const d=JSON.parse(ev.data||'{}');
    const action=d.action==='banner_fetch'?'banner':'vendor';
    _logPush(`  ↳ ${esc(d.ip)} · ${esc(action)}`,{muted:true});
  });
  es.addEventListener('candidate',(ev)=>{
    const d=JSON.parse(ev.data||'{}');
    // Push into the visible items array as it arrives — don't wait
    // for `done`. Replace any earlier placeholder entry for the same IP.
    const idx=_discoveryItems.findIndex(x=>x.ip===d.ip);
    if(idx>=0) _discoveryItems[idx]=d; else _discoveryItems.push(d);
    _renderDiscoveryResults();
    _logPush(`  ⇒ Kandidat: ${esc(d.ip)} · ${esc(d.guess||'?')}`);
  });
  es.addEventListener('done',(ev)=>{
    const d=JSON.parse(ev.data||'{}');
    _discoveryItems=d.results||_discoveryItems;
    const total=d.total_scanned||'?';
    const found=d.found||_discoveryItems.length;
    byId('discoveryStatus').innerHTML=`Subnetz <strong>${esc(d.subnet||_discoverySubnet)}</strong> · ${total} Hosts · <strong>Gefundene Geräte (${found})</strong>`;
    _logPush(`<strong>Fertig</strong> · ${found} Kamera${found===1?'':'s'} gefunden in ${total} Hosts`);
    _renderDiscoveryResults();
    _closeDiscoveryStream();
  });
  es.addEventListener('error',(ev)=>{
    // EventSource error fires both on transport error AND on a server-side
    // `error` event payload — try to read .data for the latter.
    let msg='';
    try{ if(ev?.data){ msg=(JSON.parse(ev.data)||{}).message||''; } }catch{}
    if(msg){
      _logPush(`<span style="color:#f87171">✗</span> ${esc(msg)}`);
    }
    // If the connection died with no data and we have nothing yet, fall
    // back to the sync endpoint so the user still gets results.
    if(!_discoveryItems.length && es.readyState===2){
      _logPush('Stream beendet — Fallback auf klassische Suche …',{muted:true});
      _closeDiscoveryStream();
      _legacyDiscoverFallback();
    }
  });
});

async function _legacyDiscoverFallback(){
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
}

byId('discoveryShowLog')?.addEventListener('change',(e)=>{
  byId('discoveryLogPanel').style.display=e.target.checked?'block':'none';
});
byId('discoveryHideConfigured')?.addEventListener('change',_renderDiscoveryResults);
byId('closeDiscoveryBtn').onclick=()=>closeDiscoveryModal();
byId('discoveryModal').onclick=(e)=>{if(e.target===byId('discoveryModal')) closeDiscoveryModal();};
byId('openWizardBtn').onclick=()=>openWizard();
window.openDiscoveryAddForm=(ip)=>{
  const uid=ip.replaceAll('.','_');
  byId(`disc_add_form_${uid}`)?.classList.remove('hidden');
};
window.saveDiscoveryCamera=async(ip)=>{
  const uid=ip.replaceAll('.','_');
  // Belt & braces: the save button is already disabled in `bad` /
  // `probing` states via _credSetSaveButton, but a stale event from a
  // double-click could still slip through. Block here too.
  const st=_credState.get(ip);
  if(st && (st.state==='bad' || st.state==='probing')) return;
  const user=byId(`disc_user_${uid}`)?.value||'admin';
  const pass=byId(`disc_pass_${uid}`)?.value||'';
  const path=byId(`disc_path_${uid}`)?.value||'/Streaming/Channels/101';
  const name=byId(`disc_name_${uid}`)?.value||ip;
  const rtsp=`rtsp://${user}:${_rtspEnc(pass)}@${ip}:554${path}`;
  const snap=`http://${user}:${_rtspEnc(pass)}@${ip}/cgi-bin/snapshot.cgi`;
  const _item=_discoveryItems.find(x=>x.ip===ip);
  const camId=_item?.hostname?_hostnameToId(_item.hostname):'cam-'+ip.replaceAll('.','-');
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
  const uid=ip.replaceAll('.','_');
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
    whitelist_names:getWhitelistState().filter(Boolean),
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
    // Per-camera tracker overrides — 0 means "use the module default"
    // from tracker_core.py. Spawn/floor land as scores (0..1); grace is
    // wall-clock seconds. See cam-edit Erkennung tab step 6.
    track_spawn_min_score: parseFloat(f['track_spawn_min_score']?.value || 0),
    track_continue_min_score: parseFloat(f['track_continue_min_score']?.value || 0),
    track_miss_grace_seconds: parseFloat(f['track_miss_grace_seconds']?.value || 0),
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
  // editCamera still lives in legacy.js for now — reach it via window
  // until the camera-settings root extraction ships.
  if (typeof window.editCamera === 'function') window.editCamera(_newId);
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
export function _bindCamProbeDeviceInfo(){
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
      if(!await showConfirm(msg)) return;
    }
    if(f['manufacturer']){ f['manufacturer'].value=d.manufacturer; f['manufacturer'].dispatchEvent(new Event('input',{bubbles:true})); }
    if(f['model']){ f['model'].value=d.model; f['model'].dispatchEvent(new Event('input',{bubbles:true})); }
    showToast(`Erkannt: ${d.manufacturer} ${d.model}`,'success');
  });
}
