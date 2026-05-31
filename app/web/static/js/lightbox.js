// ─── lightbox.js ───────────────────────────────────────────────────────────
// Stage 4 + Stage 23 of the legacy.js → ES modules refactor.
//
// Stage 4 lifted the pure DOM helpers (_LB_* constants, _updateLbConfirmBtn,
// _lbClearDetections, _lbResetToPhoto, _lbShowError) — those live below.
// Stage 23 grew this module to own the cross-domain orchestration too:
//   * openLightbox / closeLightbox + photo/video player switch
//   * openTLPlayer / _tlNavItems / _tlPeriodLabel for timelapse playback
//   * _lbHandleDeleteKey / _lbNavList / _lbShowSeekOverlay / _renderLbLabels
//   * the document keydown handler (Esc / arrow keys / 'd' / space / 'f')
//   * lightbox prev/next/close button wiring + the touchstart swipe handler
//   * confirm + delete button onclicks (motion + timelapse paths)
//   * the resize listener that re-paginates the grid on viewport changes
//   * one-time runtime init lines (_updateLbConfirmBtn, lightboxDelete glyph,
//     fullscreen-button binding, swipe handler IIFE)
//
// All window.openLightbox / window.closeLightbox / window.openTLPlayer
// bridges still live on the legacy.js side so router.js + inline onclicks
// + still-resident callers keep resolving until those domains migrate.
import { byId, esc } from './core/dom.js';
import { state, IS_IOS } from './core/state.js';
import { j } from './core/api.js';
import { showToast } from './core/toast.js';
import { colors, OBJ_LABEL, OBJ_SVG, TL_LABELS, objBubble } from './core/icons.js';
import { lbState } from './mediathek/state.js';
import {
  lbLoadTracksForItem,
  lbStopTrackingPlayback,
  lbRenderTrackTimeline,
  lbClearTrackTimeline,
  setBboxOverlayVisibility,
} from './mediathek/bbox-overlay/index.js';
import { openMediaView } from './mediaview/index.js';
import { mountRecordedPanels } from './mediaview/panels/orchestration.js';
import {
  mountZoneOverlayForLightbox,
  unmountZoneOverlayForLightbox,
} from './mediaview/canvas/zone-overlay-mount.js';
import { mountWeatherToggleBar } from './mediaview/overlay-toggles.js';
import { renderStatusLegend } from './mediaview/status-legend.js';
import { mountReindexButton } from './mediathek/bbox-overlay/reindex-button.js';
import { _iosNativeVideoOpen } from './mediathek/ios-video.js';
import { closeLiveView } from './chrome/live-view.js';
import { _initFsBtn } from './chrome/fullscreen.js';
import { refreshTimelineAndStats } from './chrome/storage-stats.js';
import {
  calcItemsPerPage,
  renderMediaGrid,
  renderMediaPagination,
  closeMediaDrilldown,
} from './mediathek/orchestration.js';

// ── Stage-4 pure helpers ────────────────────────────────────────────────────
// N16 · moved to mediaview/panels/lb-helpers.js. Re-exported here so
// existing imports from '../lightbox.js' keep resolving.
export {
  _LB_CHECK_SVG,
  _LB_CHECK2_SVG,
  _LB_HINT,
  _LB_TRASH_HTML,
  _updateLbConfirmBtn,
  _lbClearDetections,
  _lbResetToPhoto,
} from './mediaview/panels/lb-helpers.js';
import {
  _LB_TRASH_HTML,
  _updateLbConfirmBtn,
  _lbClearDetections,
  _lbResetToPhoto,
} from './mediaview/panels/lb-helpers.js';

// ── Full-screen video chrome (Stage 30) ─────────────────────────────────────
// openLightbox routes video items (motion clips + timelapses) through a
// dedicated full-screen layout: top bar with cam / ts / actions, video
// region, bottom panel with custom scrubber + per-class track timeline.
// The chrome is a class-toggle on #lightboxModal; the action buttons
// are physically relocated into the top bar so they sit naturally in a
// flex row instead of needing a parallel set of absolute-positioned
// rules.

// Returns true for any item whose lightbox should render in full-screen
// video mode — motion clips with video_relpath / video_url AND
// timelapses (which always have a video).
export function _isFullscreenVideoItem(item) {
  if (!item) return false;
  if (item.type === 'timelapse') return true;
  return !!(item.video_relpath || item.video_url);
}

// Scrubber + play-button + cursor wiring lives in
// mediathek/bbox-overlay.js now — that module owns the bottom-stack
// rendering, so co-locating the handlers there keeps the element-id
// lookups + DOM bindings in one place.

// Move the action buttons (Confirm, Delete, Close) into the top bar in
// the order [Confirm, Delete, Close] so X is the rightmost item.
// Photo events get the buttons restored back to their original parent
// (the media wrap) by _teardownVideoChrome.
function _relocateActionsTo(parentId) {
  const parent = byId(parentId);
  if (!parent) return;
  ['lightboxConfirm', 'lightboxDelete', 'lightboxClose'].forEach((id) => {
    const el = byId(id);
    if (el && el.parentNode !== parent) parent.appendChild(el);
  });
}

// Apply the full-screen video chrome for `item`. Idempotent — calling
// it twice in a row leaves the DOM in the same state.
// "2026-05-10T21:10:26" → "10.05.2026 · 21:10:26". Falls back to the
// raw string when parsing fails so a malformed timestamp still shows
// _something_ instead of an empty bar.
function _fmtVideoTimeDE(raw) {
  if (!raw) return '';
  const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return String(raw);
  const [, y, mo, d, h, mi, s] = m;
  const time = s ? `${h}:${mi}:${s}` : `${h}:${mi}`;
  return `${d}.${mo}.${y} · ${time}`;
}

// Exported (was: file-local) so mediaview/live-detect.js can reuse
// the SAME chrome the recorded path produces — top bar, action-button
// relocation, scrubber+swimlane mount, panel-tabs strip, fold. Live
// mode passes a synthetic item; the recorded path is unchanged.
export function _setupVideoChrome(item) {
  const modal = byId('lightboxModal');
  if (!modal) return;
  modal.classList.add('lb-fs-video');
  // Top bar text — camera display name (falls back to camera_id only
  // when the event JSON predates the camera_name field) + a formatted
  // German timestamp. The raw ISO never reaches the UI.
  const camEl = byId('lightboxTopCam');
  const tsEl = byId('lightboxTopTime');
  if (camEl) camEl.textContent = item?.camera_name || item?.camera_id || '';
  if (tsEl) tsEl.textContent = _fmtVideoTimeDE(item?.time || '');
  byId('lightboxTopBar').hidden = false;
  // Move the action buttons into the top bar.
  _relocateActionsTo('lightboxTopActions');
  // bbox-overlay.js owns the entire bottom-stack rendering (sidebar
  // play button + class badges + tick spacer; time column scrubber
  // bar + class strips + tick row + play cursor). Call it here so
  // the chrome populates even before tracks.json lands; tracks-fetch
  // will re-render when the worker responds.
  lbRenderTrackTimeline(item);
  // mediaview-shell mount: wraps the legacy settings renderer in a
  // dark tab strip ("Aufnahme-Settings" · "Nach-Erkennung" + Wetter
  // when present) and adds the fine-analysis fold below. The
  // settings tab still calls lbRenderSettingsPanel under the hood,
  // just into the tab's body host instead of #lightboxSettings.
  // Timelapses never reach this branch — openLightbox routes them
  // to openTLPlayer before _lbLegacyRender runs.
  const setHost = byId('lightboxSettings');
  if (setHost) setHost.hidden = false;
  mountRecordedPanels(item);
  // Read-only zone + mask overlay — green inclusion polygons + red
  // exclusion polygons, sourced from the camera's settings. Timelapse
  // playback hides masks (sped-up overview gets visually cluttered);
  // motion clips show both. ResizeObserver inside the helper keeps
  // the polygons aligned with the video element through every
  // layout change (fullscreen enter/exit, address-bar collapse).
  mountZoneOverlayForLightbox(item, { hideMasks: item?.type === 'timelapse' });
  // Overlay-toggles pill bar — Mediathek motion clips get all four
  // pills (bboxes/trails/zones/masks), weather timelapses get just
  // zones+masks. Each pill flips its corresponding layer's visibility
  // live on the current viewport — zones/masks reach into the zone
  // overlay, bboxes/trails reach into the bbox-overlay renderer.
  const _toggleHandle = mountWeatherToggleBar(item, (id, on, _all) => {
    if (id === 'zones' || id === 'masks') {
      window._setZoneOverlayVisibility?.({
        showZones: id === 'zones' ? on : undefined,
        showMasks: id === 'masks' ? on : undefined,
      });
    } else if (id === 'bboxes') {
      setBboxOverlayVisibility({ showBboxes: on });
    } else if (id === 'trails') {
      setBboxOverlayVisibility({ showTrails: on });
    }
  });
  // Regenerate-tracking action — sits next to the Masken pill so the
  // operator can re-run the post-clip tracker without paging into a
  // tab (the retired Nach-Erkennung tab's only purpose).
  if (item.type !== 'timelapse') {
    mountReindexButton('mvLiveToggles');
  }
  // Status legend — appended to the toggle row so the same band
  // explains both "what layers are on" and "what each track stroke
  // style means". The ONE shared legend (mediaview/status-legend.js)
  // serves recorded + weather + live; popover handles mobile collapse.
  renderStatusLegend('mvLiveToggles');
  // Sync ALL four layers' initial visibility to whatever the toggle
  // bar resolved (persisted localStorage values for bboxes/trails;
  // declared defaults for zones/masks). Without this the layer
  // renderers' own defaults could diverge from a remembered
  // "user turned X off last time" preference.
  const _initial = _toggleHandle?.getState?.() || {};
  if ('zones' in _initial || 'masks' in _initial) {
    window._setZoneOverlayVisibility?.({
      showZones: !!_initial.zones,
      showMasks: !!_initial.masks,
    });
  }
  if ('bboxes' in _initial || 'trails' in _initial) {
    setBboxOverlayVisibility({
      showBboxes: !!_initial.bboxes,
      showTrails: !!_initial.trails,
    });
  }
}

// Reverse _setupVideoChrome — called when navigating to a photo or
// closing the lightbox entirely. Exported so mediaview/recorded-mode.js
// can drive the same teardown the recorded open path needs.
export function _teardownVideoChrome() {
  const modal = byId('lightboxModal');
  if (!modal) return;
  modal.classList.remove('lb-fs-video');
  byId('lightboxTopBar').hidden = true;
  const setHost = byId('lightboxSettings');
  if (setHost) {
    setHost.hidden = true;
    setHost.innerHTML = '';
  }
  lbClearTrackTimeline();
  // Tear down the overlay-toggles bar so a subsequent photo-event
  // open doesn't show a stale "Bboxes / Trails / …" row.
  const togRow = byId('mvLiveToggles');
  if (togRow) togRow.remove();
  // Buttons return to the media wrap so the photo branch's existing
  // absolute-positioned CSS rules apply.
  _relocateActionsTo('lightboxMediaWrap');
}

// Show an error banner inside the lightbox media wrap (e.g. "Video
// nicht verfügbar", "Video wird verarbeitet…"). Hides the underlying
// img/video elements so the banner reads on a clean dark backdrop.
// Banner is created lazily on first call and reused thereafter.
export function _lbShowError(text) {
  let errEl = byId('lightboxErrorMsg');
  if (!errEl) {
    errEl = document.createElement('div');
    errEl.id = 'lightboxErrorMsg';
    errEl.style.cssText =
      'align-items:center;justify-content:center;width:100%;min-height:240px;max-height:80vh;color:rgba(255,255,255,.55);font-size:15px;font-weight:500;background:#080510;border-radius:18px';
    const wrap = byId('lightboxMediaWrap');
    if (wrap) wrap.appendChild(errEl);
  }
  errEl.textContent = text;
  errEl.style.display = 'flex';
  const imgEl = byId('lightboxImg');
  if (imgEl) imgEl.style.display = 'none';
  const videoEl = byId('lightboxVideo');
  if (videoEl) {
    videoEl.style.display = 'none';
    videoEl.pause();
    videoEl.src = '';
  }
}

// Render a clean error state for a broken event (video file gone,
// API 404, etc.) — clears the playbar/swimlanes from the previous
// clip so the user doesn't see stale chrome bleed through, and
// surfaces actionable buttons. "Nächste anzeigen" skip-traverses
// through unavailable neighbours (loop guard: max 5 attempts).
// "Schließen" just closes. Wetter tab content stays addressable
// because the event metadata is still valid — only the video
// file is gone.
export function resetLightboxToErrorState(msg) {
  // Clear playbar/swimlanes/scrubber so the previous clip's chrome
  // doesn't leak through.
  try {
    lbClearTrackTimeline();
  } catch {
    /* ignore */
  }
  // Replace the panel-tabs body so Nach-Erkennung disappears and the
  // operator can't fire a rescan against a missing video. Wetter +
  // Settings tabs the user opened previously stay accessible — they
  // re-mount on the next valid event.
  const setHost = byId('lightboxSettings');
  if (setHost) {
    setHost.innerHTML = `
      <div class="mv-broken-event">
        <div class="mv-broken-event-title">Diese Aufnahme ist nicht mehr verfügbar</div>
        <div class="mv-broken-event-msg">${esc(msg || 'Video-Datei fehlt oder Event wurde entfernt.')}</div>
        <div class="mv-broken-event-actions">
          <button type="button" class="mv-broken-event-next">→ Nächste anzeigen</button>
          <button type="button" class="mv-broken-event-close">✕ Schließen</button>
        </div>
      </div>`;
    setHost.hidden = false;
    setHost
      .querySelector('.mv-broken-event-next')
      ?.addEventListener('click', () => _lbSkipToValidNeighbour(+1));
    setHost
      .querySelector('.mv-broken-event-close')
      ?.addEventListener('click', () => closeLightbox());
  }
  _lbShowError(msg || 'Diese Aufnahme ist nicht mehr verfügbar.');
}

// Try to navigate to a valid neighbour by stepping `dir` (-1 prev,
// +1 next) up to MAX_HOPS times. A neighbour counts as "valid" when
// it carries either a video_relpath or a video_url — anything less
// hits the same broken-state path. If we run out of neighbours,
// surface the muted "Keine weiteren Aufnahmen verfügbar" note.
const _LB_SKIP_MAX_HOPS = 5;
function _lbSkipToValidNeighbour(dir) {
  const nav = _lbNavList();
  const startIdx = nav.findIndex((x) => x.event_id === lbState.item?.event_id);
  if (startIdx < 0) {
    closeLightbox();
    return;
  }
  for (let hop = 1; hop <= _LB_SKIP_MAX_HOPS; hop++) {
    const idx = startIdx + dir * hop;
    if (idx < 0 || idx >= nav.length) break;
    const candidate = nav[idx];
    if (candidate && (candidate.video_relpath || candidate.video_url)) {
      openLightbox(candidate);
      return;
    }
  }
  // Out of valid neighbours in this direction — soften the error
  // state with a muted note so the user knows there's nothing left.
  const setHost = byId('lightboxSettings');
  if (setHost) {
    const note = document.createElement('div');
    note.className = 'mv-broken-event-final';
    note.textContent = 'Keine weiteren Aufnahmen verfügbar.';
    const actions = setHost.querySelector('.mv-broken-event-actions');
    if (actions) actions.replaceWith(note);
  }
}

// ── Stage-23 orchestration ──────────────────────────────────────────────────
export function _renderLbLabels() {
  const el = byId('lightboxLabels');
  if (!el || !lbState.item) return;
  const active = new Set(lbState.item.labels || []);
  const species = lbState.item.bird_species || '';
  const birdColor = colors.bird || '#0ea5e9';
  const bubbles = TL_LABELS.map((l) => {
    const isActive = active.has(l);
    const rawSvg = OBJ_SVG[l] || OBJ_SVG.alarm;
    const svg = rawSvg.replace('width="16" height="16"', 'width="38" height="38"');
    const title = OBJ_LABEL[l] || l;
    const c = colors[l] || colors.unknown;
    const speciesSub =
      l === 'bird' && species && isActive
        ? `<span style="position:absolute;top:calc(100% + 4px);left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.72);color:${birdColor};font-size:11px;font-weight:700;padding:3px 8px;border-radius:8px;white-space:nowrap;border:1px solid ${birdColor}55;pointer-events:none">${esc(species)}</span>`
        : '';
    return `<span data-label="${l}" title="${title}" style="position:relative;width:54px;height:54px;border-radius:50%;background:${isActive ? c + '30' : 'rgba(0,0,0,0.60)'};filter:drop-shadow(0 2px 8px rgba(0,0,0,0.8));display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;cursor:pointer;pointer-events:auto;transition:background .15s,opacity .15s,border-color .15s;opacity:${isActive ? '1' : '0.6'};border:2px solid ${isActive ? c + 'cc' : 'rgba(255,255,255,0.08)'}">${svg}${speciesSub}</span>`;
  }).join('');
  el.innerHTML = bubbles;
  el.querySelectorAll('[data-label]').forEach((btn) => {
    btn.onclick = async () => {
      const lbl = btn.dataset.label;
      const cur = new Set(lbState.item.labels || []);
      if (cur.has(lbl)) cur.delete(lbl);
      else cur.add(lbl);
      const newLabels = [...cur];
      try {
        const res = await j(
          `/api/camera/${lbState.item.camera_id}/events/${lbState.item.event_id}/labels`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labels: newLabels }),
          },
        );
        if (res.ok) {
          lbState.item.labels = res.labels;
          if (res.top_label !== undefined) lbState.item.top_label = res.top_label;
          const idx = (state.media || []).findIndex((x) => x.event_id === lbState.item.event_id);
          if (idx >= 0) {
            state.media[idx].labels = res.labels;
            if (res.top_label !== undefined) state.media[idx].top_label = res.top_label;
          }
          const aIdx = (state._allMedia || []).findIndex(
            (x) => x.event_id === lbState.item.event_id,
          );
          if (aIdx >= 0) {
            state._allMedia[aIdx].labels = res.labels;
            if (res.top_label !== undefined) state._allMedia[aIdx].top_label = res.top_label;
          }
          _renderLbLabels();
          // sync thumbnail in media grid
          const thumbCard = byId('mediaGrid')?.querySelector(
            `[data-event-id="${CSS.escape(lbState.item.event_id)}"]`,
          );
          if (thumbCard) {
            const bubblesEl = thumbCard.querySelector('.media-label-bubbles');
            if (bubblesEl)
              bubblesEl.innerHTML = res.labels
                .slice(0, 3)
                .map((l) => objBubble(l, 26))
                .join('');
          }
          // Re-pull timeline + storage stats so badges and dots reflect the retag.
          refreshTimelineAndStats();
        }
      } catch (_err) {
        showToast('Label-Änderung fehlgeschlagen', 'error');
      }
    };
  });
}

function _lbHandleDeleteKey() {
  if (!lbState.item) return;
  if (lbState.item.confirmed && !lbState.deletePending) {
    lbState.deletePending = true;
    const btn = byId('lightboxDelete');
    if (btn) {
      btn.classList.add('confirm-delete');
      btn.innerHTML = '<span>🗑</span><span style="font-size:9px">↓ nochmal</span>';
    }
    return;
  }
  byId('lightboxDelete').click();
}

export function openLightbox(item) {
  if (item.type === 'timelapse') {
    openTLPlayer(item);
    return;
  }
  // iOS hand-off — for video items, skip the custom shell entirely and
  // give Safari its native player. The doubled-chrome problem (lightbox
  // buttons + iOS controls overlapping) goes away because there's no
  // shell to render on top of the player. Action sheet fills the gap
  // for tag/confirm/delete after the player closes.
  const _hasVideoSrc = !!(item && (item.video_relpath || item.video_url));
  if (IS_IOS && _hasVideoSrc) {
    _iosNativeVideoOpen(item);
    return;
  }
  // Route through the mediaview shell entry — `recorded` mode renders
  // via mediaview/recorded-mode.js (H). The visible composition is the
  // same full-screen video chrome; the renderer just lives in the
  // mediaview tree now instead of inline here.
  return openMediaView({ mode: 'recorded', item });
}

function _tlNavItems() {
  // Timelapse + motion events share state._allMedia now — navigation is uniform.
  return state._allMedia || [];
}
function _tlPeriodLabel(item) {
  if (item.period_s > 0) {
    const p = item.period_s,
      d = item.target_s || 0;
    const pl =
      p < 3600
        ? Math.round(p / 60) + 'min'
        : p < 86400
          ? Math.round(p / 3600) + 'h'
          : p < 604800
            ? 'daily'
            : p < 2592000
              ? 'weekly'
              : 'monthly';
    const dl = d < 60 ? d + 'sec' : Math.floor(d / 60) + 'min';
    return `${pl}→${dl}`;
  }
  const raw = item.profile || item.period || '';
  if (raw === 'rolling_10min') return '10 min';
  if (raw === 'hour') return 'Stunde';
  if (raw === 'custom') return 'Custom';
  if (raw === 'daily' || raw === 'day') return 'Tag';
  if (raw === 'weekly') return 'Woche';
  if (raw === 'monthly') return 'Monat';
  return raw || 'Timelapse';
}
export function openTLPlayer(item) {
  const navItems = _tlNavItems();
  lbState.index = navItems.findIndex((x) => x.event_id === item.event_id);
  lbState.item = lbState.index >= 0 ? navItems[lbState.index] : item;
  // Jump the grid page when this item lives outside the current page
  // window, so the thumbnails behind the lightbox match the lightbox
  // content — same rule as openLightbox above.
  const ps = window._cachedPageSize || calcItemsPerPage();
  if (lbState.index >= 0 && window._cachedPageSize && navItems.length > 0) {
    const targetPage = Math.floor(lbState.index / ps);
    if (targetPage !== state.mediaPage) {
      state.mediaPage = targetPage;
      const offset = targetPage * ps;
      state.media = navItems.slice(offset, offset + ps);
      try {
        renderMediaGrid();
        renderMediaPagination();
      } catch (_) {}
    }
  }
  lbState.deletePending = false;
  _lbClearDetections();
  // Timelapse now uses the SAME shell as motion clips — full-screen
  // video chrome, scrubber, time-axis ticks, panel-tab strip
  // (Wetter · Nach-Erkennung), fine-analysis fold, Space / ← →
  // keyboard. The timeline panel renders the scrubber row even when
  // tracks.json is absent (an inline "Nach-Erkennung starten" button
  // sits in the empty placeholder row). When the worker produces a
  // sidecar, the swimlane fills in via the existing fetcher loop.
  _setupVideoChrome(lbState.item);
  const imgEl = byId('lightboxImg');
  imgEl.style.display = 'none';
  const videoEl = byId('lightboxVideo');
  const videoSrc =
    (item.video_relpath ? '/media/' + item.video_relpath : '') ||
    item.video_url ||
    item.url ||
    (item.relpath ? '/media/' + item.relpath : '');
  videoEl.style.display = 'block';
  videoEl.src = videoSrc;
  videoEl.load();
  videoEl.play().catch(() => {});
  const confirmBtn = byId('lightboxConfirm');
  if (confirmBtn) confirmBtn.style.display = 'none';
  byId('lightboxLabels').innerHTML = '';
  const delBtn = byId('lightboxDelete');
  if (delBtn) {
    delBtn.classList.remove('confirm-delete');
    delBtn.innerHTML = _LB_TRASH_HTML;
    delBtn.title = 'Timelapse löschen';
  }
  const period = _tlPeriodLabel(item);
  const sizeBadge = item.size_mb != null ? `<span class="badge">${item.size_mb} MB</span>` : '';
  byId('lightboxMeta').innerHTML = `
    <span class="badge">${esc(item.camera_id || '')}</span>
    <span class="badge">Timelapse · ${esc(period)}</span>
    <span class="badge">${esc(item.window_key || item.day || '')}</span>
    ${sizeBadge}`;
  // _setupVideoChrome already calls lbRenderTrackTimeline +
  // mountRecordedPanels for us — calling them again here would
  // double-mount and produced the duplicated "0s ... 1s" playbar +
  // the two empty red-bordered placeholder cards in the
  // weather/sunrise lightbox bug. lbLoadTracksForItem still has to
  // fire so the swimlane fills in when a sidecar exists for this
  // timelapse (post Nach-Erkennung worker run).
  const setHost = byId('lightboxSettings');
  if (setHost) setHost.hidden = false;
  lbLoadTracksForItem(lbState.item);
  const total = navItems.length;
  byId('lightboxPrev').style.opacity = lbState.index > 0 ? '1' : '0.2';
  byId('lightboxNext').style.opacity = lbState.index < total - 1 ? '1' : '0.2';
  byId('lightboxModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

export function closeLightbox() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen || function () {})
      .call(document)
      .catch(() => {});
  }
  byId('lightboxModal').classList.add('hidden');
  document.body.style.overflow = '';
  // Halt the Phase-2 tracking-playback RAF loop. Done before clearing
  // lbState.item so the loop's null-check sees a consistent "lightbox
  // closed" state on its next tick.
  lbStopTrackingPlayback();
  // Stop the MediaView live-detect polling loop if it was the path
  // that opened this modal. No-op when nothing is live; cleared via
  // the window bridge so this file doesn't have to import the
  // live-detect module directly.
  try {
    window.closeLiveDetect?.();
  } catch {
    /* ignore */
  }
  // L1 · weather now rides this same #lightboxModal container (mv-modal
  // deleted). Tear its shell down too so Esc / backdrop close converge
  // here. No-op when nothing weather is open; guarded like the bridge
  // above so this file needn't import the weather module directly.
  try {
    window.closeWeatherMode?.();
  } catch {
    /* ignore */
  }
  // Tear down the zone/mask overlay + its ResizeObserver. The
  // helper is idempotent; the next open re-mounts cleanly.
  try {
    unmountZoneOverlayForLightbox();
  } catch {
    /* ignore */
  }
  // Drop the full-screen video chrome so the next photo open returns
  // to the centred-modal layout without a flash of misplaced controls.
  _teardownVideoChrome();
  lbState.item = null;
  lbState.index = -1;
  const videoEl = byId('lightboxVideo');
  if (videoEl) {
    videoEl.pause();
    videoEl.src = '';
    videoEl.style.display = 'none';
  }
  byId('lightboxImg').style.display = '';
  _lbClearDetections();
  const confirmBtn = byId('lightboxConfirm');
  if (confirmBtn) confirmBtn.style.display = '';
}

// Lightbox navigation list — the merged-and-sorted global media list for
// BOTH motion and timelapse items. EventStore unifies the two kinds, so
// prev/next walks the global timeline regardless of the current page or
// item type. _tlNavItems() returns the same list (kept as an alias for
// historical reasons + the timelapse-only callers).
function _lbNavList() {
  return state._allMedia || [];
}

let _lbSeekOverlayTimer = null;
function _lbShowSeekOverlay(text) {
  const wrap = byId('lightboxMediaWrap');
  if (!wrap) return;
  let el = byId('lightboxSeekOverlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'lightboxSeekOverlay';
    el.style.cssText =
      'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.72);color:#fff;font-size:34px;font-weight:800;padding:14px 26px;border-radius:14px;pointer-events:none;z-index:5;backdrop-filter:blur(8px);opacity:0;transition:opacity .2s ease;letter-spacing:.02em';
    wrap.appendChild(el);
  }
  el.textContent = text;
  // force reflow so a rapid second press retriggers the fade-in
  el.style.opacity = '0';
  void el.offsetWidth;
  el.style.opacity = '1';
  clearTimeout(_lbSeekOverlayTimer);
  _lbSeekOverlayTimer = setTimeout(() => {
    el.style.opacity = '0';
  }, 600);
}

// ── DOM wiring (runs once on import) ────────────────────────────────────────
byId('lightboxClose').onclick = closeLightbox;
byId('lightboxModal').onclick = (e) => {
  const modal = byId('lightboxModal');
  if (e.target === modal) {
    closeLightbox();
  } else if (modal.classList.contains('lb-weather') && e.target === byId('lightboxInner')) {
    // L1 · in weather mode #lightboxInner fills the viewport (the shell
    // is a centred 980 px column), so a click on the side gutter lands
    // on the inner, not the modal — treat it as backdrop dismiss too.
    closeLightbox();
  }
};
byId('lightboxPrev').onclick = () => {
  const nav = _lbNavList();
  const i = nav.findIndex((x) => x.event_id === lbState.item?.event_id);
  if (i > 0) openLightbox(nav[i - 1]);
};
byId('lightboxNext').onclick = () => {
  const nav = _lbNavList();
  const i = nav.findIndex((x) => x.event_id === lbState.item?.event_id);
  if (i >= 0 && i < nav.length - 1) openLightbox(nav[i + 1]);
};

document.addEventListener('keydown', (e) => {
  // Live view ESC close (takes priority)
  if (e.key === 'Escape' && !byId('liveViewModal')?.classList.contains('hidden')) {
    closeLiveView();
    return;
  }
  const lbOpen = !byId('lightboxModal').classList.contains('hidden');
  if (!lbOpen) {
    // Drilldown back-nav: Backspace or Escape returns to overview when no lightbox is open.
    // Skip when the user is typing in an input/textarea so editable fields keep their normal behavior.
    if (
      (e.key === 'Escape' || e.key === 'Backspace') &&
      byId('mediaDrilldown')?.style.display !== 'none'
    ) {
      const t = e.target;
      const isEditable =
        t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (!isEditable) {
        e.preventDefault();
        closeMediaDrilldown();
        return;
      }
    }
    return;
  }
  // Suppress lightbox shortcuts whenever the user is typing in a form
  // field — Escape and the seek/nav keys must not steal focus from
  // an active text input embedded in a panel (e.g. the future
  // Detections-tab class filter chip). Mirrors the input-focus guard
  // the drilldown branch above already uses.
  const _tgt = e.target;
  const _editable =
    _tgt &&
    (_tgt.tagName === 'INPUT' ||
      _tgt.tagName === 'TEXTAREA' ||
      _tgt.tagName === 'SELECT' ||
      _tgt.isContentEditable);
  if (_editable) return;
  const _v = byId('lightboxVideo');
  const _videoActive = !!(_v && _v.style.display !== 'none' && _v.src);
  // Live-sim suppresses prev/next + confirm/delete keys — there's no
  // recorded item to navigate to or label. Esc + Space + F still
  // route through their normal handlers below so the user keeps
  // close-on-Esc and fullscreen-on-F.
  const _liveDetect = byId('lightboxModal').classList.contains('lb-live-detect');
  // L1 · weather shares this container too; like live it has no recorded
  // item to seek/label, so it suppresses the prev/next + confirm/delete
  // keys (its own title-bar chevrons handle navigation).
  const _weather = byId('lightboxModal').classList.contains('lb-weather');
  // Seek step — was 10 s; tightened to 5 s to match the mediaview
  // task #6 spec. Five-second granularity reads more naturally for
  // 10-30 s motion clips, where 10 s would overshoot interesting
  // segments in two presses.
  if (e.key === 'ArrowLeft') {
    if (_liveDetect || _weather) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    if (_videoActive) {
      _v.currentTime = Math.max(0, (_v.currentTime || 0) - 5);
      _lbShowSeekOverlay('−5s');
    } else {
      const nav = _lbNavList();
      const i = nav.findIndex((x) => x.event_id === lbState.item?.event_id);
      if (i > 0) openLightbox(nav[i - 1]);
    }
  } else if (e.key === 'ArrowRight') {
    if (_liveDetect || _weather) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    if (_videoActive) {
      const dur = _v.duration || 0;
      const next = (_v.currentTime || 0) + 5;
      _v.currentTime = dur > 0 ? Math.min(dur, next) : next;
      _lbShowSeekOverlay('+5s');
    } else {
      const nav = _lbNavList();
      const i = nav.findIndex((x) => x.event_id === lbState.item?.event_id);
      if (i >= 0 && i < nav.length - 1) openLightbox(nav[i + 1]);
    }
  } else if (e.key === 'ArrowUp') {
    if (_liveDetect || _weather) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    byId('lightboxConfirm').click();
  } else if (e.key === 'ArrowDown') {
    if (_liveDetect || _weather) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    _lbHandleDeleteKey();
  } else if (e.key === ' ') {
    if (_videoActive) {
      e.preventDefault();
      if (_v.paused) _v.play().catch(() => {});
      else _v.pause();
    }
  } else if (e.key === 'f' || e.key === 'F') {
    if (_videoActive) {
      e.preventDefault();
      const fsElem = document.fullscreenElement || document.webkitFullscreenElement;
      if (fsElem) {
        (document.exitFullscreen || document.webkitExitFullscreen || function () {})
          .call(document)
          .catch(() => {});
      } else {
        const req = _v.requestFullscreen || _v.webkitRequestFullscreen || _v.webkitEnterFullscreen;
        if (req) req.call(_v).catch(() => {});
      }
    }
  } else if (e.key === 'Escape') closeLightbox();
});

_updateLbConfirmBtn(false);
byId('lightboxDelete').innerHTML = _LB_TRASH_HTML;
// Desktop-only — the live modal is never shown on iOS
// (openLiveViewIosNative keeps it hidden and hands directly to
// the native iOS system player), so the FS button inside the
// modal is unreachable on iOS. No iOS gate needed here.
_initFsBtn('liveViewFsBtn', byId('liveViewWrap'), () => byId('liveViewWrap'));

// Swipe navigation on the lightbox media area (mobile). Horizontal
// swipe = prev/next; vertical swipes are ignored (the swipe-down-
// to-dismiss branch was removed — it was firing accidentally on
// scroll/zoom and the visible X button covers the close case).
(function initLightboxSwipe() {
  const wrap = byId('lightboxMediaWrap');
  const modal = byId('lightboxModal');
  if (!wrap || !modal) return;
  let _tx = 0,
    _ty = 0,
    _dragging = false;
  wrap.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) return;
      _tx = e.touches[0].clientX;
      _ty = e.touches[0].clientY;
      _dragging = true;
    },
    { passive: true },
  );
  wrap.addEventListener(
    'touchend',
    (e) => {
      if (!_dragging) return;
      _dragging = false;
      const dx = e.changedTouches[0].clientX - _tx;
      const dy = e.changedTouches[0].clientY - _ty;
      // Vertical-dominant gestures (scroll, pinch-zoom-finish) must
      // not trigger prev/next — drop them on the floor.
      if (Math.abs(dy) > Math.abs(dx)) return;
      if (Math.abs(dx) < 40) return;
      // Live-sim has no neighbour item to navigate to.
      if (modal.classList.contains('lb-live-detect')) return;
      if (dx < 0) byId('lightboxNext')?.click();
      else byId('lightboxPrev')?.click();
    },
    { passive: true },
  );
})();

byId('lightboxConfirm').onclick = async () => {
  if (!lbState.item) return;
  const { camera_id, event_id } = lbState.item;
  if (!camera_id || !event_id) return;
  try {
    await j(
      `/api/camera/${encodeURIComponent(camera_id)}/events/${encodeURIComponent(event_id)}/confirm`,
      { method: 'POST' },
    );
    // update state.media in place
    const sIdx = (state.media || []).findIndex((x) => x.event_id === event_id);
    if (sIdx >= 0) state.media[sIdx].confirmed = true;
    _updateLbConfirmBtn(true);
    if (lbState.item) lbState.item.confirmed = true;
    // update card DOM
    const card = byId('mediaGrid').querySelector(`[data-event-id="${CSS.escape(event_id)}"]`);
    if (card) {
      card.classList.add('mmc-confirmed');
      const actions = card.querySelector('.mmc-actions');
      if (actions) actions.outerHTML = '<span class="media-confirmed-badge">✓</span>';
    }
    // auto-advance to next item (use fresh index)
    const ci = (state.media || []).findIndex((x) => x.event_id === event_id);
    const nextIdx = ci + 1;
    if (nextIdx > 0 && nextIdx < (state.media || []).length) openLightbox(state.media[nextIdx]);
    else closeLightbox();
  } catch (e) {
    showToast('Bestätigen fehlgeschlagen: ' + e.message, 'error');
  }
};

byId('lightboxDelete').onclick = async () => {
  if (!lbState.item) return;
  // Weather-sighting deletion (S04). `_openSightingInLightbox` in
  // weather/sightings.js synthesises a timelapse-shaped item with an
  // explicit `source: 'weather'` marker. The camera-timelapse DELETE
  // endpoint 404s on sighting ids, so route to the weather endpoint
  // and refresh the weather grid afterwards.
  if (lbState.item.source === 'weather') {
    if (!lbState.deletePending) {
      lbState.deletePending = true;
      const btn = byId('lightboxDelete');
      if (btn) {
        btn.classList.add('confirm-delete');
        btn.innerHTML =
          '<span style="font-size:15px;line-height:1;opacity:.75">↓</span><span style="font-size:11px">nochmal</span>';
      }
      return;
    }
    try {
      await j(`/api/weather/sightings/${encodeURIComponent(lbState.item.event_id)}`, {
        method: 'DELETE',
      });
      closeLightbox();
      if (typeof window.loadWeatherSightings === 'function') {
        try {
          await window.loadWeatherSightings();
        } catch {
          /* non-critical: grid will refresh on next user nav */
        }
      }
    } catch (e) {
      showToast('Löschen fehlgeschlagen: ' + e.message, 'error');
    }
    return;
  }
  // Timelapse deletion
  if (lbState.item.type === 'timelapse') {
    if (!lbState.deletePending) {
      lbState.deletePending = true;
      const btn = byId('lightboxDelete');
      if (btn) {
        btn.classList.add('confirm-delete');
        btn.innerHTML =
          '<span style="font-size:15px;line-height:1;opacity:.75">↓</span><span style="font-size:11px">nochmal</span>';
      }
      return;
    }
    const filename = lbState.item.filename || (lbState.item.relpath || '').split('/').pop();
    if (!filename) {
      showToast('Dateiname fehlt', 'error');
      return;
    }
    try {
      await j(
        `/api/camera/${encodeURIComponent(lbState.item.camera_id)}/timelapse/${encodeURIComponent(filename)}`,
        { method: 'DELETE' },
      );
      const deletedId = lbState.item.event_id;
      state.media = (state.media || []).filter((x) => x.event_id !== deletedId);
      state._allMedia = (state._allMedia || []).filter((x) => x.event_id !== deletedId);
      renderMediaGrid();
      const nav = _tlNavItems();
      const nextIdx = Math.min(lbState.index, nav.length - 1);
      if (nextIdx < 0) closeLightbox();
      else openLightbox(nav[nextIdx]);
      // Pulls /api/media/storage-stats + re-renders the filter pill
      // bar. Photo delete below already does this; the timelapse
      // branch used to skip it, so deleting the last timelapse left
      // the "Timelapse N" pill stuck on its pre-delete count.
      await refreshTimelineAndStats();
    } catch (e) {
      showToast('Löschen fehlgeschlagen: ' + e.message, 'error');
    }
    return;
  }
  // Photo event deletion
  const { camera_id, event_id } = lbState.item;
  if (!camera_id || !event_id) return;
  try {
    const imgEl = byId('lightboxImg');
    if (imgEl) {
      imgEl.style.transform = 'scale(0.88)';
      imgEl.style.opacity = '0';
    }
    await new Promise((r) => setTimeout(r, 200));
    if (imgEl) {
      imgEl.style.transform = '';
      imgEl.style.opacity = '';
    }
    await j(`/api/camera/${encodeURIComponent(camera_id)}/events/${encodeURIComponent(event_id)}`, {
      method: 'DELETE',
    });
    // Remove from client-side pool and re-paginate so the current page refills
    state._allMedia = (state._allMedia || []).filter((x) => x.event_id !== event_id);
    const ps_lb = calcItemsPerPage();
    state.mediaTotalPages = Math.max(1, Math.ceil(state._allMedia.length / ps_lb));
    state.mediaPage = Math.min(state.mediaPage || 0, state.mediaTotalPages - 1);
    state.media = state._allMedia.slice(state.mediaPage * ps_lb, (state.mediaPage + 1) * ps_lb);
    if (state.media.length === 0 && state.mediaPage > 0) {
      state.mediaPage--;
      state.media = state._allMedia.slice(state.mediaPage * ps_lb, (state.mediaPage + 1) * ps_lb);
    }
    renderMediaGrid();
    renderMediaPagination();
    lbState.index = Math.min(lbState.index, (state.media || []).length - 1);
    if (lbState.index < 0) closeLightbox();
    else openLightbox(state.media[lbState.index]);
    await refreshTimelineAndStats();
  } catch (e) {
    showToast('Löschen fehlgeschlagen: ' + e.message, 'error');
  }
};

// Resize listener — re-paginate the drilldown grid when the viewport
// size changes by enough to shift the column count.
let _mediaResizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(_mediaResizeTimer);
  _mediaResizeTimer = setTimeout(() => {
    if (byId('mediaDrilldown')?.style.display !== 'none') {
      const ns = calcItemsPerPage();
      if (Math.abs(ns - window._cachedPageSize) >= 4) {
        window._cachedPageSize = ns;
        state.mediaTotalPages = Math.max(1, Math.ceil((state._allMedia || []).length / ns));
        state.mediaPage = 0;
        state.media = (state._allMedia || []).slice(0, ns);
        renderMediaGrid();
        renderMediaPagination();
      }
    }
  }, 400);
});

// iOS Safari hard-pauses the lightbox <video> when the tab/PWA goes
// background. On resume the play() promise often rejects silently —
// re-arm by reloading + replaying. Cheap on desktop too (no-op when
// the video isn't open / isn't paused).
document.addEventListener('tamspy:viewport-resumed', () => {
  const v = byId('lightboxVideo');
  if (!v || v.style.display === 'none' || !v.src) return;
  if (v.paused) {
    v.load();
    v.play().catch(() => {});
  }
});

// ── window.* bridges (Stage 25 D) ───────────────────────────────────────────
// router.js + a couple of cam-edit save flows reach for these by
// global name; renderMediaGrid's _openMediaItem also looks up
// window.openLightbox at runtime.
window.openLightbox = openLightbox;
window.closeLightbox = closeLightbox;
window.openTLPlayer = openTLPlayer;
