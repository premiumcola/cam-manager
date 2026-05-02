// ─── Stage-2 core/* imports ─────────────────────────────────────────────────
// Helpers extracted from this file's top into per-domain modules under
// js/core/. Listed individually so a future tree-shake can drop unused
// names — and so each helper's home is easy to find by name.
import { state, shapeState, STAT_MEDIA_DRILLDOWN } from './core/state.js';
import { byId, esc } from './core/dom.js';
import { j } from './core/api.js';
import { showToast, showConfirm, _resolveConfirm, bindConfirmModal } from './core/toast.js';
import {
  colors, OBJ_LABEL, OBJ_SVG, objBubble, objIconSvg, TL_LABELS,
  getCameraIcon, getCameraColor,
} from './core/icons.js';
// Stages 3a + 3b — dashboard helpers + renderers extracted from this
// file. Only the cross-tab orchestration loop (startLiveUpdate, which
// calls into the Erkennung + Alerting status-strip updaters that still
// live in this file) stays behind. Each name retains its leading
// underscore so the migration stays string-comparable diff-wise.
import {
  _failedSnapshotIds, _resetFailedSnapshotIds, _isSnapshotIdDead,
  _camIdFromImg, _camImgRetry,
  _camGridCols,
  SURVEIL_ACC, SURVEIL_LABEL, _isInScheduleWindow, _surveilMode,
  _surveilEyeSvg,
  _makeOfflinePlaceholder, _makeConnectingPlaceholder,
  _restorePlaceholder,
  // Stage 3b additions:
  _hdCards,
  startPreviewRefresh,
  toggleCardHd, _refreshLivePillForCard,
  renderDashboard,
  showCameraReloadAnimation, reloadCamera,
  _cvCardClick,
} from './dashboard.js';
// Stage 4 — lightbox pure DOM helpers. The state singletons
// (lbState.item, lbState.index, lbState.deletePending) and the orchestration
// (openLightbox / closeLightbox / keydown) stay in this file for now
// because they reach into mediathek + timelapse + live-view modules
// that haven't extracted yet; once those follow, the orchestration
// migrates to lightbox.js too.
// Stage 23 — lightbox orchestration (constants + helpers + openers +
// keydown handler + button wiring + grid resize listener) all live in
// lightbox.js now. Named imports of openLightbox/closeLightbox/
// openTLPlayer give legacy.js something to bridge on window for
// router.js + inline onclicks; the lightbox module's DOM wiring runs
// at import time as a side effect.
import { openLightbox, closeLightbox, openTLPlayer } from './lightbox.js';
// Stage 6 — timeline render lives in its own module. CAT_COLORS is
// also re-imported because chips/badges in mediathek + sichtungen
// still resolve their bar colour from that table; those callsites
// migrate to direct timeline.js imports as those domains extract.
import { renderTimeline, CAT_COLORS } from './timeline.js';
// Stage 6 — the 3 s status poll + the cross-domain loadAll boot
// orchestration. loadAll uses window.X for renderers that still live
// in this file; once those domains extract, those window lookups
// switch to direct named imports.
import { startLiveUpdate, loadAll } from './live-update.js';
// Stage 6 — Zusammenführen modal. bindMergeModal() is called below
// from the post-imports init block to wire its DOM listeners once.
import { bindMergeModal } from './camera-merge.js';
// Stage 7 — camedit subdomain. panelState replaces the file-local
// _currentEditCamId; every read/write site here goes through
// panelState.camId. RTSP/whitelist/camera_id/recovery helpers are
// imported as named exports — the editCamera() function in this file
// is their main consumer (still resident, queued for stage 8).
import {
  panelState, _restoreEditWrapper, _closeEditPanel,
} from './camedit/panel.js';
import {
  RTSP_PATH_OPTS, _rtspEnc, _maskUrlPassword, _applyUrlMask,
  _revealUrl, _unmaskUrlsForSubmit, _defaultRtspPathForManufacturer,
  _updateRtspErweitertVisuals, initRtspBuilder, parseRtspUrl,
} from './camedit/rtsp.js';
import {
  getWhitelistState, setWhitelistState,
  _renderWhitelistChips, _updateWhitelistHidden,
} from './camedit/whitelist.js';
import {
  buildCameraId, _refreshCamIdPreview, _bindCamIdPreviewListeners,
} from './camedit/camera_id.js';
import {
  _loadCamDiagnostics, _refreshConnectionWarn,
} from './camedit/recovery.js';
// Stage 8 — camedit detection-tab UI. Form listeners + Erk sliders +
// per-class drilldowns + simulate panel + cam-object pills + Erkennung
// status strip + the legacy hidden #camConfirmGrid. _camObjectFilter
// State is hidden inside the module; getter/setter give legacy access.
import {
  _initCameraFormListeners, _initErkSliders,
  _renderErkPerClassConfidence, _bindErkPerClassToggle,
  _collectLabelThresholds,
  _renderErkPerClassConfirm, _bindErkConfirmPerClassToggle,
  _collectConfirmationWindow,
  _bindErkSimulate,
  _renderCamObjectPills, getCamObjectFilterState, setCamObjectFilterState,
  _renderGlobalStatusRows, _renderCamConfirmGrid,
  _fmtRelativeAgeS,
} from './camedit/detection.js';
// Stage 9 — polygon zone/mask editor. Importing the module also fires
// its IIFE that wires the canvas + toolbar buttons (idempotent against
// a missing canvas, so calling on every page is safe).
import {
  drawShapes, loadMaskSnapshot, saveShapesIntoForm, getCanvasCtx,
  _renderShapeList, _updateShapeDrawingBar, _updateShapeModeButtons,
} from './shape-editor.js';
// Stage 10 — chrome / UI subsystem. Each module either exports
// helpers we still call here or runs a self-init IIFE on import
// (sidebar collapse, mobile-dock scrollspy, logs panel boot).
import './chrome/settings-collapse.js';
import './chrome/sidebar.js';
import { _setEyeState } from './chrome/password-toggle.js';
import { loadMediaStorageStats, refreshTimelineAndStats } from './chrome/storage-stats.js';
import './chrome/mobile-dock.js';
import { loadLogs } from './chrome/logs.js';
// Stage 23 — Mediathek orchestration extracted into its own module.
// Imported here so legacy.js can keep maintaining the window.* bridges
// other modules and inline onclicks resolve through.
import {
  calcItemsPerPage, MEDIA_FILTER_LABELS, _aggregateMediaCounts,
  _seedTopMediaLabel, _pruneEmptyMediaFilters, renderMediaFilterPills,
  syncMediaPills, loadMedia, CAM_COLORS, camColor, hexToRgba,
  getMediaAccentColor, fmtMediaDate, fmtMediaTimeOnly, mediaCardHTML,
  _MOC_ALL_SVG, _MOC_OBJECT_TYPES, _mocChip, _buildMocChips,
  renderMediaOverview, _setActiveMocCard, openCategoryDrilldown,
  openAllMediaDrilldown, openMediaDrilldown, closeMediaDrilldown,
  _goToPage, renderMediaPagination, _ensureProcessingPoll, renderMediaGrid,
  _MEDIA_TITLE_SVG, updateMediaSectionTitle,
  deleteMediaCard, deleteTLCard, confirmMediaCard,
} from './mediathek/orchestration.js';
// Stage 11 — live-view modal + generic fullscreen wiring. live-view's
// inline onclicks live in index.html. closeLiveView and _initFsBtn
// are now consumed directly by lightbox.js (stage 23 B); the side-
// effect import keeps live-view.js's DOM listeners wired at boot.
import './chrome/live-view.js';
import './chrome/fullscreen.js';
// Stage 12 — Telegram + Push. push.js inlines the wetter-events
// extension that used to monkey-patch hydratePushUI; renderWeather
// Sightings / loadWeatherSightings monkey-patches at line ~6700 stay
// in legacy.js until stage 16 ships weather/sightings.js.
import { hydrateTelegram, initTelegramTabs } from './telegram.js';
import { hydratePushUI } from './push.js';
// Stage 13 — easy mediathek pieces. Lightbox / bbox / iOS-video /
// drilldown stay in this file for now; their lbState.item state is shared
// across 90+ callsites and needs a coordinated extraction.
import './mediathek/rescan.js';
import './mediathek/bulk-delete.js';
import './mediathek/grid.js';
// Stage 14 — animal silhouettes (pure data tables) + Sichtungen panel.
// loadAchievements is bridged on window so the boot block at the end
// of this file (`loadAll().then(...,loadAchievements())`) keeps working
// without per-callsite import changes — the boot kickoff also moves
// in stage 18.
import { loadAchievements, renderAchievements } from './sichtungen.js';
// Stage 15 — Statistik dashboard. Self-bound: IntersectionObserver
// triggers loadStatistik on scroll, refresh button is wired on
// import. _statOpenMedia is bridged on window for inline onclicks.
import './statistics.js';
// Stage 16 (partial) — Wetter-Ereignis types (label + colour + icon).
// Sightings + settings still live in this file pending stage 24 B / C.
import { WEATHER_TYPES } from './core/weather-types.js';
// Stage 24 A — Wetterstatistik chart + explainer + legend + pill bar.
// initWeatherStats is bridged on window because loadAll (live-update.js)
// resolves it that way; once loadAll switches to a direct named import
// the bridge below evaporates.
import {
  loadWeatherStats, renderWeatherStats, renderWeatherStatsChart,
  renderWeatherStatsLegend, renderWeatherStatsExplainer, initWeatherStats,
} from './weather/stats.js';
// Stage 24 B — Sichtungen grid + lightbox + recaps + hash-anchor router.
// loadWeatherSightings is bridged on window because router.js calls it
// that way. The hashchange + DOMContentLoaded listeners run at
// module-import time.
import {
  loadWeatherSightings, renderWeatherSightings, openWeatherLightbox,
  closeWeatherLightbox, loadWeatherRecaps, openWeatherRecapLightbox,
} from './weather/sightings.js';
// Stage 24 C — Wetter-Einstellungen tab (cam panels, event blocks,
// location map, status). initWeatherTabs + hydrateWeatherSettings are
// bridged on window because loadAll() resolves them that way.
import { initWeatherTabs, hydrateWeatherSettings } from './weather/settings.js';
// Stage 25 A — Coral TPU test panel. Side-effect import: the module
// binds the "Reload" button on load and assigns its own window.*
// handlers for the inline onclicks on the test page.
import './camedit/coral-test.js';
// Stage 17 — Alerting tab: per-class severity matrix + cooldown grid +
// conflict banner + test-push button + status strip. _renderAlert
// StatusStrip is bridged on window for live-update.js's 3 s poll.
import {
  _renderSeverityMatrix, _collectClassSeverity, _checkAlertingConflicts,
  _renderAlertCooldownGrid, _bindAlertCooldownToggle, _collectAlertCooldown,
  _bindAlertTestButton, _bindAlertingConflictWatch,
  _renderAlertStatusStrip,
} from './alerting.js';
// Stage 18 — Telegram deep-link router. Resolves Telegram-bubble URLs
// (#/event/<id>, #/sighting/<id>, #/recap/<id>) to the right section
// + lightbox. Runs hashchange + 1.5 s post-load self-bind.
import './router.js';
// Stages 20–22 (lbState + bbox-overlay + iOS-video handoff) are now
// consumed directly by lightbox.js (stage 23 B). lightbox.js imports
// them too, so the modules + their IIFEs load transitively without
// needing duplicate imports here.

// _hmTip moved with statistics.js (Stage 15) — its only consumer was
// the heatmap tooltip in _renderStatistik.
// OBJ_SVG / objBubble / objIconSvg / TL_LABELS now live in core/icons.js
// _renderLbLabels moved to lightbox.js (Stage 23 B).
// getCameraIcon / getCameraColor now live in core/icons.js.
// shapeState now lives in core/state.js. byId / esc now live in
// core/dom.js. The fetch helper `j` now lives in core/api.js.

// SQUIRREL_CHARS retired — its renderer was removed in the hero-panel
// refactor (the hyphen of "TAM-spy" got an inline SVG ornament instead),
// and `(()=>{const el=byId('heroSquirrel');if(el)el.innerHTML='';})()`
// at the bottom of this file is the only surviving reference (a no-op
// safety guard against a stale template).

// Tiny helper used by the export-config buttons in the App-Section.
const download = (url) => window.open(url, '_blank');

// _failedSnapshotIds + dead-id helpers + _camImgRetry now live in
// dashboard.js (Stage 3a). The window._camImgRetry bridge moves with
// the function so inline onclick="_camImgRetry(this)" keeps resolving.

// ── Camera edit slide panel ───────────────────────────────────────────────────
// Now lives in camedit/panel.js (Stage 7). _currentEditCamId is gone —
// replaced by the imported `panelState.camId`. Mutating the field on
// the shared object propagates to every importer because ES module
// imports are live bindings to the same object reference.

// ── Live update ───────────────────────────────────────────────────────────────
// startLiveUpdate + loadAll now live in live-update.js (Stage 6).
// loadAll is also bridged on window so the many in-file callers (save
// flows, toggleArm, quick-delete, …) continue to resolve via the same
// `loadAll(...)` they always did — no per-callsite import edit
// needed because the import at the top brings the name into module
// scope here too.

// Mediathek orchestration (drilldown openers, filter pills, loadMedia,
// grid + pagination + processing-poll, overview cards, section title)
// extracted to mediathek/orchestration.js in stage 23. The window.* bridges
// further down keep inline onclicks + still-resident callers resolving.

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

// ── Timeline ─────────────────────────────────────────────────────────────────
// Now lives in timeline.js (Stage 6). renderTimeline + helpers +
// CAT_COLORS / TL_LANES / GAP_MS constants moved together.

// ── RTSP / URL masking / Connection builder ─────────────────────────────────
// Now lives in camedit/rtsp.js (Stage 7). RTSP_PATH_OPTS, _rtspEnc,
// _maskUrlPassword, _applyUrlMask, _revealUrl, _unmaskUrlsForSubmit,
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

// ── Whitelist chips ───────────────────────────────────────────────────────────
// Now lives in camedit/whitelist.js (Stage 7). Internal _whitelistState
// is hidden inside the module; this file reads/writes via the
// imported getWhitelistState() / setWhitelistState() pair. The save
// flow at line ~3300 and editCamera at line ~1600 are the two callers
// inside this file.

// ── camera_id JS port — keep in lockstep with app/app/camera_id.py ──────────
// Now lives in camedit/camera_id.js (Stage 7). buildCameraId,
// _camIdSanitise, _camIdLastIpSegment, _CAM_ID_TRANSLIT all moved
// together. _CW_DEFAULTS / _renderCamConfirmGrid below stay until
// stage 8 ships the camedit/detection.js extraction.


// _refreshCamIdPreview + _bindCamIdPreviewListeners now live in
// camedit/camera_id.js (Stage 7); editCamera below imports them.

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

// ── Connection-recovery modal + indicator + diagnostics ─────────────────────
// Now lives in camedit/recovery.js (Stage 7). _refreshConnectionWarn,
// _loadCamDiagnostics, the Sicherung/Auto-Erkennung modal helpers and
// the _toggleCamDiag inline handler all moved together. editCamera()
// in this file calls _refreshConnectionWarn + _loadCamDiagnostics via
// direct named imports; the modal opens through its window bridges.
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
// _cvCardClick now lives in dashboard.js (Stage 3b). Its window
// bridge migrates with the function so the inline onclick handler
// rendered into each cv-card keeps resolving.
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
      if(!await showConfirm(msg)) return;
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
// Camera-card placeholder rendering moved with the dashboard module
// in stage 3 — the offline frame, the connecting animation, and
// reloadCamera now live in dashboard.js. The camera_id stamp on the
// retry button (window._camImgRetry) is bridged from there.

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







byId('wiz_cam_rtsp').value='rtsp://user:pass@192.168.X.X:554/Streaming/Channels/101';
byId('wiz_cam_snapshot').value='http://user:pass@192.168.X.X/cgi-bin/snapshot.cgi';
let wizStep=1;
document.querySelectorAll('.wiz-tab').forEach(btn=>btn.onclick=()=>{ wizStep=Number(btn.dataset.step); showWizardStep(wizStep); });
byId('wizPrev').onclick=()=>{ wizStep=Math.max(1,wizStep-1); showWizardStep(wizStep); };
byId('wizNext').onclick=()=>{ wizStep=Math.min(4,wizStep+1); showWizardStep(wizStep); };
byId('wizFinish').onclick=()=>finishWizard();







// CAM_COLORS, camColor, hexToRgba, getMediaAccentColor, fmtMedia*,
// mediaCardHTML, _MOC_*, renderMediaOverview, _setActiveMocCard,
// drilldown openers, _goToPage, renderMediaPagination, _ensureProcessingPoll,
// renderMediaGrid, _MEDIA_TITLE_SVG, updateMediaSectionTitle, syncMediaPills:
// all extracted to mediathek/orchestration.js in stage 23. _TL_FILMSTRIP
// stays here — still referenced by the timelapse-card snippet above.
const _TL_FILMSTRIP=`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#c4b5fd" stroke-width="2" stroke-linecap="round" style="flex-shrink:0"><line x1="6" y1="3" x2="18" y2="3"/><line x1="6" y1="21" x2="18" y2="21"/><polygon points="7,4 17,4 12,12" fill="#c4b5fd" opacity=".8"/><polygon points="12,12 7,20 17,20" fill="#c4b5fd" opacity=".5"/></svg>`;
// deleteMediaCard / deleteTLCard / confirmMediaCard moved to
// mediathek/orchestration.js (Stage 23 C). The window.* bridges below
// keep the inline onclicks rendered by mediaCardHTML resolving.



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


loadAll().then(()=>{startLiveUpdate(); loadAchievements();});
// loadLogs() now self-fires from chrome/logs.js's import-time boot.

// ── Wetter-Ereignisse (Phase 2) ─────────────────────────────────────────────





// ── Wetter-Ereignisse Phase 3: Recaps + push UI + hash anchor ───────────────



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
window._statOpenMedia     = _statOpenMedia;
window.byId               = byId;
window.closeMediaDrilldown = closeMediaDrilldown;
window.openMediaDrilldown = openMediaDrilldown;
// _openMediaItem is intentionally NOT bridged here. It has no
// top-level binding — the only definition is `window._openMediaItem =
// id => {...}` inside the media-grid render function (renderMedia),
// which runs every time the gallery is populated. Bridging from a
// module-level binding would throw ReferenceError because none
// exists; the inline onclicks ("window._openMediaItem(...)") look
// up the property directly and work as soon as the gallery renders.

// Stage 6 — renderers/hydrators that loadAll() (now in live-update.js)
// invokes via window.X because they still live in this file. Each
// migrates to a direct named import as its domain extracts in
// stage 7+, and the matching line below disappears at that point.
window.renderShell             = renderShell;
window.renderCameraSettings    = renderCameraSettings;
window.renderProfiles          = renderProfiles;
window.renderAudit             = renderAudit;
window.hydrateSettings         = hydrateSettings;
window.initWeatherTabs         = initWeatherTabs;
window.initWeatherStats        = initWeatherStats;
window.loadWeatherSightings    = loadWeatherSightings;
window.hydrateWeatherSettings  = hydrateWeatherSettings;
window.loadTlStatus            = loadTlStatus;
window._updateTlActiveTags     = _updateTlActiveTags;
window.openWizard              = openWizard;
window.updateMediaSectionTitle = updateMediaSectionTitle;
window.loadMedia               = loadMedia;
window.renderMediaGrid         = renderMediaGrid;
// Stage 23 bridges — these used to live next to the function bodies in
// legacy.js. Now that mediathek/orchestration.js owns the bodies, the
// bridges still live here so inline onclicks ("openMediaDrilldown(...)")
// + still-resident callers (router.js, statistics.js, timeline.js,
// chrome/storage-stats.js) keep resolving. Each bridge evaporates as
// its consumer migrates to a direct import.
window.openAllMediaDrilldown   = openAllMediaDrilldown;
window.openCategoryDrilldown   = openCategoryDrilldown;
window.calcItemsPerPage        = calcItemsPerPage;
window.renderMediaPagination   = renderMediaPagination;
window.renderMediaOverview     = renderMediaOverview;
window.renderMediaFilterPills  = renderMediaFilterPills;
window._pruneEmptyMediaFilters = _pruneEmptyMediaFilters;
window._seedTopMediaLabel      = _seedTopMediaLabel;
// Stage 23 B — lightbox bridges. Consumed by router.js
// (_openLightboxByEventId), inline onclicks rendered in cards,
// timeline.js's media-drill click handler, and a couple of cam-edit
// flows that pop the lightbox after save.
window.openLightbox            = openLightbox;
window.closeLightbox           = closeLightbox;
window.openTLPlayer            = openTLPlayer;
// Stage 23 C — card-action bridges. Consumed by inline onclicks
// rendered inside mediaCardHTML. Each evaporates when its card swaps
// to delegated event listeners.
window.deleteMediaCard         = deleteMediaCard;
window.deleteTLCard            = deleteTLCard;
window.confirmMediaCard        = confirmMediaCard;
// Stage 6 — wire the merge-modal DOM listeners once. camera-merge.js
// owns the open/select/close logic but its event listeners need to
// fire after the static template has rendered (always true since this
// script loads as a module = deferred).
bindMergeModal();
