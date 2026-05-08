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
  const uid=ip.replaceAll('.','_');
  byId(`disc_add_form_${uid}`)?.classList.remove('hidden');
};
window.saveDiscoveryCamera=async(ip)=>{
  const uid=ip.replaceAll('.','_');
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
