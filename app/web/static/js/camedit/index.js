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
import { j, apiPost } from '../core/api.js';
import { showToast, showConfirm } from '../core/toast.js';
import { getCameraIcon, getCameraColor } from '../core/icons.js';
import { loadAll } from '../live-update.js';
import { reloadCamera } from '../dashboard.js';
import { panelState, _restoreEditWrapper, _closeEditPanel } from './panel.js';
import {
  RTSP_PATH_OPTS,
  _applyUrlMask,
  _defaultRtspPathForManufacturer,
  _updateRtspErweitertVisuals,
  initRtspBuilder,
  parseRtspUrl,
} from './rtsp.js';
import { setWhitelistState, _updateWhitelistHidden } from './whitelist.js';
import { _refreshCamIdPreview, _bindCamIdPreviewListeners } from './camera_id.js';
import { _loadCamDiagnostics, _refreshConnectionWarn } from './recovery.js';
import {
  _initCameraFormListeners,
  _initErkSliders,
  _renderErkPerClassConfidence,
  _bindErkPerClassToggle,
  _renderErkPerClassConfirm,
  _bindErkConfirmPerClassToggle,
  _bindErkSimulate,
  _renderCamObjectPills,
  getCamObjectFilterState,
  setCamObjectFilterState,
  _renderGlobalStatusRows,
  _renderCamConfirmGrid,
} from './detection.js';
import {
  drawShapes,
  loadMaskSnapshot,
  _renderShapeList,
  _updateShapeDrawingBar,
  restoreShapeMode,
} from '../shape-editor/index.js';
import { _bindCamProbeDeviceInfo } from './discovery.js';
import { _bindReolinkImageMode } from './reolink-imgmode.js';
import {
  _renderSeverityMatrix,
  _checkAlertingConflicts,
  _renderAlertCooldownGrid,
  _bindAlertCooldownToggle,
  _bindAlertTestButton,
  _bindAlertingConflictWatch,
  _renderAlertStatusStrip,
} from '../alerting.js';
import { hydrateErkennungFields } from './hydration/erkennung.js';
import { hydrateAlertingFields } from './hydration/alerting.js';

// Coral pipeline tree + device info + test cam list — direct ES imports
// since R13 dropped the window-bridge thunks that used to wait for
// coral-test.js's load order. Static imports guarantee these are
// callable by the time index.js's module body runs.
import {
  _updateCoralDeviceInfo,
  _renderCoralPipelineTree,
  _populateCoralTestCameras,
} from './coral-test.js';

// Tiny helper used by the export-config buttons in the App-Section.
const download = (url) => window.open(url, '_blank');

// ── Tracking presets ────────────────────────────────────────────────────────
// Three one-click presets fill the four tracker fields (Spawn-Schwelle,
// Fortsetzungs-Schwelle, Gnadenfrist, IoU-Schwelle). Values are chosen
// to bracket the module defaults so a power user can pick the right
// trade-off without reading the docs:
//   "Vorsichtig" — stricter, more likely to spawn fresh ids on dips.
//   "Ausgewogen" — module defaults (post 2026-05 retune); good for
//                  garden-cams with one or two subjects walking past.
//   "Robust"     — looser, holds onto subjects across longer occlusions.
// Pressing a preset writes into the input fields AND auto-persists the
// four track_* values to settings.json. The auto-save uses a partial
// payload (existing cam record spread + 4 overrides) so it touches
// nothing else — the user's other in-progress edits stay live in the
// form, and the regular Speichern still commits them. Without the
// auto-save the preset values disappeared on the next docker restart;
// most users assumed clicking a preset meant the camera was already
// using the new thresholds.
const _TRACK_PRESETS = {
  careful: { spawn: 0.55, cont: 0.3, grace: 4, iou: 0.3 },
  balanced: { spawn: 0.5, cont: 0.2, grace: 6, iou: 0.2 },
  robust: { spawn: 0.45, cont: 0.15, grace: 10, iou: 0.15 },
};

const _TRACK_PRESET_LABELS = {
  careful: 'Vorsichtig',
  balanced: 'Ausgewogen',
  robust: 'Robust',
};

async function _saveTrackingPresetPatch(formEl, presetLabel, fields) {
  const camId = formEl.elements['id']?.value;
  if (!camId) return false;
  // Spread the stored cam record then override the four track_* keys.
  // The backend's `existing.update(camera)` (settings/store.py ja847) is
  // a non-destructive shallow merge, but its conn_changed check in
  // routes/cameras.py compares payload.get(f) != old_cfg.get(f) for
  // _CONN_FIELDS — sending a partial payload missing rtsp_url etc.
  // would compare `undefined != "rtsp://…"` and falsely trigger a
  // runtime restart on every preset click. Spreading the stored record
  // keeps those values identical and skips the restart path. We pull
  // from state.config.cameras (the full persisted dict) and fall back
  // to state.cameras (the live runtime-augmented dict) — same lookup
  // order editCamera() uses to open the panel.
  const stored =
    (state.config?.cameras || []).find((c) => c.id === camId) ||
    (state.cameras || []).find((c) => c.id === camId);
  if (!stored) return false;
  const payload = { ...stored, ...fields };
  try {
    await apiPost('/api/settings/cameras', payload);
    showToast(`Vorlage gespeichert · ${presetLabel}`, 'success');
    // Mutate the in-memory cam record so the next state-read (e.g. a
    // later partial save from another control) sees the new values.
    // A full loadAll() would re-render and likely close the panel,
    // which is the very thing we wanted to avoid.
    Object.assign(stored, fields);
    return true;
  } catch (e) {
    showToast('Vorlage konnte nicht gespeichert werden: ' + (e?.message || e), 'error');
    return false;
  }
}

function _wireTrackingPresets(formEl) {
  if (!formEl || formEl.dataset.tpresetsWired === '1') return;
  formEl.dataset.tpresetsWired = '1';
  const buttons = formEl.querySelectorAll('.erk-track-preset');
  if (!buttons.length) return;
  buttons.forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      const presetKey = btn.dataset.preset;
      const preset = _TRACK_PRESETS[presetKey];
      if (!preset) return;
      const f = formEl.elements;
      const fields = {
        track_spawn_min_score: preset.spawn,
        track_continue_min_score: preset.cont,
        track_miss_grace_seconds: preset.grace,
        track_iou_match_threshold: preset.iou,
      };
      Object.entries(fields).forEach(([name, value]) => {
        const inp = f[name];
        if (inp) {
          inp.value = value;
          // Fire input event so any listeners (e.g. dirty-state
          // tracking, autosave shimmers) update.
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      // Visual feedback — flash the chosen preset, reset after 1 s
      // so the user sees confirmation without a permanent active
      // state.
      buttons.forEach((b) => {
        b.dataset.flash = '0';
      });
      btn.dataset.flash = '1';
      setTimeout(() => {
        btn.dataset.flash = '0';
      }, 900);
      const label = _TRACK_PRESET_LABELS[presetKey] || presetKey;
      await _saveTrackingPresetPatch(formEl, label, fields);
    });
  });
}

export function renderShell() {
  // Hero title is now a static "Squirreling · Sightings" lockup with the squirrel-on-
  // hyphen ornament — no longer driven by config.app.{name,tagline,
  // subtitle}. Side-nav app-name still hydrates if present so users
  // who renamed the app via Settings keep their custom label there.
  const _sideAppName = byId('sideAppName');
  if (_sideAppName) _sideAppName.textContent = state.config.app.name || 'Squirreling · Sightings';
  // Null-guard the legacy hero IDs so a config still containing
  // tagline/subtitle doesn't crash renderShell — they just no-op.
  const nameEl = byId('appName');
  if (nameEl) nameEl.textContent = state.config.app.name || 'Squirreling · Sightings';
  const tagEl = byId('appTagline');
  if (tagEl) tagEl.textContent = state.config.app.tagline || 'Motion · Objekte · Timelapse';
  const subEl = byId('appSubtitle');
  if (subEl)
    subEl.textContent =
      state.config.app.subtitle || 'RTSP-Streams · KI-Erkennung · Vogelarten · Telegram-Alerts';
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
window._flashDetection = function (camId, cls) {
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
  void tgt.offsetWidth; // force reflow so animation restarts
  tgt.classList.add('is-detecting');
  setTimeout(() => tgt.classList.remove('is-detecting'), 3000);
};

// _defaultRtspPathForManufacturer, _updateRtspErweitertVisuals,
// initRtspBuilder, parseRtspUrl all moved together. Inline-onclick
// handlers (_toggleUrlMask, _toggleCamRtspErw) keep their window
// bridges from inside the new module.

window.toggleCameraEnabled = async function (camId, enabled) {
  const cam = (state.cameras || []).find((x) => x.id === camId);
  if (!cam) return;
  await apiPost('/api/settings/cameras', { ...cam, enabled });
  await loadAll();
};
export function renderCameraSettings() {
  byId('cameraSettingsList').innerHTML = state.cameras
    .map((c) => {
      // Merge is offered only for cameras that have been offline for ≥ 10 min
      // straight (frame_age_s is the seconds-since-last-good-frame counter the
      // runtime maintains; null = camera never produced a frame and is also
      // not "abandoned" in the merge sense). Brief disconnects (network blip,
      // camera reboot) keep the button hidden; the moment a camera reconnects
      // and frame_age_s drops back under the threshold, the next render hides
      // the button automatically — no manual dismiss needed.
      const MERGE_OFFLINE_THRESHOLD_S = 600;
      const canMerge =
        typeof c.frame_age_s === 'number' && c.frame_age_s >= MERGE_OFFLINE_THRESHOLD_S;
      // Collapsed Geräte row keeps only the icon+name on the left and the
      // expand chevron on the right. The previous cluster (active toggle,
      // Verbinden button, Zusammenführen, trash) was removed because:
      //   - configured cameras are always treated as active (auto-connect
      //     on boot via rebuild_runtimes); no per-row toggling needed
      //   - manual "Verbinden" duplicates auto-connect
      //   - trash already lives inside the expanded settings (#deleteCameraBtn)
      // canMerge is intentionally unused here now — the merge affordance
      // is reachable from the camera-merge modal flow elsewhere. Keep the
      // data-camid attribute so the bulk re-renderer can locate the row.
      void canMerge;
      return `
    <div class="cam-item" data-camid="${esc(c.id)}">
      <div class="cam-item-head" style="cursor:pointer" onclick="editCamera('${esc(c.id)}')">
        <div class="cam-item-head-left">
          <span class="cam-item-head-icon">${getCameraIcon(c.name)}</span>
          <span class="cam-item-head-name">${esc(c.name)}</span>
        </div>
        <div class="cam-item-head-right">
          <!-- Expand chevron — pure visual cue; the whole row is clickable. -->
          <svg class="cam-item-chevron" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5,3 11,8 5,13"/></svg>
        </div>
      </div>
    </div>`;
    })
    .join('');
}

// ── Camera merge modal ────────────────────────────────────────────────────────
// Now lives in camera-merge.js (Stage 6). bindMergeModal() is called
// once at the bottom of this file to wire its DOM listeners.
window._reconnectCam = function (camId, btn) {
  btn.classList.add('spinning');
  setTimeout(() => btn.classList.remove('spinning'), 520);
  reloadCamera(camId);
};
// Delete-with-confirm — shared between the cam-row trash icon
// (window._quickDeleteCamera) and the in-panel "Kamera löschen"
// button. Both entry points need the SAME confirm dialog and
// success path, so we factor the body into one helper and wire two
// thin callers around it.
async function _deleteCameraWithConfirm(camId, camName) {
  if (
    !(await showConfirm(
      `Kamera "${camName}" wirklich löschen?\n\nDie Kamera wird aus der Konfiguration entfernt. Medien bleiben im Speicher erhalten und erscheinen unter "Archivierte Kameras".`,
    ))
  )
    return;
  try {
    const r = await j(`/api/settings/cameras/${encodeURIComponent(camId)}`, { method: 'DELETE' });
    if (r.event_count > 0)
      showToast(`${r.event_count} gespeicherte Ereignisse bleiben im Archiv erhalten.`, 'warn');
    if (panelState.camId === camId) _restoreEditWrapper();
    await loadAll();
  } catch (_err) {
    showToast('Fehler beim Löschen: ' + (_err.message || _err), 'error');
  }
}
window._quickDeleteCamera = _deleteCameraWithConfirm;
// In-panel "Kamera löschen" button. The form-template puts the
// button in the DOM at boot time (it's static markup), so we bind
// once here. The current camId is stamped onto the button's
// dataset by editCamera(), and the camera name comes from the
// live state lookup so a rename between edit-open and delete-click
// still picks the latest label.
byId('deleteCameraBtn')?.addEventListener('click', () => {
  const btn = byId('deleteCameraBtn');
  const camId = btn?.dataset.camId;
  if (!camId) {
    showToast('Keine Kamera ausgewählt.', 'error');
    return;
  }
  const cam =
    (state.cameras || []).find((c) => c.id === camId) ||
    (state.config?.cameras || []).find((c) => c.id === camId);
  _deleteCameraWithConfirm(camId, cam?.name || camId);
});

function editCamera(camId) {
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
  const c =
    (state.config?.cameras || []).find((x) => x.id === camId) ||
    (state.cameras || []).find((x) => x.id === camId);
  if (!c) {
    // Camera not in current state → drop any half-set lock so the user
    // can retry once loadAll() refreshes state. Without this the lock
    // would stick if a stale camId (post-rename) raced through here.
    panelState.camId = null;
    return; // diagnostic console.error retired — the lock reset above is the real recovery
  }
  // Toggle: clicking same camera closes the panel
  if (panelState.camId === camId) {
    _closeEditPanel();
    return;
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
    const f = formEl.elements;
    f['id'].value = c.id || '';
    f['id'].dataset.autoGen = '0';
    f['name'].value = c.name || '';
    if (f['manufacturer']) f['manufacturer'].value = c.manufacturer || '';
    if (f['model']) f['model'].value = c.model || '';
    // tx412 — the icon-emoji <input> was retired. Icon now derives at
    // render time from getCameraIcon(name). The guard stays in case
    // an external template still mounts an icon field somewhere, but
    // setting its value would re-introduce the "<svg…> as input
    // value" bug and so is silently dropped.
    // B1 · Identity row — colour + avatar tile. The avatar mirrors the
    // dashboard tile + list-item icon (getCameraIcon(name)) and gets
    // tinted via --cam-color on its button parent so the SVG's
    // stroke="currentColor" picks up the active tone. Clicking the
    // avatar forwards .click() to the visually-hidden native colour
    // input. dataset.auto stays load-bearing for the submit path
    // (writes "" when '1' so settings.json never persists the auto-
    // tone hex) and now ALSO drives the visibility of the "↺ auto"
    // reset link beneath the avatar — visible only on manual override.
    const _avatarBtn = byId('camAvatarBtn');
    const _avatarIcon = byId('camAvatarIcon');
    const _resetBtn = byId('camColorReset');
    const _syncAvatar = (color, isAuto) => {
      if (_avatarBtn) _avatarBtn.style.setProperty('--cam-color', color);
      if (_resetBtn) _resetBtn.hidden = !!isAuto;
    };
    const _renderAvatarIcon = (name) => {
      if (_avatarIcon) _avatarIcon.innerHTML = getCameraIcon(name || '');
    };
    if (f['color']) {
      const _autoTone = getCameraColor({ name: c.name || c.id });
      f['color'].value = c.color || _autoTone;
      f['color'].dataset.auto = c.color ? '0' : '1';
      _renderAvatarIcon(c.name || c.id);
      _syncAvatar(f['color'].value, f['color'].dataset.auto === '1');
      f['color'].oninput = () => {
        f['color'].dataset.auto = '0';
        _syncAvatar(f['color'].value, false);
      };
    }
    if (_avatarBtn && f['color']) {
      _avatarBtn.onclick = (e) => {
        e.preventDefault();
        f['color'].click();
      };
    }
    if (_resetBtn) {
      _resetBtn.onclick = () => {
        if (!f['color']) return;
        const _autoTone = getCameraColor({ name: f['name']?.value || c.name || c.id });
        f['color'].value = _autoTone;
        f['color'].dataset.auto = '1';
        _syncAvatar(_autoTone, true);
      };
    }
    // Live-track display-name edits so the avatar icon + auto-tone
    // follow what the user is typing. dataset.auto === '1' is the
    // signal that the colour should track the name's auto-tone too;
    // a manual override stays put.
    if (f['name']) {
      f['name'].addEventListener('input', () => {
        const _n = f['name'].value || c.name || c.id;
        _renderAvatarIcon(_n);
        if (f['color'] && f['color'].dataset.auto === '1') {
          const _autoTone = getCameraColor({ name: _n });
          f['color'].value = _autoTone;
          _syncAvatar(_autoTone, true);
        }
      });
    }
    // Live preview of the canonical id derived from manufacturer/model/name/IP.
    _bindCamIdPreviewListeners();
    // Reolink GetDevInfo rescan button — wires once per session.
    _bindCamProbeDeviceInfo();
    // Reolink image-mode test panel — also wires once; visibility flips
    // live on manufacturer-field edits.
    _bindReolinkImageMode();
    // Reset the auto-detected hints — a fresh open should not retain a
    // hint left over from a previous session's save.
    byId('cameraForm')
      ?.querySelectorAll('.cam-autodetected-hint')
      .forEach((el) => {
        el.hidden = true;
      });
    byId('cameraEditTitle').textContent = `Kamera bearbeiten · ${c.name || c.id}`;
    const p = parseRtspUrl(c.rtsp_url || '');
    f['rtsp_ip'].value = p.host || '';
    f['rtsp_user'].value = p.user || '';
    f['rtsp_pass'].value = p.pass || '';
    f['rtsp_port'].value = p.port || '554';
    if (f['reolink_http_port']) f['reolink_http_port'].value = c.reolink_http_port || '';
    const matchedPath = RTSP_PATH_OPTS.find((o) => o.value === p.path);
    if (f['rtsp_path']) {
      const def = _defaultRtspPathForManufacturer(c.manufacturer || '');
      // Existing cam with a path → use it; fresh cam with no path → fall
      // back to the manufacturer-derived default so manual='0' from the
      // start instead of flagging the legacy RTSP_PATH_OPTS[0] as custom.
      f['rtsp_path'].value = matchedPath ? matchedPath.value : def;
      f['rtsp_path'].dataset.manual = f['rtsp_path'].value !== def ? '1' : '0';
      _updateRtspErweitertVisuals();
    }
    f['rtsp_url'].value = c.rtsp_url || '';
    f['snapshot_url'].value = c.snapshot_url || '';
    // Apply password masking to the URL display fields. Eye toggle reveals.
    delete f['rtsp_url'].dataset.real;
    delete f['snapshot_url'].dataset.real;
    _applyUrlMask(f['rtsp_url']);
    _applyUrlMask(f['snapshot_url']);
    // Reset eye buttons to masked-state icon
    byId('cameraForm')
      .querySelectorAll('.url-eye')
      .forEach((b) => {
        b.classList.remove('revealed');
        b.textContent = '👁';
      });
    // Telegram/MQTT toggles are populated in the Alerting-tab hydration
    // block below alongside the severity matrix and channel switches.
    // Populate global status rows on the Erkennung tab
    _renderGlobalStatusRows();
    // Object filter is now rendered as a pill bar; keep the hidden input in
    // sync so the existing save flow (reads from f['object_filter'].value)
    // still works unchanged.
    setCamObjectFilterState(c.object_filter || ['person', 'cat', 'bird']);
    f['object_filter'].value = getCamObjectFilterState().join(',');
    _renderCamObjectPills();
    // Legacy alarm_profile is now a hidden bridge field — the source of
    // truth is the per-class severity matrix. Carry the camera's stored
    // alarm_profile through the form so back-end code that still reads
    // it on save keeps working until the cutover commit.
    if (f['alarm_profile']) f['alarm_profile'].value = c.alarm_profile || 'soft';
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
    // N17 · alerting-tab fields (schedule_notify/_record + channel toggles)
    // moved to hydration/alerting.js.
    hydrateAlertingFields(formEl, c);
    // N17 · all Erkennung-tab field hydration lives in hydration/erkennung.js
    hydrateErkennungFields(formEl, c, state);
    _wireTrackingPresets(formEl);
    // Legacy per-class grid is no longer rendered as visible UI but the
    // function is null-safe (returns early when #camConfirmGrid is hidden
    // via [hidden]). Phase 2 reactivates the drilldown.
    _renderCamConfirmGrid(c);
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
    setWhitelistState(c.whitelist_names || []);
    _updateWhitelistHidden();
    shapeState.camera = camId;
    shapeState.zones = JSON.parse(JSON.stringify(c.zones || []));
    shapeState.masks = JSON.parse(JSON.stringify(c.masks || []));
    shapeState.points = [];
    shapeState.pulse = null;
    f['zones_json'].value = JSON.stringify(shapeState.zones);
    f['masks_json'].value = JSON.stringify(shapeState.masks);
    // Reapply the persisted zone/mask mode so reopening the tab feels
    // consistent. Reads localStorage `tamspy.shapeMode`; defaults to
    // 'zone' on first visit. Implicitly calls drawShapes() +
    // _updateShapeDrawingBar() so we don't double-fire below.
    restoreShapeMode();
    // Keep the polygon list in sync with the loaded shapes.
    _renderShapeList();
    byId('deleteCameraBtn').dataset.camId = camId;
    loadMaskSnapshot(camId);
    drawShapes();
    // Slide down inside the clicked camera card.
    const camRow = byId('cameraSettingsList')?.querySelector(`[data-camid="${camId}"]`);
    const wrapper = byId('cameraEditWrapper');
    if (camRow) {
      camRow.appendChild(wrapper);
      camRow.classList.add('editing');
      // Move the recovery button out of the tab bar and into the
      // cam-item header (left of the chevron). On iPhone widths the
      // tab list is horizontally scrollable; with the button parked
      // there it overlapped the tabs. Keeping the same DOM node (vs
      // duplicating markup) preserves the JS that drives its
      // .is-warn / .is-pulsing state.
      const recBtn = document.getElementById('camTabRecoveryBtn');
      const headRight = camRow.querySelector('.cam-item-head-right');
      const chevron = headRight && headRight.querySelector('.cam-item-chevron');
      if (recBtn && headRight && chevron) headRight.insertBefore(recBtn, chevron);
    }
    requestAnimationFrame(() => wrapper?.classList.add('slide-open'));
    panelState.camId = camId;
    setTimeout(() => wrapper.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 120);
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
  } catch (e) {
    // Any hydration helper threw — restore the lock to a clean state
    // so the next click can re-attempt without the toggle-close branch
    // mistakenly firing on the stale panelState.camId. Surface the
    // failure to the user via toast so they know to retry; rethrow so
    // the original stack remains visible in DevTools for diagnosis.
    panelState.camId = null;
    _restoreEditWrapper();
    showToast('Kamera-Bearbeitung konnte nicht öffnen — bitte erneut versuchen', 'warn');
    throw e;
  }
}

export async function renderProfiles() {
  const cats = await j('/api/cats');
  const persons = await j('/api/persons');
  const catEl = byId('catList');
  const perEl = byId('personList');
  if (catEl)
    catEl.innerHTML =
      cats.profiles
        .map((p) => `<div style="padding:3px 0;font-size:13px">${esc(p.name)}</div>`)
        .join('') || '<span class="muted small">—</span>';
  if (perEl)
    perEl.innerHTML =
      persons.profiles
        .map(
          (p) =>
            `<div style="padding:3px 0;font-size:13px">${esc(p.name)}${p.whitelisted ? ' <span class="muted small">(Whitelist)</span>' : ''}</div>`,
        )
        .join('') || '<span class="muted small">—</span>';
}
export async function renderAudit() {
  const actions = await j('/api/telegram/actions');
  byId('auditPanel').innerHTML =
    actions.items
      .map(
        (a) =>
          `<div class="audit-item"><strong>${esc(a.action)}</strong><div class="small">${esc(a.time)}${a.camera_id ? ` · ${esc(a.camera_id)}` : ''}</div></div>`,
      )
      .join('') || '<div class="audit-item">Noch keine Telegram-Aktionen.</div>';
}

async function toggleArm(camId, armed) {
  await apiPost(`/api/camera/${camId}/arm`, { armed });
  await loadAll();
}
window.toggleArm = toggleArm;
// _cvCardClick now lives in dashboard.js (Stage 3b). Its window

export function hydrateSettings() {
  const mqtt = state.config.mqtt || {};
  const proc = state.config.processing || {},
    coral = state.config.coral || {};
  // App section — Public Base URL + Discovery-Subnet now render read-only
  // inside updateSystemPanel(); no inputs to hydrate here.
  updateSystemPanel();
  // MQTT section
  const mqttEn = byId('mqtt_enabled');
  if (mqttEn) mqttEn.checked = !!mqtt.enabled;
  const mqttH = byId('mqtt_host');
  if (mqttH) mqttH.value = mqtt.host || '';
  const mqttP = byId('mqtt_port');
  if (mqttP) mqttP.value = mqtt.port || 1883;
  const mqttU = byId('mqtt_username');
  if (mqttU) mqttU.value = mqtt.username || '';
  const mqttPw = byId('mqtt_password');
  if (mqttPw) mqttPw.value = mqtt.password || '';
  const mqttT = byId('mqtt_base_topic');
  if (mqttT) mqttT.value = mqtt.base_topic || 'tam-spy';
  // MQTT badge
  const mqttBadge = byId('mqttStatusBadge');
  if (mqttBadge) {
    mqttBadge.textContent = mqtt.enabled ? 'aktiv' : 'aus';
    mqttBadge.className =
      'set-status-badge ' + (mqtt.enabled ? 'set-status-badge--on' : 'set-status-badge--off');
  }
  // Coral section — unified .switch toggles (checkbox-driven)
  const coralActive = !!(proc.coral_enabled ?? coral.mode === 'coral');
  const birdActive = !!(proc.bird_species_enabled ?? coral.bird_species_enabled);
  const wildlifeActive = !!proc.wildlife_enabled;
  const coralInp = byId('coralTpuEnabled');
  if (coralInp) coralInp.checked = coralActive;
  const birdInp = byId('birdSpeciesEnabled');
  if (birdInp) birdInp.checked = birdActive;
  const wildInp = byId('wildlifeEnabled');
  if (wildInp) wildInp.checked = wildlifeActive;
  // Wildlife toggle stays fully interactive even when the model file is
  // missing — the warning beneath the row tells the user what's wrong;
  // we never want to gate the checkbox itself.
  const wildRow = byId('wildlifeEnabledRow');
  if (wildRow) {
    wildRow.classList.remove('toggle-row--disabled');
  }
  if (wildInp) wildInp.disabled = false;
  const cam0 = state.cameras[0];
  const coralAvail = !!cam0?.coral_available;
  const detMode = cam0?.detection_mode || null;
  const chip = byId('coralStatusChip');
  if (chip) {
    // Four states. CPU fallback is now orange (warn-orange) instead of
    // the prior yellow — green/yellow/grey was visually too soft for what
    // is in practice a degraded mode the user should notice.
    let label = 'aus',
      cls = 'set-status-badge--off';
    if (coralActive) {
      if (detMode === 'coral' && coralAvail) {
        label = 'Coral TPU aktiv';
        cls = 'set-status-badge--on';
      } else if (detMode === 'cpu') {
        label = '⚠ CPU-Fallback aktiv';
        cls = 'set-status-badge--warn-orange';
      } else {
        label = '✗ KI nicht verfügbar';
        cls = 'set-status-badge--off';
      }
    } else {
      label = 'KI-Objekterkennung aus';
    }
    chip.textContent = label;
    chip.className = 'set-status-badge ' + cls;
  }
  const hint = byId('coralStatusHint');
  if (hint) {
    const reason = cam0?.coral_reason || '—';
    // Happy-path "Coral TPU erkannt und aktiv" line was a duplicate of the
    // status chip in the section header — only WARNING/ERROR lines stay.
    const lines = [];
    if (!coralAvail && coralActive) {
      lines.push(`💻 CPU Fallback aktiv (${esc(reason)})`);
    } else if (!coralActive) {
      lines.push('⏸ Erkennung deaktiviert');
    }
    if (birdActive && proc.bird_model_available === false) {
      const p = proc.bird_model_path || 'inat_bird_quant.tflite';
      lines.push(
        `⚠️ Vogelarten-Modell nicht gefunden. Bitte <code>${esc(p.split('/').pop())}</code> in <code>models/</code> ablegen.`,
      );
    } else if (birdActive && cam0?.bird_species_available === false && cam0?.bird_species_reason) {
      lines.push(`⚠️ Vogelarten-Klassifikation: ${esc(cam0.bird_species_reason)}`);
    }
    // Warn whenever the model is missing, even if the user hasn't enabled
    // wildlife yet — the missing-file hint is what tells them WHY enabling
    // does nothing useful right now.
    if (proc.wildlife_model_available === false) {
      const p = proc.wildlife_model_path || 'mobilenet_v2_1.0_224_quant.tflite';
      lines.push(
        `⚠️ Modell nicht gefunden: <code>${esc(p.split('/').pop())}</code> — bitte in <code>models/</code> ablegen.`,
      );
    }
    hint.innerHTML = lines.join('<br>');
    hint.style.display = lines.length ? '' : 'none';
  }
  // Coral device info from /api/system (async, non-blocking)
  _updateCoralDeviceInfo();
  _renderCoralPipelineTree();
  _populateCoralTestCameras();
  // Models list is now behind the Modelle sub-tab; load it lazily on
  // first open via toggleCoralTab, so hydrate doesn't spin up a request
  // users aren't looking at.
  // Hydrate media settings form
  const storageSec = state.config.storage || {};
  const rdVal = storageSec.retention_days || 14;
  const rdEl = byId('ms_retention_days');
  if (rdEl) rdEl.value = rdVal;
  const rdLbl = byId('ms_retention_days_val');
  if (rdLbl) rdLbl.textContent = rdVal + ' Tage';
  const acEl = byId('ms_auto_cleanup');
  if (acEl) acEl.checked = !!storageSec.auto_cleanup_enabled;
}

async function updateSystemPanel() {
  const panel = byId('systemInfoPanel');
  if (!panel) return;
  const storagePath = state.config?.storage?.root || 'storage/';
  try {
    const s = await j('/api/system');
    const b = s.build || {};
    const commit = b.commit || 'dev';
    const date = b.date || '—';
    const count = b.count || '—';
    // Letzter Neustart — the Flask process start time, NOT the build date.
    let restartShort = '—';
    if (s.process_start) {
      try {
        const d = new Date(s.process_start);
        const pad = (n) => String(n).padStart(2, '0');
        restartShort = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      } catch {}
    }
    const heroEl = byId('heroBuildInfo');
    if (heroEl) {
      const url = 'https://github.com/premiumcola/cam-manager/commits/main/';
      const shortCommit = commit.length > 7 ? commit.slice(0, 7) : commit;
      const countPart =
        b.count && b.count !== '—'
          ? `<a href="${url}" target="_blank" class="hero-build-count">Build #${esc(String(b.count))}</a>`
          : `<span class="hero-build-count hero-build-count--dev">Build · dev</span>`;
      const commitPart = `<code class="hero-build-commit" title="Git commit">${esc(shortCommit)}</code>`;
      const restartPart = s.process_start
        ? `<span class="hero-build-date" title="Letzter Neustart: ${esc(s.process_start)}">⟳ ${esc(restartShort)}</span>`
        : '';
      heroEl.innerHTML = `${countPart}<span class="hero-build-sep">·</span>${commitPart}${restartPart ? `<span class="hero-build-sep">·</span>${restartPart}` : ''}`;
    }
    const memUsed = s.mem_used_mb || 0;
    const memTotal = s.mem_total_mb || 0;
    const procMem = s.proc_mem_mb || 0;
    const uptime = s.uptime_s || 0;
    const uptimeStr =
      uptime > 3600
        ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
        : uptime > 60
          ? `${Math.floor(uptime / 60)}m`
          : `${Math.round(uptime)}s`;
    const shortCommit = commit.length > 7 ? commit.slice(0, 7) : commit;
    const publicUrl = state.config?.server?.public_base_url || '';
    const subnet = state.config?.default_discovery_subnet || '';
    panel.innerHTML = `
      <div class="app-info-block">
        <div class="app-info-section-title">Build &amp; System</div>
        <div class="app-info-row"><span class="app-info-row-label">Build</span><span class="app-info-row-val"><code>${esc(shortCommit)}</code> · ${esc(date)}</span></div>
        <div class="app-info-row"><span class="app-info-row-label">Commits</span><span class="app-info-row-val">${esc(String(count))}</span></div>
        ${s.process_start ? `<div class="app-info-row"><span class="app-info-row-label">Letzter Neustart</span><span class="app-info-row-val" title="${esc(s.process_start)}">${esc(restartShort)}</span></div>` : ''}
        ${uptime ? `<div class="app-info-row"><span class="app-info-row-label">Container-Uptime</span><span class="app-info-row-val">${uptimeStr}</span></div>` : ''}
        ${s.camera_count !== undefined ? `<div class="app-info-row"><span class="app-info-row-label">Aktive Kameras</span><span class="app-info-row-val">${s.camera_count}</span></div>` : ''}

        <div class="app-info-section-title">Ressourcen</div>
        ${procMem ? `<div class="app-info-row"><span class="app-info-row-label">RAM (App)</span><span class="app-info-row-val">${procMem} MB</span></div>` : ''}
        ${memTotal ? `<div class="app-info-row"><span class="app-info-row-label">RAM (System)</span><span class="app-info-row-val">${memUsed} / ${memTotal} MB</span></div>` : ''}
        <div class="app-info-row"><span class="app-info-row-label">Storage</span><span class="app-info-row-val"><code>${esc(storagePath)}</code></span></div>

        <div class="app-info-section-title">Netzwerk</div>
        <div class="app-info-row"><span class="app-info-row-label">Public Base URL</span><span class="app-info-row-val">${publicUrl ? `<code>${esc(publicUrl)}</code>` : '—'}</span></div>
        <div class="app-info-row"><span class="app-info-row-label">Discovery-Subnet</span><span class="app-info-row-val">${subnet ? `<code>${esc(subnet)}</code>` : '—'}</span></div>
      </div>`;
  } catch (_err) {
    /* silent — system info optional */
  }
}

function initCameraEditTabs() {
  const bar = document.querySelector('.cam-tab-bar');
  if (!bar) return;
  // Reset to first tab
  bar.querySelectorAll('.cam-tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.cam-tab-panel').forEach((p) => p.classList.remove('active'));
  const first = bar.querySelector('.cam-tab-btn[data-tab="cam-tab-allgemein"]');
  if (first) first.classList.add('active');
  const firstPanel = byId('cam-tab-allgemein');
  if (firstPanel) firstPanel.classList.add('active');
  bar.querySelectorAll('.cam-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      bar.querySelectorAll('.cam-tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.cam-tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = byId(btn.dataset.tab);
      if (panel) panel.classList.add('active');
    });
  });
}

byId('reloadConfigBtn').onclick = () => loadAll();

byId('closeCameraEdit')?.addEventListener('click', () => _closeEditPanel());
window.saveMqttSettings = async function () {
  const existingPass = state.config?.mqtt?.password || '';
  const payload = {
    mqtt: {
      enabled: byId('mqtt_enabled')?.checked || false,
      host: byId('mqtt_host')?.value || '',
      port: Number(byId('mqtt_port')?.value || 1883),
      username: byId('mqtt_username')?.value || '',
      password: byId('mqtt_password')?.value || existingPass,
      base_topic: byId('mqtt_base_topic')?.value || 'tam-spy',
    },
  };
  await apiPost('/api/settings/app', payload);
  showToast('MQTT gespeichert · Verbindungen werden neu gestartet.', 'success');
  await loadAll();
};
// Camera-card placeholder rendering moved with the dashboard module

byId('exportJsonBtn').onclick = () => download('/api/settings/export?format=json');
byId('exportYamlBtn').onclick = () => download('/api/settings/export?format=yaml');
byId('clearImportBtn').onclick = () => {
  byId('importBox').value = '';
};
byId('importJsonBtn').onclick = async () => {
  await importConfig('json');
};
byId('importYamlBtn').onclick = async () => {
  await importConfig('yaml');
};
async function importConfig(format) {
  const content = byId('importBox').value.trim();
  if (!content) {
    showToast('Bitte Inhalt einfügen.', 'warn');
    return;
  }
  await j('/api/settings/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format, content }),
  });
  byId('importBox').value = '';
  await loadAll();
  showToast('Import erfolgreich.', 'success');
}

// ── Inline-onclick bridges (template + JS-rendered HTML handlers) ──────────
// Only names read by `onclick="..."` strings (template-side or
// rendered into innerHTML by other modules) survive here. Every other
// bridge dropped in R13 — direct ES imports replaced them.
//
// editCamera               — onclick on cam-rows in renderCameraSettings()
// toggleCameraEnabled      — onchange on the cam-row enable switch
// _reconnectCam            — onclick on the cam-row "Verbinden" button
// _quickDeleteCamera       — onclick on the cam-row delete button
// _flashDetection          — debug entry-point (DevTools / future SSE bridge)
// toggleArm                — assigned next to its definition higher up
// saveMqttSettings         — onclick="saveMqttSettings()" in settings.html
window.editCamera = editCamera;
