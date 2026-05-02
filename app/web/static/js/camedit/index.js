// ─── camedit/index.js ──────────────────────────────────────────────────────
// Stage 25 D of the legacy.js → ES modules refactor — camera-settings
// root: hero/sidebar shell renderer, camera list, edit-panel hydrator
// (the big editCamera function), profiles + audit + arm toggles, the
// Settings tab hydrator, system info panel, cam-edit tab bar, MQTT
// section save, config import/export. Pure code move from legacy.js,
// no behaviour changes.
//
// Most cam-edit functionality already lives in dedicated modules
// (camedit/rtsp.js, whitelist.js, detection.js, recovery.js,
// camera_id.js, panel.js, coral-test.js, timelapse-settings.js,
// wizard.js, discovery.js); this file is the orchestration layer that
// wires them together when a camera is opened for editing.
//
// Public surface bridged on window for inline onclicks + loadAll() in
// live-update.js: editCamera, toggleArm, toggleCameraEnabled,
// _reconnectCam, _quickDeleteCamera, _flashDetection, saveMqttSettings,
// renderShell, renderCameraSettings, renderProfiles, renderAudit,
// hydrateSettings.
import { state, shapeState } from '../core/state.js';
import { byId, esc } from '../core/dom.js';
import { j } from '../core/api.js';
import { showToast, showConfirm } from '../core/toast.js';
import { getCameraIcon } from '../core/icons.js';
import { loadAll } from '../live-update.js';
import { reloadCamera } from '../dashboard.js';
import {
  panelState, _restoreEditWrapper, _closeEditPanel,
} from './panel.js';
import {
  RTSP_PATH_OPTS, _applyUrlMask, _defaultRtspPathForManufacturer,
  _updateRtspErweitertVisuals, initRtspBuilder, parseRtspUrl,
} from './rtsp.js';
import {
  setWhitelistState, _updateWhitelistHidden,
} from './whitelist.js';
import {
  _refreshCamIdPreview, _bindCamIdPreviewListeners,
} from './camera_id.js';
import {
  _loadCamDiagnostics, _refreshConnectionWarn,
} from './recovery.js';
import {
  _initCameraFormListeners, _initErkSliders,
  _renderErkPerClassConfidence, _bindErkPerClassToggle,
  _renderErkPerClassConfirm, _bindErkConfirmPerClassToggle,
  _bindErkSimulate,
  _renderCamObjectPills, getCamObjectFilterState, setCamObjectFilterState,
  _renderGlobalStatusRows, _renderCamConfirmGrid,
} from './detection.js';
import {
  drawShapes, loadMaskSnapshot,
  _renderShapeList, _updateShapeDrawingBar, _updateShapeModeButtons,
} from '../shape-editor.js';
import { _bindCamProbeDeviceInfo } from './discovery.js';
import {
  _renderSeverityMatrix, _checkAlertingConflicts,
  _renderAlertCooldownGrid, _bindAlertCooldownToggle,
  _bindAlertTestButton, _bindAlertingConflictWatch,
  _renderAlertStatusStrip,
} from '../alerting.js';

// Coral pipeline tree + device info + test cam list are bridged on
// window inside camedit/coral-test.js — reach them that way until that
// module exposes named exports.
const _updateCoralDeviceInfo   = (...a) => window._updateCoralDeviceInfo?.(...a);
const _renderCoralPipelineTree = (...a) => window._renderCoralPipelineTree?.(...a);
const _populateCoralTestCameras = (...a) => window._populateCoralTestCameras?.(...a);

// Tiny helper used by the export-config buttons in the App-Section.
const download = (url) => window.open(url, '_blank');

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

// _camGridCols / SURVEIL_ACC / SURVEIL_LABEL / _isInScheduleWindow /
// _surveilMode / _surveilEyeSvg now live in dashboard.js (Stage 3a).

// renderDashboard now lives in dashboard.js (Stage 3b).

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

// _defaultRtspPathForManufacturer, _updateRtspErweitertVisuals,
// initRtspBuilder, parseRtspUrl all moved together. Inline-onclick
// handlers (_toggleUrlMask, _toggleCamRtspErw) keep their window
// bridges from inside the new module.

window.toggleCameraEnabled=async function(camId,enabled){
  const cam=(state.cameras||[]).find(x=>x.id===camId);
  if(!cam) return;
  await fetch('/api/settings/cameras',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...cam,enabled})});
  await loadAll();
};
function renderCameraSettings(){
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
// Now lives in camera-merge.js (Stage 6). bindMergeModal() is called
// once at the bottom of this file to wire its DOM listeners.
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
    if(panelState.camId===camId) _restoreEditWrapper();
    await loadAll();
  }catch(e){showToast('Fehler beim Löschen: '+esc(e.message||e),'error');}
};

function editCamera(camId){
  // Defensive: if the cam-edit form isn't in the DOM yet (rare but
  // happens on the first click during a page-load race, OR when the
  // wrapper has been detached by a previous renderCameraSettings()
  // and not re-created), wait one frame and retry once. After that,
  // tell the user to reload — there's no recoverable state at this
  // point. Without the guard, the next line crashes on .elements of
  // null and the toast fires every click forever.
  const formEl = byId('cameraForm');
  if (!formEl) {
    requestAnimationFrame(() => {
      if (byId('cameraForm')) editCamera(camId);
      else showToast('Bearbeitungs-Form nicht bereit — Seite neu laden (F5)', 'error');
    });
    return;
  }
  const c=(state.config?.cameras||[]).find(x=>x.id===camId)||(state.cameras||[]).find(x=>x.id===camId);
  if(!c){
    // Camera not in current state → drop any half-set lock so the user
    // can retry once loadAll() refreshes state. Without this the lock
    // would stick if a stale camId (post-rename) raced through here.
    panelState.camId=null;
    return;  // diagnostic console.error retired — the lock reset above is the real recovery
  }
  // Toggle: clicking same camera closes the panel
  if(panelState.camId===camId){
    _closeEditPanel(); return;
  }
  // From here on, ANY exception in the hydration helpers below would
  // historically leave panelState.camId stale and the wrapper detached
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
  setCamObjectFilterState(c.object_filter||['person','cat','bird']);
  f['object_filter'].value=getCamObjectFilterState().join(',');
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
  setWhitelistState(c.whitelist_names||[]); _updateWhitelistHidden();
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
  requestAnimationFrame(()=>wrapper?.classList.add('slide-open'));
  panelState.camId=camId;
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
    // mistakenly firing on the stale panelState.camId. Surface the
    // failure to the user via toast so they know to retry; rethrow so
    // the original stack remains visible in DevTools for diagnosis.
    panelState.camId=null;
    _restoreEditWrapper();
    showToast('Kamera-Bearbeitung konnte nicht öffnen — bitte erneut versuchen','warn');
    throw e;
  }
}

async function renderProfiles(){
  const cats=await j('/api/cats'); const persons=await j('/api/persons');
  const catEl=byId('catList'); const perEl=byId('personList');
  if(catEl) catEl.innerHTML=cats.profiles.map(p=>`<div style="padding:3px 0;font-size:13px">${esc(p.name)}</div>`).join('')||'<span class="muted small">—</span>';
  if(perEl) perEl.innerHTML=persons.profiles.map(p=>`<div style="padding:3px 0;font-size:13px">${esc(p.name)}${p.whitelisted?' <span class="muted small">(Whitelist)</span>':''}</div>`).join('')||'<span class="muted small">—</span>';
}
async function renderAudit(){ const actions=await j('/api/telegram/actions'); byId('auditPanel').innerHTML=actions.items.map(a=>`<div class="audit-item"><strong>${esc(a.action)}</strong><div class="small">${esc(a.time)}${a.camera_id?` · ${esc(a.camera_id)}`:''}</div></div>`).join('')||'<div class="audit-item">Noch keine Telegram-Aktionen.</div>'; }

async function toggleArm(camId,armed){ await fetch(`/api/camera/${camId}/arm`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({armed})}); await loadAll(); }
window.toggleArm=toggleArm;
// _cvCardClick now lives in dashboard.js (Stage 3b). Its window

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


byId('reloadConfigBtn').onclick=()=>loadAll();

byId('closeCameraEdit')?.addEventListener('click',()=>_closeEditPanel());
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
// Camera-card placeholder rendering moved with the dashboard module


byId('exportJsonBtn').onclick=()=>download('/api/settings/export?format=json');
byId('exportYamlBtn').onclick=()=>download('/api/settings/export?format=yaml');
byId('clearImportBtn').onclick=()=>{byId('importBox').value='';};
byId('importJsonBtn').onclick=async()=>{await importConfig('json');};
byId('importYamlBtn').onclick=async()=>{await importConfig('yaml');};
async function importConfig(format){ const content=byId('importBox').value.trim(); if(!content){showToast('Bitte Inhalt einfügen.','warn');return;} const r=await j('/api/settings/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({format,content})}); byId('importBox').value=''; await loadAll(); showToast('Import erfolgreich.','success'); }

// ── window.* bridges (Stage 25 D) ───────────────────────────────────────────
// loadAll() in live-update.js looks these up on window, and several
// inline onclicks in the camera-list HTML (rendered by renderCameraSettings)
// also reach for them by global name. The window assignments live here
// next to the function bodies they bridge — when those callsites finally
// migrate to direct named imports, this block evaporates.
window.renderShell           = renderShell;
window.renderCameraSettings  = renderCameraSettings;
window.renderProfiles        = renderProfiles;
window.renderAudit           = renderAudit;
window.hydrateSettings       = hydrateSettings;
