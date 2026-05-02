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
import {
  _LB_CHECK_SVG, _LB_CHECK2_SVG, _LB_HINT, _LB_TRASH_HTML,
  _updateLbConfirmBtn,
  _lbClearDetections, _lbResetToPhoto, _lbShowError,
} from './lightbox.js';
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
// Stage 11 — live-view modal + generic fullscreen wiring. live-view's
// inline onclicks live in index.html; fullscreen.js exports _initFsBtn
// for the live-view IIFE binding at the bottom of this file (and the
// lightbox in stage 13).
import { closeLiveView } from './chrome/live-view.js';
import { _initFsBtn } from './chrome/fullscreen.js';
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
// The bigger weather modules (sightings, chart, settings, map,
// recaps) stay in this file for now; extracting WEATHER_TYPES early
// lets push.js drop its window.WEATHER_TYPES lookup.
import { WEATHER_TYPES } from './core/weather-types.js';
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
// Stage 20 — shared lightbox state (lbState.item/index/deletePending).
// Mutated by the lightbox / iOS handoff / nav / delete handlers below.
// Importing the object means every consumer (legacy + future
// extractions) reads and writes the same reference.
import { lbState } from './mediathek/state.js';

// _hmTip moved with statistics.js (Stage 15) — its only consumer was
// the heatmap tooltip in _renderStatistik.
// OBJ_SVG / objBubble / objIconSvg / TL_LABELS now live in core/icons.js
function _renderLbLabels(){
  const el=byId('lightboxLabels');
  if(!el||!lbState.item) return;
  const active=new Set(lbState.item.labels||[]);
  const species=lbState.item.bird_species||'';
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
      const cur=new Set(lbState.item.labels||[]);
      if(cur.has(lbl)) cur.delete(lbl); else cur.add(lbl);
      const newLabels=[...cur];
      try{
        const res=await j(`/api/camera/${lbState.item.camera_id}/events/${lbState.item.event_id}/labels`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({labels:newLabels})});
        if(res.ok){
          lbState.item.labels=res.labels;
          if(res.top_label!==undefined) lbState.item.top_label=res.top_label;
          const idx=(state.media||[]).findIndex(x=>x.event_id===lbState.item.event_id);
          if(idx>=0){
            state.media[idx].labels=res.labels;
            if(res.top_label!==undefined) state.media[idx].top_label=res.top_label;
          }
          const aIdx=(state._allMedia||[]).findIndex(x=>x.event_id===lbState.item.event_id);
          if(aIdx>=0){
            state._allMedia[aIdx].labels=res.labels;
            if(res.top_label!==undefined) state._allMedia[aIdx].top_label=res.top_label;
          }
          _renderLbLabels();
          // sync thumbnail in media grid
          const thumbCard=byId('mediaGrid')?.querySelector(`[data-event-id="${CSS.escape(lbState.item.event_id)}"]`);
          if(thumbCard){const bubblesEl=thumbCard.querySelector('.media-label-bubbles');if(bubblesEl) bubblesEl.innerHTML=res.labels.slice(0,3).map(l=>objBubble(l,26)).join('');}
          // Re-pull timeline + storage stats so badges and dots reflect the retag.
          refreshTimelineAndStats();
        }
      }catch(e){ showToast('Label-Änderung fehlgeschlagen','error'); }
    };
  });
}
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

// Single source of truth for page size: rows × dynamic column count.
// Called before every load, page-change, delete, resize, and filter-change.
// _lastKnownCols + window._cachedPageSize are bridged on window so the grid.js
// resize observer (extracted in stage 13) can read AND write the same
// counter — without the bridge it would set its own copy and the
// re-render below would never see the update.
window._lastKnownCols ??= 0;
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
  const cols=window._lastKnownCols||Math.max(1,Math.floor((containerW+GAP)/(MIN_CARD+GAP)));
  return _MEDIA_ROWS*cols;
}
window.calcItemsPerPage = calcItemsPerPage;
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
window._cachedPageSize ??= 0;
async function loadMedia(){
  const labels=state.mediaLabels;
  const ps=calcItemsPerPage(); window._cachedPageSize=ps;
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






// ── Lightbox / Media viewer ───────────────────────────────────────────────────
// Lightbox state moved to mediathek/state.js (Stage 20). The shared
// lbState object is mutated by the open/close/nav/delete/confirm
// handlers below; future per-domain extractions (bbox-overlay, iOS
// handoff, drilldown) read the same object via the same import.
function _lbHandleDeleteKey(){
  if(!lbState.item) return;
  if(lbState.item.confirmed&&!lbState.deletePending){
    lbState.deletePending=true;
    const btn=byId('lightboxDelete');
    if(btn){btn.classList.add('confirm-delete');btn.innerHTML='<span>🗑</span><span style="font-size:9px">↓ nochmal</span>';}
    return;
  }
  byId('lightboxDelete').click();
}
// _LB_CHECK_SVG / _LB_CHECK2_SVG / _LB_HINT / _LB_TRASH_HTML and
// _updateLbConfirmBtn now live in lightbox.js (Stage 4).
// ── Detection-bbox overlay ───────────────────────────────────────────────────
// Draws coloured rectangles + labels over the active lightbox media. Bbox
// coords come from lbState.item.detections[].bbox in the original frame's pixel
// space; we scale them to the object-fit:contain rendered rectangle so they
// line up whether the media is letterboxed vertically or horizontally.
function _lbDrawDetections(){
  const cv=byId('lightboxDetections'); if(!cv||!lbState.item) return;
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
  const dets=(lbState.item.detections||[]).filter(d=>d&&d.bbox&&typeof d.bbox.x1==='number');
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
// _lbClearDetections now lives in lightbox.js (Stage 4).
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

// _lbResetToPhoto and _lbShowError now live in lightbox.js (Stage 4).
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
  lbState.index=globalList.findIndex(x=>x.event_id===item.event_id);
  if(lbState.index===-1){
    // Fallback: item came from somewhere outside the cached merged list
    // (rare). Open it anyway with single-item nav so the lightbox still
    // works — just no prev/next.
    lbState.index=0;
    lbState.item=item;
  } else {
    lbState.item=globalList[lbState.index];
  }
  // If the navigated item lives outside the current page window, jump
  // the grid's page so the thumbnails behind the lightbox match what
  // the user sees on the lightbox itself. Re-rendering keeps current
  // scroll because the user is still inside the lightbox modal.
  const ps=window._cachedPageSize||calcItemsPerPage();
  if(window._cachedPageSize && globalList.length>0){
    const targetPage=Math.floor(lbState.index/ps);
    if(targetPage!==state.mediaPage){
      state.mediaPage=targetPage;
      const offset=targetPage*ps;
      state.media=globalList.slice(offset,offset+ps);
      try{renderMediaGrid();renderMediaPagination();}catch(_){}
    }
  }
  lbState.deletePending=false;
  _lbResetToPhoto();
  const delBtn=byId('lightboxDelete');
  if(delBtn){delBtn.classList.remove('confirm-delete');delBtn.innerHTML=_LB_TRASH_HTML;delBtn.title=lbState.item.confirmed?'Bestätigt — trotzdem löschen?':'Löschen';}
  _updateLbConfirmBtn(lbState.item.confirmed);
  // Show video player for motion clips, image for snapshots
  const vidSrc=lbState.item.video_relpath?`/media/${lbState.item.video_relpath}`:(lbState.item.video_url||'');
  const imgSrc=lbState.item.snapshot_relpath?`/media/${lbState.item.snapshot_relpath}`:(lbState.item.snapshot_url||'');
  const hasVideoLabel=(lbState.item.labels||[]).some(l=>['motion','car','person','cat','bird','dog','squirrel'].includes(l));
  const pendingMsg=lbState.item.status==='recording'?'Video wird aufgenommen…':lbState.item.status==='processing'?'Video wird verarbeitet…':null;
  if(pendingMsg){
    _lbShowError(pendingMsg);
  } else if(vidSrc){
    const imgEl=byId('lightboxImg'); imgEl.style.display='none';
    const videoEl=byId('lightboxVideo');
    videoEl.style.display='block'; videoEl.src=vidSrc; videoEl.muted=true; videoEl.loop=true;
    videoEl.load(); videoEl.play().catch(()=>{});
  } else if(!imgSrc && (hasVideoLabel || lbState.item.encode_error)){
    _lbShowError('Video nicht verfügbar');
  } else {
    byId('lightboxImg').src=imgSrc;
  }
  const confirmedBadge=lbState.item.confirmed?`<span style="background:#166534;color:#4ade80;border-radius:999px;padding:3px 10px;font-size:11px;font-weight:700">✓ Behalten</span>`:'';
  byId('lightboxMeta').innerHTML=`
    <span class="badge">${esc(lbState.item.camera_id||'')}</span>
    <span class="badge">${esc(lbState.item.time||'')}</span>
    ${vidSrc?'<span class="badge">🎬 Video</span>':''}
    ${confirmedBadge}`;
  _renderLbLabels();
  // Edge dim only at the GLOBAL boundaries — page edges navigate through.
  byId('lightboxPrev').style.opacity=lbState.index>0?'1':'0.2';
  byId('lightboxNext').style.opacity=lbState.index<((state._allMedia||[]).length-1)?'1':'0.2';
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
  lbState.index=navItems.findIndex(x=>x.event_id===item.event_id);
  lbState.item=lbState.index>=0?navItems[lbState.index]:item;
  // Jump the grid page when this item lives outside the current page
  // window, so the thumbnails behind the lightbox match the lightbox
  // content — same rule as openLightbox above.
  const ps=window._cachedPageSize||calcItemsPerPage();
  if(lbState.index>=0 && window._cachedPageSize && navItems.length>0){
    const targetPage=Math.floor(lbState.index/ps);
    if(targetPage!==state.mediaPage){
      state.mediaPage=targetPage;
      const offset=targetPage*ps;
      state.media=navItems.slice(offset,offset+ps);
      try{renderMediaGrid();renderMediaPagination();}catch(_){}
    }
  }
  lbState.deletePending=false;
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
  byId('lightboxPrev').style.opacity=lbState.index>0?'1':'0.2';
  byId('lightboxNext').style.opacity=lbState.index<total-1?'1':'0.2';
  byId('lightboxModal').classList.remove('hidden');
  document.body.style.overflow='hidden';
}
function closeLightbox(){
  if(document.fullscreenElement||document.webkitFullscreenElement){
    (document.exitFullscreen||document.webkitExitFullscreen||function(){}).call(document).catch(()=>{});
  }
  byId('lightboxModal').classList.add('hidden');
  document.body.style.overflow='';
  lbState.item=null; lbState.index=-1;
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
byId('lightboxPrev').onclick=()=>{const nav=_lbNavList();const i=nav.findIndex(x=>x.event_id===lbState.item?.event_id);if(i>0) openLightbox(nav[i-1]);};
byId('lightboxNext').onclick=()=>{const nav=_lbNavList();const i=nav.findIndex(x=>x.event_id===lbState.item?.event_id);if(i>=0&&i<nav.length-1) openLightbox(nav[i+1]);};
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
      const nav=_lbNavList();const i=nav.findIndex(x=>x.event_id===lbState.item?.event_id);
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
      const nav=_lbNavList();const i=nav.findIndex(x=>x.event_id===lbState.item?.event_id);
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
  // Keep lbState.item / lbState.index in sync with state._allMedia for the
  // inline ✓/✗ buttons on each card to operate on the right entry.
  const globalList=state._allMedia||[];
  const idx=globalList.findIndex(x=>x.event_id===item.event_id);
  lbState.index=idx>=0?idx:0;
  lbState.item=idx>=0?globalList[idx]:item;
  _iosCurrentItem=lbState.item;
  const vidSrc=lbState.item.video_relpath?`/media/${lbState.item.video_relpath}`:(lbState.item.video_url||'');
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
  if(!lbState.item) return;
  const{camera_id,event_id}=lbState.item;
  if(!camera_id||!event_id) return;
  try{
    await j(`/api/camera/${encodeURIComponent(camera_id)}/events/${encodeURIComponent(event_id)}/confirm`,{method:'POST'});
    // update state.media in place
    const sIdx=(state.media||[]).findIndex(x=>x.event_id===event_id);
    if(sIdx>=0) state.media[sIdx].confirmed=true;
    _updateLbConfirmBtn(true);
    if(lbState.item) lbState.item.confirmed=true;
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
  if(!lbState.item) return;
  // Timelapse deletion
  if(lbState.item.type==='timelapse'){
    if(!lbState.deletePending){
      lbState.deletePending=true;
      const btn=byId('lightboxDelete');
      if(btn){btn.classList.add('confirm-delete');btn.innerHTML='<span style="font-size:15px;line-height:1;opacity:.75">↓</span><span style="font-size:11px">nochmal</span>';}
      return;
    }
    const filename=lbState.item.filename||(lbState.item.relpath||'').split('/').pop();
    if(!filename){showToast('Dateiname fehlt','error');return;}
    try{
      await j(`/api/camera/${encodeURIComponent(lbState.item.camera_id)}/timelapse/${encodeURIComponent(filename)}`,{method:'DELETE'});
      const deletedId=lbState.item.event_id;
      state.media=(state.media||[]).filter(x=>x.event_id!==deletedId);
      state._allMedia=(state._allMedia||[]).filter(x=>x.event_id!==deletedId);
      renderMediaGrid();
      const nav=_tlNavItems();
      const nextIdx=Math.min(lbState.index,nav.length-1);
      if(nextIdx<0) closeLightbox();
      else openLightbox(nav[nextIdx]);
    }catch(e){showToast('Löschen fehlgeschlagen: '+e.message,'error');}
    return;
  }
  // Photo event deletion
  const{camera_id,event_id}=lbState.item;
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
    lbState.index=Math.min(lbState.index,(state.media||[]).length-1);
    if(lbState.index<0) closeLightbox();
    else openLightbox(state.media[lbState.index]);
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
// Stage 13 — bridges so the extracted mediathek modules (grid.js,
// bulk-delete.js) can call back into these renderers via window.
// Removed once the lightbox surgery extracts the rest of mediathek.
window.renderMediaPagination = renderMediaPagination;
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
    if(actualCols!==window._lastKnownCols) window._lastKnownCols=actualCols;
    const correctPs=_MEDIA_ROWS*actualCols;
    if(correctPs!==window._cachedPageSize&&state._allMedia&&state._allMedia.length){
      window._cachedPageSize=correctPs;
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

// Legacy alias — pills are now rendered dynamically via renderMediaFilterPills.
function syncMediaPills(){ renderMediaFilterPills('drilldown'); }
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


let _mediaResizeTimer=0;
window.addEventListener('resize',()=>{
  clearTimeout(_mediaResizeTimer);
  _mediaResizeTimer=setTimeout(()=>{
    if(byId('mediaDrilldown')?.style.display!=='none'){
      const ns=calcItemsPerPage();
      if(Math.abs(ns-window._cachedPageSize)>=4){
        window._cachedPageSize=ns;
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
// loadLogs() now self-fires from chrome/logs.js's import-time boot.

// ── Wetter-Ereignisse (Phase 2) ─────────────────────────────────────────────


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
      d += (d ? ' ' : '') + _wsCatmullRomPath(run, 0.3);
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

// Round to a "nice number" — 1 / 2 / 5 × 10^n. round=true picks the
// nearest nice value (good for tick steps); round=false picks the
// next nice value ≥ input (good for axis bounds). Used by the
// Wetterstatistik chart for human-readable Y labels (0/5/10/15
// instead of 0.13/4.97/9.81/14.65).
function _niceNum(value, round){
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const f = value / Math.pow(10, exp);
  let nf;
  if (round){
    if (f < 1.5)      nf = 1;
    else if (f < 3)   nf = 2;
    else if (f < 7)   nf = 5;
    else              nf = 10;
  } else {
    if (f <= 1)       nf = 1;
    else if (f <= 2)  nf = 2;
    else if (f <= 5)  nf = 5;
    else              nf = 10;
  }
  return nf * Math.pow(10, exp);
}

// Generate ~`target` evenly-spaced "nice" tick values across [lo, hi].
// Returns the tick array plus the snapped lo/hi so the caller can use
// the rounded bounds as the Y-axis baseline.
function _niceAxisTicks(lo, hi, target){
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 1e-9){
    return { ticks: [lo], step: 1, niceLo: lo, niceHi: hi };
  }
  const range = _niceNum(hi - lo, false);
  const step  = _niceNum(range / Math.max(1, target - 1), true);
  const niceLo = Math.floor(lo / step) * step;
  const niceHi = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = niceLo; v <= niceHi + step / 2; v += step) ticks.push(v);
  return { ticks, step, niceLo, niceHi };
}

// Time-tick step ladder used by the chart's X-axis. Each entry is a
// candidate spacing in milliseconds; the picker snaps to the entry
// that gets the visible tick count closest to `target` for the
// current window. Covers 5 min through 1 year so a 24 h zoom shows
// 6 hourly ticks and a 6 mo zoom shows monthly ticks without a
// fixed if-else ladder.
const _WS_TIME_STEP_LADDER_MS = [
  5*60_000, 10*60_000, 15*60_000, 30*60_000,
  60*60_000, 2*60*60_000, 3*60*60_000, 6*60*60_000, 12*60*60_000,
  24*60*60_000, 2*24*60*60_000, 7*24*60*60_000, 14*24*60*60_000,
  30*24*60*60_000, 90*24*60*60_000, 180*24*60*60_000, 365*24*60*60_000,
];

function _wsPickTimeStep(spanMs, target){
  let best = _WS_TIME_STEP_LADDER_MS[0];
  let bestDiff = Infinity;
  for (const s of _WS_TIME_STEP_LADDER_MS){
    const count = spanMs / s;
    if (count < 2) continue;  // would yield <2 ticks → skip
    const diff = Math.abs(count - target);
    if (diff < bestDiff){ bestDiff = diff; best = s; }
  }
  return best;
}

// Snap a timestamp to the next "nice" boundary AT OR AFTER it,
// matching the step magnitude. Sub-day → round to the next hour;
// 1 d → midnight; ≥ 1 mo → start-of-month.
function _wsAnchorTickStart(tFirst, stepMs){
  const d = new Date(tFirst);
  if (stepMs < 24*60*60_000){
    d.setMinutes(0, 0, 0);
    if (d.getTime() < tFirst) d.setHours(d.getHours() + 1);
    return d.getTime();
  }
  if (stepMs < 30*24*60*60_000){
    d.setHours(0, 0, 0, 0);
    if (d.getTime() < tFirst) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  // Month-magnitude or larger: anchor at the 1st of the next month.
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  if (d.getTime() < tFirst) d.setMonth(d.getMonth() + 1);
  return d.getTime();
}

const _WS_MONTHS_DE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun',
                       'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

function _wsFmtTimeTick(t, stepMs){
  const d = new Date(t);
  const p2 = n => (n < 10 ? '0' : '') + n;
  if (stepMs < 24*60*60_000){
    return p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  if (stepMs < 60*24*60*60_000){
    return p2(d.getDate()) + '. ' + _WS_MONTHS_DE[d.getMonth()];
  }
  return _WS_MONTHS_DE[d.getMonth()] + ' ' + String(d.getFullYear()).slice(-2);
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

  // X-axis tick generation. Picks a step from a candidate ladder so
  // the visible tick count stays close to 6 regardless of window
  // size; format adapts to step magnitude (HH:MM / dd. MMM / MMM YY).
  // Falls back to the legacy index-based 6-tick scheme if timestamps
  // don't parse.
  const tFirst = new Date(samples[0]?.ts).getTime();
  const tLast = new Date(samples[samples.length - 1]?.ts).getTime();
  const tSpan = tLast - tFirst;
  let tickSvg = '';
  if (Number.isFinite(tFirst) && Number.isFinite(tLast) && tSpan > 0){
    const stepMs = _wsPickTimeStep(tSpan, 6);
    const firstTick = _wsAnchorTickStart(tFirst, stepMs);
    const ticks = [];
    for (let t = firstTick; t <= tLast; t += stepMs) ticks.push(t);
    for (const t of ticks){
      const x = pad.l + ((t - tFirst) / tSpan) * cw;
      const label = _wsFmtTimeTick(t, stepMs);
      tickSvg += `<line x1="${x.toFixed(1)}" y1="${(pad.t + ch).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(pad.t + ch + 5).toFixed(1)}" stroke="rgba(255,255,255,.12)" stroke-width="1" shape-rendering="geometricPrecision"/>`;
      tickSvg += `<text x="${x.toFixed(1)}" y="${(VB_H - 8).toFixed(1)}" text-anchor="middle" font-size="10" fill="rgba(255,255,255,.55)" text-rendering="optimizeLegibility" shape-rendering="geometricPrecision">${label}</text>`;
    }
  } else {
    const last = samples.length - 1;
    const intervals = 5;
    for (let k = 0; k <= intervals; k++){
      const idx = Math.round(last * k / intervals);
      const x = pad.l + (idx / last) * cw;
      const anchor = k === 0 ? 'start' : k === intervals ? 'end' : 'middle';
      tickSvg += `<text x="${x.toFixed(1)}" y="${(VB_H - 8).toFixed(1)}" text-anchor="${anchor}" font-size="10" fill="rgba(255,255,255,.55)" text-rendering="optimizeLegibility">${_wsFmtTick(samples[idx]?.ts, hours)}</text>`;
    }
  }

  // Horizontal gridlines — the Y-axis loop further down emits its own
  // gridline at every nice tick when the chart is in isolated mode
  // (so the lines hit the labelled values exactly). In all-lines mode
  // we draw 4 evenly-spaced lines as a fallback, since each line is
  // independently normalised and there's no shared Y scale.
  let gridSvg = '';
  if (!isolated){
    for (let g = 0; g <= 4; g++){
      const y = pad.t + (g / 4) * ch;
      gridSvg += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${(pad.l + cw).toFixed(1)}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,.07)" stroke-width="1" vector-effect="non-scaling-stroke" shape-rendering="geometricPrecision"/>`;
    }
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
    linesSvg += `<path d="${meta.path}" fill="none" stroke="${colour}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}" vector-effect="non-scaling-stroke" shape-rendering="geometricPrecision" />`;
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
        const colour = WEATHER_STATS_PALETTE[isolated] || '#94a3b8';
        // Grafana-style: thin dashed horizontal in the LINE's colour
        // (not red) so the threshold reads as part of the same series,
        // plus a colour-tinted small label outside the right edge of
        // the plot. Keeps paint-order halo for legibility against the
        // chart background.
        const lbl = `${thr}${u ? ' ' + u : ''}`;
        thresholdSvg = `
          <line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${pad.l + cw}" y2="${y.toFixed(1)}"
                stroke="${colour}" stroke-width="1" stroke-dasharray="5 4" opacity="0.55"
                vector-effect="non-scaling-stroke" shape-rendering="geometricPrecision" />
          <text class="ws-chart-threshold-label" x="${(pad.l + cw + 4).toFixed(1)}" y="${(y + 3).toFixed(1)}" font-size="9" fill="${colour}" opacity="0.85" text-rendering="optimizeLegibility">${lbl}</text>
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
  // Y-axis labels — isolated mode only. 4 nice-rounded values (top,
  // 2/3, 1/3, bottom) in the line's own colour, plus a horizontal
  // gridline at each label's Y position so the lines reads against
  // the labelled value exactly. niceNum() rounds to 1/2/5 × 10^n so
  // labels read 0 / 5 / 10 / 15 instead of 0.13 / 4.97 / 9.81 / 14.65.
  // All-lines mode: each line is independently normalised, no shared
  // Y scale to label — the fixed 4-line gridSvg above provides the
  // visual anchoring.
  let yAxisSvg = '';
  if (isolated && lineMetas[isolated]){
    const meta = lineMetas[isolated];
    const u = (data?.units || {})[isolated] || '';
    const colour = WEATHER_STATS_PALETTE[isolated] || '#94a3b8';
    const { ticks } = _niceAxisTicks(meta.lo, meta.hi, 4);
    const span = (meta.hi - meta.lo) || 1;
    const fmtNice = v => {
      if (Number.isInteger(v)) return String(v);
      return v.toFixed(Math.abs(v) < 10 ? 1 : 0);
    };
    for (const v of ticks){
      // Skip ticks outside the data range (niceNum can over-shoot).
      if (v < meta.lo - span * 0.05 || v > meta.hi + span * 0.05) continue;
      const norm = (v - meta.lo) / span;
      const y = pad.t + ch - norm * ch;
      const txt = `${fmtNice(v)}${u ? ' ' + u : ''}`;
      // Horizontal gridline at this label's Y — opacity 0.07 so it
      // recedes behind the data line.
      yAxisSvg += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${(pad.l + cw).toFixed(1)}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,.07)" stroke-width="1" vector-effect="non-scaling-stroke" shape-rendering="geometricPrecision"/>`;
      yAxisSvg += `<text x="${pad.l - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="${colour}" opacity="0.75" text-rendering="optimizeLegibility" shape-rendering="geometricPrecision">${txt}</text>`;
    }
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
  // Pre-compute the active-camera id set so each sighting card can
  // decide whether to actually request its thumb. Sightings recorded
  // before a manuf/model edit carry the OLD canonical cam_id in their
  // sighting.id (the on-disk path was already renamed by storage_
  // migration), so the thumb URL 404s. Skipping the <img> tag for
  // those entries avoids the network request and keeps the console
  // clean — the card still renders with a placeholder so the user can
  // see the orphan exists and decide whether to delete it.
  const _activeCamIds = new Set((state.cameras || []).map(c => c.id));
  grid.innerHTML = items.map((s, idx) => {
    const meta = WEATHER_TYPES[s.event_type] || { de: s.event_type, color: '#94a3b8', icon: '' };
    // For sun-timelapse sightings the user wants the actual sunrise /
    // sunset time on the card, not the window-end timestamp. sun_event_at
    // is the manifest field added in this commit; fall back to started_at
    // for older records that don't carry it.
    const tsRaw = s.sun_event_at || s.started_at;
    const t = new Date(tsRaw);
    const dateLabel = t.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
    const timeLabel = t.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const sevPct = Math.round((s.score || s.severity || 0) * 100);
    const camName = esc(s.cam_name || s.cam_id || '');
    const camActive = _activeCamIds.has(s.cam_id);
    const thumbHtml = camActive
      ? `<img class="ws-card-thumb" loading="lazy" src="/api/weather/sightings/${encodeURIComponent(s.id)}/thumb" alt="${esc(meta.de)}" onerror="this.style.opacity=0.2"/>`
      : `<div class="ws-card-thumb ws-card-thumb--orphan" aria-hidden="true"></div>`;
    return `
      <div class="ws-card${camActive ? '' : ' ws-card--orphan'}" data-idx="${idx}" data-id="${esc(s.id)}">
        <div class="ws-card-thumb-wrap">
          ${thumbHtml}
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
        if (cur) {
          showConfirm('Wetter-Ereignis wirklich löschen?').then(ok => {
            if (!ok) return;
            fetch(`/api/weather/sightings/${encodeURIComponent(cur.id)}`, { method: 'DELETE' })
              .then(() => { closeWeatherLightbox(); loadWeatherSightings(state.weather.filter); });
          });
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
window.addEventListener('hashchange', _handleWeatherHashAnchor);
// Fire once after the initial loadAll() completes.
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(_handleWeatherHashAnchor, 1200);
});


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
// Stage 6 — wire the merge-modal DOM listeners once. camera-merge.js
// owns the open/select/close logic but its event listeners need to
// fire after the static template has rendered (always true since this
// script loads as a module = deferred).
bindMergeModal();
