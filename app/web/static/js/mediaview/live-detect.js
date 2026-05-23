// ─── mediaview/live-detect.js ──────────────────────────────────────────────
// Live-detect mount for the MediaView shell — reuses the recorded
// lightbox chrome end-to-end (Close-X relocated to the top bar,
// 16:9 wrap, scrubber + class-coloured swimlanes via
// lbRenderTrackTimeline, panel-tabs strip, fine-analysis fold) and
// adds the live-specific pieces: an MJPEG-frame <img> sourced from
// the 1 Hz test-detection snapshot, an SVG bbox overlay, an
// overlay-toggles row above the playbar, and an LIVE pill pinned to
// the right edge of the scrubber.
//
// Per-track data flows through synthetic _tracks payloads that mimic
// the tracks.json shape the recorded swimlane already renders. The
// live tracker's response does NOT expose per-track ids yet — we
// fall back to per-label grouping (one synthetic Track per label,
// detections accumulating as samples) per the cm-52 follow-up
// prompt's graceful-degradation rule.
//
// Lifecycle:
//   openLiveDetect({camId, cameraName})  — mount + start polling.
//   closeLiveDetect()                    — abort + stop + teardown.
// closeLightbox() in lightbox.js fires closeLiveDetect via the
// window bridge so any modal-close path tears the session down.
import { byId, esc } from '../core/dom.js';
import { state } from '../core/state.js';
import { OBJ_LABEL, OBJ_SVG, colors, objIconSvg } from '../core/icons.js';
import { renderFineAnalysisFold } from './fine-analysis-fold.js';
import { normalizePolygon } from '../core/polygon-source.js';
import { renderZoneLayerForMediaEl } from './canvas/zone-layer.js';
import { fittedRect } from '../core/video-fit.js';
import { lbRenderTrackTimeline } from '../mediathek/bbox-overlay/index.js';
import { _setupVideoChrome } from '../lightbox.js';
import { tryAttachHls } from '../core/hls-attach.js';
import { buildTrailSvg } from './canvas/trail-layer.js';

// C73 · cadence floors. The original 1 Hz floor was set against the
// main-stream cost budget (2560×1440 frame copy + JPEG encode +
// inference ~600-1500 ms). With C41's sub-stream path the per-tick
// cost drops to ~250 ms, so 500 ms is a safe floor on that path.
// _scheduleNext picks the right floor based on the most recent
// diag.frame_src; the main_fallback path keeps the 1 Hz floor so an
// unhealthy / sub-disabled camera doesn't get hammered.
const _TICK_FLOOR_SUB_MS = 500;
const _TICK_FLOOR_MAIN_MS = 1000;
const _TICK_MAX_MS = 4000;
const _TICK_FACTOR = 1.2;

// C84 · dynamic bbox hold-time scaffolding. The cycle EMA is
// populated by _scheduleNext on every cycle, then _holdMsActive
// is derived from it (clamp(2*EMA, 800, 1500)). Both stay valid
// at module level so the CADENCE row from C73 can read them
// without late-binding gymnastics.
let _cycleEmaMs = NaN;
let _holdMsActive = NaN;
// 60 s sliding window for the swimlane. Detections older than this
// age out of the visible strip.
const _LIVE_WINDOW_MS = 60_000;
const _TRACE_CAP = 80;
// gp384 — hold-time for bbox fade-out after the live tick goes
// empty. Each live bbox lingers for this long after its last sight,
// fading from full opacity down to zero. Without hold-time the
// bboxes vanish the instant the 1 Hz detector misses a frame —
// which on a fluttering bird or jittery score → "blinky" UX and
// the user assumes the renderer is broken.
// C84 · upper bound for the dynamic bbox hold-time. The hold is
// derived per-cycle from the EMA of recent tick wall-times:
//   hold_ms = clamp(2 * EMA, 800, _HOLD_MS_CEILING)
// so on a healthy sub-stream path (~500-700 ms ticks) the hold
// converges around ~1000-1400 ms — long enough to bridge a single
// missed tick, short enough that a moving subject's box doesn't
// ghost behind it.
const _HOLD_MS_CEILING = 1500;
const _HOLD_MS_FLOOR = 800;
// gp384 — "no detection on screen" hint banner threshold. Shows
// only when the bboxes layer is enabled, no live OR held bbox is
// visible, AND the detector has missed for this long.
const _EMPTY_HINT_MS = 3000;
// Refresh interval for the hold-time fade + empty-state banner.
// Fires at ~24 Hz; the actual bbox repaints are cheap (innerHTML
// of an SVG with < 10 elements) and only run while live-detect is
// mounted, so the cost is negligible vs. the smoothness gain.
const _HOLD_REFRESH_MS = 250;

// hp651 — debug-only one-liner inside the toggle click handler.
// Off by default; flip to true in the source file when chasing a
// toggle regression so a single console.warn fires on each click.
const _DEBUG_TOGGLE = false;

let _session = null;
let _hlsHandle = null;
let _traceLines = [];
let _detBuffer = []; // [{ms, label, score, bbox, verdict}, …]
// C1 · sim modal opens with detection layers ON, surveillance layers
// OFF — the operator wants to see what Coral is finding, not have
// the preview cluttered with green zone polygons and red mask fills
// every time they enter the modal. Mirrors the same defaults in the
// shared overlay-toggles.js _TOGGLES dict so the two callsites stay
// consistent.
let _overlays = { bboxes: true, trails: true, zones: false, masks: false };
let _selectedLabel = null; // for detail-pill pin

// F12 · single ordered stacking container for the live-detect mount.
// Five named slots (titlebar / video / controls / timeline / detail)
// inside #lightboxMediaWrap. Every prior wrap.appendChild call site
// is now routed through _slot(name) so the slot DOM order is the
// single source of truth — no element from the detail slot can ever
// render above the video slot, regardless of which subsystem mounted
// it. The stack is built once per openLiveDetect and torn down by
// closeLiveDetect (children of the video slot — the persistent
// <img id="lightboxImg"> + <video id="lightboxVideo"> — get moved
// back to the wrap so recorded-clip mode reuses them unchanged).
const _STACK_CLASS = 'mv-livedetect-stack';
const _SLOTS = ['titlebar', 'video', 'controls', 'timeline', 'detail'];

function _setupLiveDetectStack() {
  const wrap = byId('lightboxMediaWrap');
  if (!wrap) return null;
  let stack = wrap.querySelector(`.${_STACK_CLASS}`);
  if (stack) return stack;
  stack = document.createElement('div');
  stack.className = _STACK_CLASS;
  stack.innerHTML = `
    <header class="mv-ld-titlebar" data-slot="titlebar"></header>
    <section class="mv-ld-video" data-slot="video"></section>
    <nav class="mv-ld-controls" data-slot="controls"></nav>
    <section class="mv-ld-timeline" data-slot="timeline"></section>
    <section class="mv-ld-detail" data-slot="detail"></section>`;
  const videoSlot = stack.querySelector('[data-slot="video"]');
  // Move existing wrap children (the persistent #lightboxImg +
  // #lightboxVideo elements from modals.html) into the video slot
  // BEFORE appending the stack — otherwise appending the stack
  // child detaches and re-attaches them in the wrong order.
  const moved = Array.from(wrap.childNodes);
  for (const c of moved) videoSlot.appendChild(c);
  wrap.appendChild(stack);
  return stack;
}

function _slot(name) {
  if (!_SLOTS.includes(name)) return null;
  const wrap = byId('lightboxMediaWrap');
  return wrap?.querySelector(`.${_STACK_CLASS} [data-slot="${name}"]`) || null;
}

function _teardownLiveDetectStack() {
  const wrap = byId('lightboxMediaWrap');
  if (!wrap) return;
  const stack = wrap.querySelector(`.${_STACK_CLASS}`);
  if (!stack) return;
  // Move the persistent media elements back to the wrap so the
  // recorded-clip path finds them where modals.html declared them.
  const videoSlot = stack.querySelector('[data-slot="video"]');
  if (videoSlot) {
    const moved = Array.from(videoSlot.childNodes);
    for (const c of moved) wrap.appendChild(c);
  }
  stack.remove();
}

export function openLiveDetect({ camId, cameraName }) {
  if (!camId) return;
  // B12 · capture whether a prior session was mounted BEFORE
  // closeLiveDetect nulls it. Surfaced on the MOUNT row as
  // torn_down_prev so a back-to-back cam switch is visible.
  const tornDownPrev = !!_session;
  closeLiveDetect();
  _session = {
    camId,
    cameraName,
    abort: null,
    tickHandle: null,
    fold: null,
    startedMs: Date.now(),
    lastNonEmptyTickMs: 0,
    holdHandle: null,
  };
  _traceLines = [];
  _detBuffer = [];
  _selectedLabel = null;
  _overlays = { bboxes: true, trails: true, zones: false, masks: false };
  // H2.a · reset the diag-strip state per session so the previous
  // open's last-known SVG dims don't bleed into the new one.
  _diagState.bbox = null;
  _diagState.trails = null;
  _diagState.zonemask = null;
  _diagState.posFail = null;
  _diagState.paintFail = null;
  _diagState.tick = null;
  _diagState.mount = null;
  _diagState.cadence = null;
  // B7/B12 · reset tick lifecycle state. Keep startedAt fresh on
  // every open so the strip's mounted_ms_ago matches the user's
  // last action — not some half-finished prior session.
  _tickState.lastTickAt = 0;
  _tickState.lastRespAt = 0;
  _tickState.lastStatus = '—';
  _tickState.nextTickAt = 0;
  _tickState.startedAt = Date.now();
  _tickState.startedWithCamId = camId;
  _tickState.ticksDroppedLate = 0;
  _tickState.lastDropReason = null;
  _tickState.tornDownPrev = tornDownPrev;
  _tickState.lastTickError = null;
  _tickState.lastCycleMs = NaN;
  _tickState.lastFloorMs = NaN;
  _tickState.lastDelayMs = NaN;
  // C84 · reset hold-time state per session so a fresh cam-open
  // doesn't inherit the previous camera's cadence as the seed EMA.
  _cycleEmaMs = NaN;
  _holdMsActive = NaN;
  // B12' · always-on MOUNT row. Tracks every step of the mount path
  // so a screenshot tells us at a glance whether chrome rendered,
  // whether _tick() threw, and whether a first-tick setTimeout was
  // actually scheduled. Healthy mounts paint muted; any error flips
  // the row red and persists until the next successful mount.
  const mountRecord = {
    started_at: new Date(_tickState.startedAt).toISOString(),
    started_with_camId: camId,
    torn_down_prev: tornDownPrev ? 'true' : 'false',
    chrome_mounted: 'false',
    first_tick_scheduled: 'false',
    error: '',
  };
  let chromeOk = false;
  let mountErr = null;
  try {
    // F12 · build the slot scaffold FIRST so every subsequent
    // overlay / pill / accordion mount sees its slot and routes
    // there instead of falling back to the bare wrap.
    _setupLiveDetectStack();
    _setupLiveChrome(camId, cameraName);
    _mountPanels();
    chromeOk = true;
  } catch (err) {
    mountErr = err;
  }
  mountRecord.chrome_mounted = chromeOk ? 'true' : 'false';
  if (chromeOk) {
    try {
      _tick();
    } catch (err) {
      mountErr = err;
    }
  }
  if (mountErr) {
    mountRecord.error = (mountErr && (mountErr.message || String(mountErr))) || 'unknown';
  }
  // Initial paint of the MOUNT row — success-muted or error-red.
  // first_tick_scheduled stays "false" here; the 250 ms watchdog
  // below promotes it to "true" once we observe a tickHandle.
  _diagState.mount = { ...mountRecord, _err: !!mountErr };
  _renderDiagStrip();
  _startHoldRefresh();
  document.body.style.overflow = 'hidden';
  // B12' · 250 ms watchdog. ONE-SHOT — fires once, then cleared.
  // Two outcomes: tickHandle present → mark first_tick_scheduled
  // true (success path); tickHandle still null → promote MOUNT row
  // to error with "no first-tick scheduled within 250ms".
  const expectedSessionStart = _tickState.startedAt;
  setTimeout(() => {
    // Different session by now → leave its own MOUNT row alone.
    if (!_session || _tickState.startedAt !== expectedSessionStart) return;
    const scheduled = !!_session.tickHandle;
    const rec = _diagState.mount || {};
    rec.first_tick_scheduled = scheduled ? 'true' : 'false';
    if (!scheduled && !rec.error) {
      rec.error = 'no first-tick scheduled within 250ms';
      rec._err = true;
    }
    _diagState.mount = rec;
    _renderDiagStrip();
  }, 250);
}

export function closeLiveDetect() {
  const session = _session;
  _session = null;
  _traceLines = [];
  _detBuffer = [];
  _selectedLabel = null;
  if (_hlsHandle) {
    _hlsHandle.detach();
    _hlsHandle = null;
    const videoEl = byId('lightboxVideo');
    if (videoEl) {
      videoEl.style.display = 'none';
    }
  }
  const imgEl = byId('lightboxImg');
  if (imgEl && imgEl.src && imgEl.src.includes('/stream')) {
    // Release the MJPEG fallback's HTTP connection so the server's
    // viewer counter ticks down.
    imgEl.removeAttribute('src');
  }
  if (!session) return;
  try {
    session.abort?.abort();
  } catch {
    /* ignore */
  }
  if (session.tickHandle) clearTimeout(session.tickHandle);
  if (session.holdHandle) clearInterval(session.holdHandle);
  const modal = byId('lightboxModal');
  if (modal) modal.classList.remove('lb-live-detect');
  // Restore prev/next chevrons so a subsequent recorded-clip open
  // gets its navigation arrows back. Confirm + Delete are restored
  // by lightbox.js's own teardown when openLightbox() runs.
  const prevBtn = byId('lightboxPrev');
  if (prevBtn) prevBtn.style.display = '';
  const nextBtn = byId('lightboxNext');
  if (nextBtn) nextBtn.style.display = '';
  const overlay = byId('lightboxLiveOverlay');
  if (overlay) overlay.remove();
  const trails = byId('lightboxLiveTrails');
  if (trails) trails.remove();
  const zoneMask = byId('lightboxLiveZoneMask');
  if (zoneMask) zoneMask.remove();
  const toggleRow = byId('mvLiveToggles');
  if (toggleRow) toggleRow.remove();
  const diagStrip = byId('mvSimDiagStrip');
  if (diagStrip) diagStrip.remove();
  const livePill = byId('mvLiveScrubPill');
  if (livePill) livePill.remove();
  const emptyHint = byId('mvLdEmptyHint');
  if (emptyHint) emptyHint.remove();
  // D52 · the "<n> verworfen — antippen für Details" hint sits
  // outside the toggle row; remove it on session teardown.
  const suppressedHint = byId('mvLiveSuppressedHint');
  if (suppressedHint) suppressedHint.remove();
  // F12 · tear down the slot scaffold and return the persistent
  // media elements (<img id="lightboxImg">, <video id="lightboxVideo">)
  // to the wrap so recorded-clip mode reuses them unchanged.
  _teardownLiveDetectStack();
}

// gp384 — bbox hold + empty-banner refresh. Drives the per-frame
// opacity fade-out for held detections and the show/hide of the
// "Aktuell keine Detektionen" banner. setInterval rather than
// requestAnimationFrame so the rate is fixed (the detector tick is
// 1 Hz anyway — animating at 60 Hz would just burn CPU without
// any visible benefit).
function _startHoldRefresh() {
  if (!_session) return;
  if (_session.holdHandle) clearInterval(_session.holdHandle);
  _session.holdHandle = setInterval(() => {
    if (!_session) return;
    _renderBboxOverlay();
    // B7 · piggyback the tick-row refresh on the existing 250 ms
    // hold loop so the on-screen deltas stay current even when the
    // tick loop is wedged (no _renderFrame call would otherwise
    // drive _renderDiagStrip). Cheap — _renderDiagStrip is a no-op
    // when the Debug pill is OFF.
    if (_debugDiagOn()) _renderDiagStrip();
  }, _HOLD_REFRESH_MS);
}

function _setupLiveChrome(camId, cameraName) {
  // kz368 — Simulieren intentionally does NOT render an HD toggle.
  // The detection pipeline runs on the sub-preview stream
  // (stream.mjpg, ~15-25 fps) per the kr493 redesign, not on HD —
  // an HD toggle here would mislead the user into thinking the
  // simulation reflects HD-pipeline behaviour. The MediaView
  // chrome below (_setupVideoChrome + the live-detect overlay
  // toggles) deliberately omits any .cv-hd-badge / .lvm-hd-btn
  // equivalent. The dashboard tile's HD button stays where it is;
  // it just isn't surfaced inside this view.
  //
  // Synthesise a timelapse-shaped item so _setupVideoChrome takes
  // its full chrome path (top bar + action relocation + scrubber +
  // panels). The 'live-detect' type tag lets downstream renderers
  // (this file's _renderLivePlaybar override) recognise the mode.
  const liveItem = {
    type: 'live-detect',
    event_id: `live-${camId}`,
    camera_id: camId,
    camera_name: cameraName || camId,
    time: '',
    weather: null,
    api_snapshot: null,
    _tracks: { tracks: [] },
  };
  // _setupVideoChrome mounts lb-fs-video + relocates Close/Confirm/
  // Delete to the top-bar action cluster + calls lbRenderTrackTimeline
  // + mountRecordedPanels. We replace the panels mount below since
  // live-detect needs a Detections-only tab strip + the live
  // overlay-toggles row above the playbar.
  _setupVideoChrome(liveItem);
  // hp651 — kill the recorded path's canvas zone overlay
  // (lightboxZoneOverlay, z-index 4). _setupVideoChrome always calls
  // mountZoneOverlayForLightbox; if the user reaches Simulieren via
  // an already-open lightbox session (img.src still pointing at a
  // previous clip), the canvas mounts AND lives at the same z-index
  // as our SVG, painting a second copy of every polygon that the
  // Zonen/Masken toggle below can't reach. Tearing it down here
  // keeps live-detect's SVG (lightboxLiveZoneMask) as the single
  // owner of zone + mask rendering for the lifetime of the
  // simulation.
  try {
    window._unmountZoneOverlayForLightbox?.();
  } catch {
    /* not mounted */
  }
  const modal = byId('lightboxModal');
  if (modal) {
    modal.classList.add('lb-live-detect');
    modal.classList.remove('hidden');
  }
  // Live mode title-bar marker — replaces the recorded timestamp.
  const tsEl = byId('lightboxTopTime');
  if (tsEl) tsEl.textContent = '● Live';
  // kr493 — Simulieren v2 continuous-stream redesign. The polling
  // tick fetches ONLY the detection payload (no_snapshot=1, ~1 kB
  // response); the video stays smooth at the stream's natural rate
  // while the bbox/trail overlays update at ~1-2 fps.
  //
  // ROOT CAUSE FIX (iPhone): iOS Safari does NOT render
  // `multipart/x-mixed-replace` MJPEG streams in `<img>` tags —
  // it shows a "broken image" placeholder no matter what bytes the
  // server sends. The dashboard's working Live modal sidesteps this
  // by attaching HLS to a `<video>` first (hls.js on desktop, native
  // HLS on iOS) and only falling back to MJPEG on the rare browser
  // that supports neither. The Simulieren view does the same now —
  // any iOS-reachable surface MUST go through HLS for the video to
  // paint at all.
  const imgEl = byId('lightboxImg');
  const videoEl = byId('lightboxVideo');
  if (_hlsHandle) {
    _hlsHandle.detach();
    _hlsHandle = null;
  }
  if (videoEl) {
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load?.();
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.style.display = 'none';
  }
  if (imgEl) {
    imgEl.removeAttribute('src');
    imgEl.style.display = 'none';
  }
  _hlsHandle = videoEl
    ? tryAttachHls(camId, videoEl, {
        onFatalError: () => {
          // HLS spun up but died — fall back to MJPEG on the platforms
          // that support it. On iOS this leaves the user with a broken
          // image, but iOS shouldn't hit this branch in the first place
          // (native HLS attach succeeds at line above).
          if (_hlsHandle) {
            _hlsHandle.detach();
            _hlsHandle = null;
          }
          _attachLiveMjpegFallback(camId);
        },
      })
    : null;
  if (_hlsHandle) {
    videoEl.style.display = 'block';
    videoEl.play?.().catch(() => {
      /* autoplay blocked — manual play still works */
    });
    _installLiveOverlayRefresh(videoEl);
  } else {
    _attachLiveMjpegFallback(camId);
  }
  const confirmBtn = byId('lightboxConfirm');
  if (confirmBtn) confirmBtn.style.display = 'none';
  const delBtn = byId('lightboxDelete');
  if (delBtn) delBtn.style.display = 'none';
  // Hide the recorded-clip prev/next chevrons in live-sim — there is
  // no neighbour item to navigate to. The .lb-live-detect class on
  // the modal also acts as a CSS hook the keyboard + swipe handlers
  // in lightbox.js read to suppress their prev/next bindings.
  const prevBtn = byId('lightboxPrev');
  if (prevBtn) prevBtn.style.display = 'none';
  const nextBtn = byId('lightboxNext');
  if (nextBtn) nextBtn.style.display = 'none';
  _ensureBboxOverlay();
  _ensureTrailsOverlay();
  _ensureZoneMaskOverlay();
  _mountOverlayToggles();
  // F12/F23 · paint the live-detect titlebar slot. The legacy
  // #lightboxTopBar is hidden via .lb-live-detect; this new slot
  // is safe-area-aware and stays inside the stack so DOM order
  // matches visual order. Close button delegates to the existing
  // #lightboxClose handler via a click-forward.
  _mountLiveTitlebar(cameraName, camId);
  _pinScrubberRight();
  // dn487 — paint zones + masks BEFORE the first detection tick
  // arrives. _renderZoneMaskOverlay falls back to {w:1920, h:1080}
  // when _session.lastFrameSize isn't set yet; the first tick
  // (~1 s later) repaints with the real frame_size so polygon
  // positions converge. Without this paint-before-tick the user
  // sees a 1 s window of no zone visuals after opening Simulieren.
  _renderZoneMaskOverlay();
}

// MJPEG fallback — used when HLS isn't supported (rare desktop
// browsers). iOS reaches HLS via the native path so this is mostly
// dead weight on mobile, but it keeps the desktop case alive.
function _attachLiveMjpegFallback(camId) {
  const imgEl = byId('lightboxImg');
  if (!imgEl) return;
  imgEl.src = `/api/camera/${encodeURIComponent(camId)}/stream.mjpg`;
  imgEl.style.display = 'block';
  _installLiveOverlayRefresh(imgEl);
}

// Bind a `load` + ResizeObserver listener that re-runs the overlay
// renderers whenever the media element's rendered size changes (first
// frame arriving, window resize, address-bar collapse on iOS, FS
// enter/exit). The polling tick repaints at ~1 Hz on its own, but
// this listener bridges the sub-second gap so polygons + bboxes sit
// on the right pixels the instant the frame paints. Idempotent —
// the install flag is per-element so a re-mount on a different
// element doesn't double-bind.
function _installLiveOverlayRefresh(mediaEl) {
  if (!mediaEl || mediaEl._zoneRefreshInstalled) return;
  const refresh = () => {
    _renderBboxOverlay();
    _renderTrailsOverlay();
    _renderZoneMaskOverlay();
  };
  // <video> uses `loadedmetadata` (videoWidth/videoHeight known);
  // <img> uses `load` (naturalWidth/Height known).
  mediaEl.addEventListener('loadedmetadata', refresh);
  mediaEl.addEventListener('load', refresh);
  try {
    const obs = new ResizeObserver(refresh);
    obs.observe(mediaEl);
    mediaEl._zoneResizeObs = obs;
  } catch {
    /* older browsers — listeners still help */
  }
  mediaEl._zoneRefreshInstalled = true;
}

function _ensureBboxOverlay() {
  let svg = byId('lightboxLiveOverlay');
  if (svg) return svg;
  // F12 · overlays now mount into the dedicated video slot inside
  // the live-detect stack so they sit over the media element only,
  // never above the title or below the timeline. Fallback to the
  // bare wrap covers a hypothetical mount before the stack scaffold
  // exists (defensive — openLiveDetect builds the stack first).
  const host = _slot('video') || byId('lightboxMediaWrap');
  if (!host) return null;
  svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'lightboxLiveOverlay';
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:16';
  host.appendChild(svg);
  return svg;
}

function _ensureTrailsOverlay() {
  let svg = byId('lightboxLiveTrails');
  if (svg) return svg;
  const host = _slot('video') || byId('lightboxMediaWrap');
  if (!host) return null;
  svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'lightboxLiveTrails';
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:15';
  host.appendChild(svg);
  return svg;
}

function _ensureZoneMaskOverlay() {
  let canvas = byId('lightboxLiveZoneMask');
  if (canvas) return canvas;
  const host = _slot('video') || byId('lightboxMediaWrap');
  if (!host) return null;
  canvas = document.createElement('canvas');
  canvas.id = 'lightboxLiveZoneMask';
  canvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:14';
  host.appendChild(canvas);
  return canvas;
}

// wv612 — single-line legend that appears under the toggle row only
// while there's at least one suppressed bbox currently on screen.
// The user sees WHY a detection didn't trigger directly on the
// canvas (dashed stroke, muted color, suffix label); the legend
// translates the visual language. Auto-hides when every visible
// bbox is in the pass state so the row stays quiet in the common
// case. Mount lives next to the overlay toggle row.
// D52 · the verdict legend (three switches: solid/dashed/filtered)
// was removed because the same semantics now live in the Detections
// panel rows themselves (PASS / unter Schwelle / gefiltert badges).
// Replaced with a single muted "<n> verworfen — antippen für
// Details" line that appears only when at least one non-pass det
// is on the canvas, and tapping it toggles the detections panel
// between "pass-only" (the default) and "all detections" view.
// State persists in localStorage so the user's preference survives.
const _DETECTIONS_EXPAND_KEY = 'tam.livedetect.detections.expanded';

function _detectionsExpanded() {
  try {
    return localStorage.getItem(_DETECTIONS_EXPAND_KEY) === '1';
  } catch {
    return false;
  }
}

function _setDetectionsExpanded(v) {
  try {
    localStorage.setItem(_DETECTIONS_EXPAND_KEY, v ? '1' : '0');
  } catch {
    /* private-mode / quota — silent */
  }
}

function _updateSuppressedHint(nonPassCount) {
  const toggleRow = byId('mvLiveToggles');
  if (!toggleRow) return;
  let hint = byId('mvLiveSuppressedHint');
  if (!nonPassCount) {
    if (hint) hint.remove();
    return;
  }
  if (!hint) {
    hint = document.createElement('button');
    hint.id = 'mvLiveSuppressedHint';
    hint.type = 'button';
    hint.className = 'mv-live-suppressed-hint';
    toggleRow.insertAdjacentElement('afterend', hint);
    hint.addEventListener('click', () => {
      const next = !_detectionsExpanded();
      _setDetectionsExpanded(next);
      // Re-render the panel immediately so the expand/collapse flips
      // without waiting for the next tick. _session.lastFullData
      // (set in _renderFrame) carries the most recent backend reply.
      if (_session?.lastFullData) _renderDetectionsPanel(_session.lastFullData);
    });
  }
  hint.textContent = `${nonPassCount} verworfen (unter Schwelle oder gefiltert) — antippen für Details`;
}

// vh729 — one-shot diagnostic. Prints the state of every visual
// layer the user can't see when Simulieren looks black. Gated by
// _session._diagLogged so the line fires exactly once per open.
// One console.warn per line so the lines stay readable in DevTools
// instead of folding into a single multi-line entry that's harder
// to copy-paste.
function _logSimDiag() {
  if (!_session || _session._diagLogged) return;
  _session._diagLogged = true;
  const imgEl = byId('lightboxImg');
  const wrap = byId('lightboxMediaWrap');
  const bboxSvg = byId('lightboxLiveOverlay');
  const zoneSvg = byId('lightboxLiveZoneMask');
  const _rect = (el) => {
    if (!el) return '0x0';
    const r = el.getBoundingClientRect();
    return `${Math.round(r.width)}x${Math.round(r.height)}`;
  };
  const _z = (el) => (el ? window.getComputedStyle(el).zIndex : 'n/a');
  const _disp = (el) => (el ? window.getComputedStyle(el).display : 'n/a');
  const _vb = (el) => (el ? el.getAttribute('viewBox') || 'n/a' : 'n/a');
  const imgSrc = imgEl ? imgEl.src || '<empty>' : '<missing>';
  console.warn(`[sim-diag] imgEl: src=${imgSrc} display=${_disp(imgEl)} rect=${_rect(imgEl)}`);
  console.warn(
    `[sim-diag] bboxSvg: viewBox=${_vb(bboxSvg)} rect=${_rect(bboxSvg)} display=${_disp(bboxSvg)} z-index=${_z(bboxSvg)}`,
  );
  console.warn(
    `[sim-diag] zoneSvg: viewBox=${_vb(zoneSvg)} rect=${_rect(zoneSvg)} display=${_disp(zoneSvg)} z-index=${_z(zoneSvg)}`,
  );
  console.warn(`[sim-diag] wrap: rect=${_rect(wrap)}`);
  console.warn(
    `[sim-diag] _session.lastDetections.length=${(_session.lastDetections || []).length}`,
  );
}

// D34 · inline 14 px glyphs for the toggle pills. Currentcolor on the
// stroke so the active/inactive colour rules in CSS apply uniformly
// — no SVG fill, only stroke, matching the rest of the chrome's
// thin-line aesthetic. Debug uses a small wrench/bug hybrid that
// reads as "tools" without pulling in a heavier icon set.
const _TOGGLE_ICONS = {
  bboxes:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/></svg>',
  trails:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 13 6 9 9 11 14 4"/><circle cx="14" cy="4" r="1.4" fill="currentColor" stroke="none"/></svg>',
  zones:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M3 5 8 2.5 13 5v6L8 13.5 3 11Z"/></svg>',
  masks:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-dasharray="3 2" aria-hidden="true"><path d="M3 5 8 2.5 13 5v6L8 13.5 3 11Z"/></svg>',
  debug:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="9" r="3.2"/><path d="M8 5.8V4M5 6 3.5 4.5M11 6l1.5-1.5M5 9H3M11 9h2M5.6 12 4 13.6M10.4 12 12 13.6"/></svg>',
};
const _TOGGLES = [
  { id: 'bboxes', label: 'Bboxes', desc: 'Erkannte Objekte als Rahmen über dem Video einblenden' },
  { id: 'trails', label: 'Trails', desc: 'Bewegungspfade jeder erkannten Spur einzeichnen' },
  { id: 'zones', label: 'Zonen', desc: 'Erkennungs-Zonen (grün) anzeigen' },
  { id: 'masks', label: 'Masken', desc: 'Ausschluss-Masken (rot) anzeigen' },
];

// Shared tooltip popover state — one element, reused. Created lazily
// on the first hover / long-press. Same dark surface the rest of
// the lightbox uses, no new colours.
let _toggleTipEl = null;
let _toggleTipHoverTimer = 0;
let _toggleTipLongPressTimer = 0;

function _ensureToggleTip() {
  if (_toggleTipEl) return _toggleTipEl;
  _toggleTipEl = document.createElement('div');
  _toggleTipEl.className = 'mv-live-toggle-tip';
  _toggleTipEl.setAttribute('role', 'tooltip');
  _toggleTipEl.hidden = true;
  document.body.appendChild(_toggleTipEl);
  return _toggleTipEl;
}

function _showToggleTip(target, text) {
  const tip = _ensureToggleTip();
  tip.textContent = text;
  tip.hidden = false;
  // Position above the pill when there's room, below otherwise.
  const r = target.getBoundingClientRect();
  const tipR = tip.getBoundingClientRect();
  const above = r.top - tipR.height - 10;
  const top = above >= 8 ? above : r.bottom + 10;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  let left = r.left + r.width / 2 - tipR.width / 2;
  left = Math.max(8, Math.min(vw - tipR.width - 8, left));
  tip.style.top = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
}

function _hideToggleTip() {
  if (_toggleTipEl) _toggleTipEl.hidden = true;
  clearTimeout(_toggleTipHoverTimer);
  clearTimeout(_toggleTipLongPressTimer);
}

// F12/F23 · populate the titlebar slot. Renders camera name + Live
// dot inline, plus a close button wired to the existing #lightboxClose
// click handler (which closeLightbox already binds in lightbox.js).
// Idempotent — innerHTML is rebuilt on every call so a re-open
// with a different camera doesn't leak the previous name.
function _mountLiveTitlebar(cameraName, camId) {
  const slot = _slot('titlebar');
  if (!slot) return;
  const name = cameraName || camId || '';
  slot.innerHTML = `
    <span class="mv-ld-titlebar-name" title="${esc(name)}">${esc(name)}</span>
    <span class="mv-ld-titlebar-live"><span class="mv-ld-titlebar-livedot" aria-hidden="true"></span>Live</span>
    <button type="button" class="mv-ld-titlebar-close" aria-label="Schließen">
      <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
        <line x1="3" y1="3" x2="15" y2="15"/><line x1="15" y1="3" x2="3" y2="15"/>
      </svg>
    </button>`;
  const closeBtn = slot.querySelector('.mv-ld-titlebar-close');
  closeBtn?.addEventListener('click', () => {
    // Delegate to the existing close button so all teardown paths
    // (closeLightbox → closeLiveDetect via window bridge) run in
    // the same order they would for an X-button click.
    byId('lightboxClose')?.click();
  });
}

function _mountOverlayToggles() {
  // F12 · toggles live in the controls slot of the live-detect stack
  // (between the video and the timeline). Fallback to the legacy
  // inner-before-stack position only when the stack isn't built
  // yet — defensive for any pre-F12 caller.
  const controlsSlot = _slot('controls');
  let row = byId('mvLiveToggles');
  if (!row) {
    row = document.createElement('div');
    row.id = 'mvLiveToggles';
    row.className = 'mv-live-toggles';
    if (controlsSlot) {
      controlsSlot.appendChild(row);
    } else {
      const inner = byId('lightboxInner');
      const stack = byId('lightboxBottomStack');
      if (!inner || !stack) return;
      inner.insertBefore(row, stack);
    }
  } else if (controlsSlot && row.parentElement !== controlsSlot) {
    // Move an existing row into the controls slot if it ended up
    // anywhere else (e.g. a re-open after a teardown that left
    // the row dangling in the inner).
    controlsSlot.appendChild(row);
  }
  // ``title`` carries the desktop-native tooltip fallback for
  // platforms where the custom hover bubble doesn't engage (the
  // browser will show its own bubble after ~700 ms). Touch devices
  // never trigger ``title`` — they get the long-press popover
  // below instead.
  // A1 · trailing Debug pill — opt-in. Mirrors the overlay-toggle
  // visual so it reads as part of the same row, but flips the
  // separate _debugDiagOn() state (persisted in localStorage)
  // instead of an _overlays.* key.
  const debugOn = _debugDiagOn();
  // D34 · compact pills. The button is the 44 px touch target (outer
  // padding lives in CSS); the inner .mv-live-toggle-chip carries the
  // visible chip styling (background, border, ≤32 px height). Pills
  // lead with an inline icon glyph + the German label, single line.
  const _chip = (id, label, desc, on) =>
    `<button type="button" class="mv-live-toggle${id === 'debug' ? ' mv-live-toggle--debug' : ''}" data-tog="${id}" data-desc="${esc(desc)}" data-on="${on ? '1' : '0'}" title="${esc(desc)}" aria-label="${esc(label)}: ${esc(desc)}"><span class="mv-live-toggle-chip"><span class="mv-live-toggle-ico" aria-hidden="true">${_TOGGLE_ICONS[id] || ''}</span><span class="mv-live-toggle-lbl">${esc(label)}</span></span></button>`;
  row.innerHTML =
    _TOGGLES.map((t) => _chip(t.id, t.label, t.desc, _overlays[t.id])).join('') +
    _chip('debug', 'Debug', 'On-screen debug diagnostic strip (geometry + bbox space)', debugOn);
  row.querySelectorAll('.mv-live-toggle').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      // Suppress click after a long-press touch: the long-press
      // already opened the tooltip, the user didn't intend to
      // toggle. Detect via a flag set by touchstart below.
      if (btn._suppressClick) {
        btn._suppressClick = false;
        ev.preventDefault();
        return;
      }
      const id = btn.dataset.tog;
      // A1 · Debug pill flips its own localStorage-backed flag,
      // NOT _overlays. Toggling it doesn't re-render the overlay
      // SVGs — only the diag strip's presence changes.
      if (id === 'debug') {
        const next = btn.dataset.on !== '1';
        btn.dataset.on = next ? '1' : '0';
        _setDebugDiag(next);
        _hideToggleTip();
        return;
      }
      _overlays[id] = !_overlays[id];
      btn.dataset.on = _overlays[id] ? '1' : '0';
      if (_DEBUG_TOGGLE) {
        console.warn(`[sim-toggle] ${id} → ${_overlays[id] ? 'ON' : 'OFF'}`);
      }
      _hideToggleTip();
      _renderBboxOverlay();
      _renderTrailsOverlay();
      _renderZoneMaskOverlay();
    });
    // Desktop hover — 300 ms before the tooltip appears.
    btn.addEventListener('pointerenter', (ev) => {
      if (ev.pointerType !== 'mouse') return;
      clearTimeout(_toggleTipHoverTimer);
      _toggleTipHoverTimer = setTimeout(() => _showToggleTip(btn, btn.dataset.desc || ''), 300);
    });
    btn.addEventListener('pointerleave', _hideToggleTip);
    // Touch long-press — ≥ 500 ms. Short-press still toggles via
    // the click handler above (touchend → click in the standard
    // event cycle); long-press shows the tooltip and suppresses
    // the synthetic click via the _suppressClick flag.
    btn.addEventListener(
      'touchstart',
      () => {
        clearTimeout(_toggleTipLongPressTimer);
        _toggleTipLongPressTimer = setTimeout(() => {
          btn._suppressClick = true;
          _showToggleTip(btn, btn.dataset.desc || '');
        }, 500);
      },
      { passive: true },
    );
    btn.addEventListener(
      'touchend',
      () => {
        clearTimeout(_toggleTipLongPressTimer);
        // Don't hide instantly — the user may want to read the
        // tooltip after lifting their finger. Auto-dismiss on the
        // next document touchstart.
      },
      { passive: true },
    );
    btn.addEventListener('touchcancel', () => {
      clearTimeout(_toggleTipLongPressTimer);
    });
  });
  // Outside-tap dismiss for the touch path.
  document.addEventListener(
    'touchstart',
    (ev) => {
      if (!_toggleTipEl || _toggleTipEl.hidden) return;
      if (ev.target.closest && ev.target.closest('.mv-live-toggle')) return;
      _hideToggleTip();
    },
    { passive: true },
  );
}

function _pinScrubberRight() {
  // Live mode has no recorded clip → no seek; pin the playhead to
  // the right edge by writing --play-pct=1 and adding an "LIVE" pill
  // overlay anchored to the scrubber row. lbRenderTrackTimeline
  // rebuilds the stack on each call so this re-pins after each refresh.
  const stack = document.querySelector('.lb-time-stack');
  if (stack) stack.style.setProperty('--play-pct', '1');
  const stackHost = byId('lightboxBottomStack');
  if (!stackHost) return;
  let pill = byId('mvLiveScrubPill');
  if (!pill) {
    pill = document.createElement('span');
    pill.id = 'mvLiveScrubPill';
    pill.className = 'mv-live-scrub-pill';
    pill.textContent = '● LIVE';
    stackHost.appendChild(pill);
  }
}

function _mountPanels() {
  // F12 · panels move into the detail slot of the live-detect
  // stack so they sit BELOW the video, controls, and timeline in
  // DOM order — no chance of rendering above the video. The legacy
  // #lightboxSettings host is still mounted by _setupVideoChrome
  // for recorded clips; we hide it in live mode so its empty body
  // doesn't add vertical whitespace.
  const settings = byId('lightboxSettings');
  if (settings) settings.hidden = true;
  const host = _slot('detail');
  if (!host) return;
  // D67 · Detections rows render directly (no tabs strip header).
  // D78 · the Diagnose accordion + Fein-Analyse fold merge into a
  // single Trace fold; D52's "<n> verworfen" hint lives in the
  // controls slot, not here. F45 · the Trace fold opens collapsed.
  host.innerHTML = `
    <div class="mv-recorded-panels">
      <div id="mvLdDetections" class="mv-ld-detections"></div>
      <div class="mv-recorded-fafold"></div>
    </div>`;
  const faHost = host.querySelector('.mv-recorded-fafold');
  const fold = renderFineAnalysisFold(faHost, null, { defaultOpen: false, live: true });
  if (_session) _session.fold = fold;
}

async function _tick() {
  const session = _session;
  if (!session) return;
  _tickState.lastTickAt = Date.now();
  try {
    session.abort?.abort();
  } catch {
    /* ignore */
  }
  session.abort = new AbortController();
  const controller = session.abort;
  const cycleStart = performance.now();
  try {
    // custom: AbortController for the live-detect polling loop —
    // each tick supersedes the previous in-flight request when the
    // camera changes or the loop stops. apiPost has no signal hook.
    const r = await fetch(
      `/api/cameras/${encodeURIComponent(session.camId)}/test-detection?no_snapshot=1`,
      { method: 'POST', signal: controller.signal },
    );
    _tickState.lastStatus = r.status;
    // B31 / B31' · late-tick guard. The session can be replaced
    // or nulled by a concurrent stopLive / cam switch between
    // fetch-issue and fetch-resolve. We count the drop and stash
    // the reason ("session_null" when nothing is mounted now,
    // "cam_mismatch" when a different cam was opened in between)
    // so a STUCK-looking TICK row + dropped=N + drop_reason tells
    // the user "responses ARE arriving, they're just landing too
    // late" — a very different fix from "loop isn't running".
    if (_session !== session) {
      _tickState.ticksDroppedLate = (_tickState.ticksDroppedLate || 0) + 1;
      _tickState.lastDropReason = _session === null ? 'session_null' : 'cam_mismatch';
      return;
    }
    let data = null;
    try {
      data = await r.json();
    } catch {
      /* keep null */
    }
    if (data?.ok) {
      _tickState.lastRespAt = Date.now();
      _tickState.lastTickError = null;
      // B23' · a successful tick clears any error banner the fold
      // may have been showing. _renderFrame's _appendTrace path
      // will repopulate the trace lines anyway, but the explicit
      // clear protects against an empty-trace ok=true response.
      _session?.fold?.setLastError?.(null);
      _renderFrame(data);
    } else {
      // B23' · ok=false response. Stash the code+message for the
      // fold's "Letzter Tick" banner. data may be null if the
      // body wasn't JSON; we still know the HTTP status and can
      // surface that. Status code goes first so screenshots are
      // greppable, message second when available.
      const code = data?.code || (r ? r.status : '?');
      const msg = data?.error || data?.message || '';
      const text = msg ? `${code} · ${msg}` : String(code);
      _tickState.lastTickError = text;
      _session?.fold?.setLastError?.(text);
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      _tickState.lastStatus = 'abort';
      return;
    }
    _tickState.lastStatus = 'neterr';
    const text = `neterr · ${(err && (err.message || String(err))) || 'unknown'}`;
    _tickState.lastTickError = text;
    _session?.fold?.setLastError?.(text);
  }
  _scheduleNext(session, performance.now() - cycleStart);
}

function _scheduleNext(session, lastCycleMs) {
  if (_session !== session) return;
  // C73 · floor depends on which stream the LAST tick used. Sub-
  // stream ticks cost less, so 500 ms is the floor on that path.
  // The fallback floor of 1 s keeps the unhealthy-camera case from
  // getting hammered. Unknown (first tick) defaults to the safer
  // 1 s floor — the second tick will tighten if sub came back.
  const src = session.lastFrameSrc || 'unknown';
  const floor = src === 'sub' ? _TICK_FLOOR_SUB_MS : _TICK_FLOOR_MAIN_MS;
  const cycleMs = Number.isFinite(lastCycleMs) ? lastCycleMs : floor;
  const projected = Math.round(cycleMs * _TICK_FACTOR);
  const delay = Math.min(_TICK_MAX_MS, Math.max(floor, projected));
  _tickState.nextTickAt = Date.now() + delay;
  _tickState.lastCycleMs = cycleMs;
  _tickState.lastFloorMs = floor;
  _tickState.lastDelayMs = delay;
  // C84 · EMA over recent cycle wall-times. First observation seeds
  // the EMA so the hold isn't 0-initialised on the very first tick;
  // subsequent ticks pull the average toward the new cycle at factor
  // 0.4 (a 5-tick effective window). Hold = clamp(2 * EMA, 800,
  // 1500): two cycles of slack absorbs one missed tick at the
  // current cadence without lingering across multiple.
  if (!Number.isFinite(_cycleEmaMs)) {
    _cycleEmaMs = cycleMs;
  } else {
    _cycleEmaMs = 0.4 * cycleMs + 0.6 * _cycleEmaMs;
  }
  _holdMsActive = Math.min(_HOLD_MS_CEILING, Math.max(_HOLD_MS_FLOOR, 2 * _cycleEmaMs));
  session.tickHandle = setTimeout(_tick, delay);
  _refreshCadenceRow();
}

function _renderFrame(data) {
  // kr493 — Simulieren v2 no longer paints data.snapshot into
  // #lightboxImg. The img element streams the continuous MJPEG
  // (set in _setupLiveChrome on mount); this tick only updates
  // the detection overlays + state. data.snapshot is still emitted
  // by the backend when ?no_snapshot is unset (other callers rely
  // on it) — Simulieren just ignores it.
  // Frame state for the bbox + zone/mask overlays.
  _session.lastFrameSize = data.frame_size || { w: 1920, h: 1080 };
  _session.lastDetections = data.detections || [];
  // D52 · cache the full backend response so an out-of-band toggle
  // (e.g. tapping the "<n> verworfen" hint) can re-render the panel
  // without waiting for the next tick.
  _session.lastFullData = data;
  // A3 · explicit coord-space disclosure from the backend (added in
  // diag by routes/coral_test_detection.py). The debug strip's bbox
  // row reads these to surface bbox_space + source/snap dims; if
  // bbox_space disagrees with the viewBox space (lastFrameSize),
  // the strip flags SPACE MISMATCH so the user sees the regression
  // immediately. All three fall back to undefined on older backends.
  const _diag = data.diag || {};
  _session.lastBboxSpace = _diag.bbox_space || null;
  _session.lastSourceFrameSize = _diag.source_frame_size || null;
  _session.lastSnapshotFrameSize = _diag.snapshot_frame_size || null;
  // C73 · remember which stream the backend served this frame from
  // so _scheduleNext can pick the right floor on the NEXT cycle.
  // Falls back to undefined when an older backend didn't send the
  // field — _scheduleNext treats that as 'unknown' → safe 1 s floor.
  if (_diag.frame_src) _session.lastFrameSrc = _diag.frame_src;
  // F2.b · one-shot per-session payload diagnostic. Answers the
  // "did the response actually carry detections" question without
  // requiring a tcpdump or the docker logs. Counts by verdict so
  // the user can spot a serialisation drop between Flask and the
  // frontend (rare but possible if response shaping went sideways).
  // Single-line console.warn (lint-allowed escape hatch).
  if (_session && !_session._frameDiagLogged) {
    _session._frameDiagLogged = true;
    const dets = _session.lastDetections;
    const np = dets.filter((d) => d.verdict === 'pass').length;
    const nb = dets.filter((d) => d.verdict === 'belowthresh').length;
    const nf = dets.filter((d) => d.verdict === 'filtered').length;
    const fs = _session.lastFrameSize;
    const gates = data.diag?.gates || {};
    console.warn(
      `[sim-frame] dets=${dets.length} pass=${np} below=${nb} filtered=${nf} ` +
        `frame_size=${fs.w}x${fs.h} diag.raw=${gates.raw ?? '?'} ` +
        `outcome=${data.ok ? 'ok' : '?'}`,
    );
  }
  // F2 · track the latest raw count from the backend's diag block so
  // _renderEmptyHint can gate the banner on Coral-really-empty rather
  // than render-buffer-empty. The held-buffer fallback briefly keeps
  // dets on screen after a raw=0 tick; the banner shouldn't appear
  // until BOTH the buffer drained AND the last tick truly had raw=0.
  _session.lastRawCount = Number(data.diag?.gates?.raw ?? data.detections?.length ?? 0);
  // gp384 — last-seen marker for the empty-state hint. Reset on
  // every tick that brings at least one detection; the banner
  // threshold (3 s) is measured from this stamp.
  if (_session.lastDetections.length) _session.lastNonEmptyTickMs = Date.now();
  // vh729 — one-shot diagnostic. Fires once per Simulieren open
  // (right after the first tick lands real data) and prints the
  // state of every visual layer the user can't see when the
  // modal looks black. Single source of truth that answers
  // "which surface is broken" without needing DevTools.
  // console.warn is the lint-allowed escape hatch
  // (eslint no-console: { allow: ['warn', 'error'] }).
  _logSimDiag();
  // Buffer detections for the swimlane window (one entry per detection
  // per tick; per-track id would be ideal here but the live tracker
  // doesn't expose ids — group by label instead).
  const now = Date.now();
  for (const d of data.detections || []) {
    _detBuffer.push({ ms: now, label: d.label, score: d.score, bbox: d.bbox, verdict: d.verdict });
  }
  // Drop entries older than the window.
  const cutoff = now - _LIVE_WINDOW_MS;
  _detBuffer = _detBuffer.filter((e) => e.ms >= cutoff);
  _renderBboxOverlay();
  _renderTrailsOverlay();
  _renderZoneMaskOverlay();
  _renderDetectionsPanel(data);
  _renderLiveSwimlane();
  _renderDiagPanel(data.diag || null);
  _appendTrace(data.decision_trace || []);
}

// C3 · in-modal diagnostic panel. Reads the structured ``diag`` block
// the test-detection endpoint now returns (see coral.py — diag.gates,
// diag.top_raw, diag.thresholds, …) and renders a compact key/value
// list inside the collapsible <details> mounted in _mountPanels. The
// summary line carries a one-glance pulse "raw=N · pass=N" so the
// operator can tell from the collapsed state whether Coral is firing
// at all without having to expand. Empty top_raw is rendered as a
// muted "Coral lieferte keine Detektion" so the absence is a positive
// signal, not a blank panel.
function _renderDiagPanel(diag) {
  // D78 · the Diagnose accordion is gone — content now lives inside
  // the merged "Trace" fold. We push the structured HTML through
  // _session.fold.setHeader() and update the summary suffix on
  // _session.fold.setSummaryExtra() so the collapsed line carries
  // "raw=N · pass=N · <verdict>".
  const fold = _session?.fold;
  if (!fold) return;
  if (!diag) {
    fold.setHeader?.('');
    fold.setSummaryExtra?.('');
    return;
  }
  const fs = diag.frame_size || { w: 0, h: 0 };
  const gates = diag.gates || {};
  const tops = Array.isArray(diag.top_raw) ? diag.top_raw : [];
  const thresholds = diag.thresholds || {};
  const perClass = thresholds.per_class || {};
  const perClassStr = Object.keys(perClass).length
    ? Object.entries(perClass)
        .map(([k, v]) => `${esc(k)}=${Number(v).toFixed(2)}`)
        .join(' · ')
    : '(keine Overrides)';
  const inferStr = Number(diag.inference_ms) > 0 ? ` · ${Math.round(diag.inference_ms)} ms` : '';
  const coralStr = diag.coral_available ? `verfügbar${inferStr}` : 'nicht verfügbar';
  const topRows = tops.length
    ? tops
        .map((t) => {
          const pct = Math.round((Number(t.score) || 0) * 100);
          return `<span class="mv-ld-diag-top-item">${esc(String(t.label))} ${pct}%</span>`;
        })
        .join('')
    : `<span class="mv-ld-diag-top-empty">Coral lieferte keine Detektion für diesen Frame</span>`;
  const objFilter = Array.isArray(diag.object_filter) ? diag.object_filter : [];
  const objFilterStr = objFilter.length
    ? objFilter.map((c) => esc(String(c))).join(' · ')
    : '(alle Klassen)';
  const profStr = diag.validator_profile ? esc(String(diag.validator_profile)) : '—';
  const headerHtml = `
    <div class="mv-ld-diag-body">
      <div class="mv-ld-diag-row">
        <span class="mv-ld-diag-key">Quelle</span>
        <span class="mv-ld-diag-val">${esc(diag.frame_src || '?')} · ${fs.w}×${fs.h} · ${Math.round(Number(diag.frame_age_ms) || 0)} ms</span>
      </div>
      <div class="mv-ld-diag-row">
        <span class="mv-ld-diag-key">Coral</span>
        <span class="mv-ld-diag-val">${esc(coralStr)}</span>
      </div>
      <div class="mv-ld-diag-row mv-ld-diag-gates">
        <span class="mv-ld-diag-key">Gates</span>
        <span class="mv-ld-diag-gate" data-kind="raw">raw=${Number(gates.raw || 0)}</span>
        <span class="mv-ld-diag-gate" data-kind="pass">pass=${Number(gates.pass || 0)}</span>
        <span class="mv-ld-diag-gate" data-kind="belowthresh">unter Schwelle=${Number(gates.belowthresh || 0)}</span>
        <span class="mv-ld-diag-gate" data-kind="filtered">gefiltert=${Number(gates.filtered || 0)}</span>
      </div>
      <div class="mv-ld-diag-row mv-ld-diag-top">
        <span class="mv-ld-diag-key">Top 3 raw</span>
        <div class="mv-ld-diag-top-list">${topRows}</div>
      </div>
      <div class="mv-ld-diag-row">
        <span class="mv-ld-diag-key">Filter</span>
        <span class="mv-ld-diag-val">${objFilterStr}</span>
      </div>
      <div class="mv-ld-diag-row">
        <span class="mv-ld-diag-key">Profil</span>
        <span class="mv-ld-diag-val">${profStr}</span>
      </div>
      <div class="mv-ld-diag-row">
        <span class="mv-ld-diag-key">Schwellen</span>
        <span class="mv-ld-diag-val">global=${Number(thresholds.global || 0).toFixed(2)} · ${perClassStr}</span>
      </div>
    </div>`;
  fold.setHeader?.(headerHtml);
  // Compact verdict for the collapsed summary. Mirrors the existing
  // Diagnose-pulse semantics: alarm = at least one pass, below = no
  // pass but at least one belowthresh, filtered = only filtered,
  // — = nothing at all.
  const raw = Number(gates.raw || 0);
  const pass = Number(gates.pass || 0);
  const below = Number(gates.belowthresh || 0);
  const filtered = Number(gates.filtered || 0);
  let verdict;
  if (pass > 0) verdict = 'alarm';
  else if (below > 0) verdict = 'below';
  else if (filtered > 0) verdict = 'filtered';
  else verdict = '—';
  fold.setSummaryExtra?.(`raw=${raw} · pass=${pass} · ${verdict}`);
}

// A1 · in-modal debug strip — opt-in via the "Debug" pill in the
// toggle row, persisted in localStorage so it stays sticky across
// sessions. When OFF the strip is fully removed from the DOM
// (no hidden offscreen renders, no extra rAF work). When ON, every
// _renderBboxOverlay/_renderTrailsOverlay/_renderZoneMaskOverlay
// call piggybacks on the existing render path and writes its
// state into the strip — no new timers. Rich fields per row so
// the operator can screenshot the strip on iPhone and read the
// failure mode without DevTools (see A1 spec).
//
// Rows: bbox / trails / zonemask / media (always-on geometry dump)
// + position-fail (sticky when an SVG ends up 0×0)
// + paint-fail   (sticky when SVG sized but first child collapsed).
const _DEBUG_LS_KEY = 'tam.livedetect.debug';
const _diagState = {
  bbox: null,
  trails: null,
  zonemask: null,
  media: null,
  // B7 · tick lifecycle row. Built from the raw _tickState numbers
  // below so the strip never has to query setTimeout / AbortController
  // internals; just reads the timestamps we wrote on entry/response/
  // schedule. _refreshTickRow() computes the ms-ago deltas every
  // hold-refresh tick so the row stays current even when the tick
  // loop is wedged (i.e. exactly when the user needs the answer).
  tick: null,
  posFail: null,
  // A4 · sticky "SVG sized but child collapsed" diagnostic. Separate
  // from posFail because the two failure modes look identical on
  // screen (no bbox visible) but need different fixes — posFail
  // means the SVG layout never happened, paintFail means the
  // children rendered but landed off-canvas or with 0×0 geometry.
  paintFail: null,
  // B12' · always-on MOUNT row. Holds the most recent
  // openLiveDetect lifecycle record (chrome_mounted,
  // first_tick_scheduled, error). Painted muted on success, red on
  // error. Cleared on next openLiveDetect.
  mount: null,
  // C73/C84 · cadence row. Tracks the adaptive floor (500 ms on
  // sub-stream, 1000 ms on main_fallback), the most recent cycle
  // wall time, and the dynamic bbox hold derived from the EMA of
  // recent cycles. Single line, always-on while debug is enabled.
  cadence: null,
};

// B7 · raw tick-loop state. Owned by the tick lifecycle, read by the
// debug strip. Reset on every openLiveDetect call.
const _tickState = {
  lastTickAt: 0, // _tick() entered
  lastRespAt: 0, // last successful fetch resolved
  lastStatus: '—', // HTTP status code (200/503) or 'abort'/'neterr'
  nextTickAt: 0, // setTimeout deadline
  startedAt: 0, // openLiveDetect wall-clock
  startedWithCamId: '', // camId we attempted to start against
  tornDownPrev: false, // openLiveDetect torn down a prior session
};

function _debugDiagOn() {
  try {
    return localStorage.getItem(_DEBUG_LS_KEY) === '1';
  } catch {
    return false;
  }
}

function _setDebugDiag(on) {
  try {
    if (on) localStorage.setItem(_DEBUG_LS_KEY, '1');
    else localStorage.removeItem(_DEBUG_LS_KEY);
  } catch {
    /* private-mode / quota — silent */
  }
  if (!on) {
    const strip = byId('mvSimDiagStrip');
    if (strip) strip.remove();
    _diagState.bbox = null;
    _diagState.trails = null;
    _diagState.zonemask = null;
    _diagState.media = null;
    _diagState.posFail = null;
    _diagState.paintFail = null;
    _diagState.mount = null;
    _diagState.tick = null;
    _diagState.cadence = null;
  } else {
    // Render now if we have any state from the in-progress render
    // cycle; otherwise the next overlay-render tick will paint it.
    _renderDiagStrip();
    // Force a media-row immediately so the strip isn't empty on
    // first activation.
    _refreshMediaRow();
    _renderDiagStrip();
  }
}

// F12/F45 · debug strip is now an in-flow child of the .mv-ld-detail
// slot (no absolute positioning, no localStorage persistence). It
// flows after the Detections summary + the Trace fold in the detail
// stack at the bottom of the live-detect mount, and is always
// collapsed on each mount. The user can expand it within the
// session; closing live-detect resets the state.

function _ensureDiagStrip() {
  if (!_debugDiagOn()) return null;
  let strip = byId('mvSimDiagStrip');
  if (strip) return strip;
  // F12 · debug strip moves into the .mv-ld-detail slot at the
  // bottom of the live-detect stack. Previously it was absolutely
  // positioned inside the wrap (C56), which on iOS Safari ended up
  // rendering ABOVE the live video — the strip was the first
  // painted child and the wrap's flex layout pushed the video
  // below it. As an in-flow child of the detail slot, the strip
  // flows naturally after the Detections panel + Trace fold.
  // F45 · always collapsed on mount; the C56 persistence is gone.
  const host = _slot('detail') || byId('lightboxMediaWrap');
  if (!host) return null;
  strip = document.createElement('div');
  strip.id = 'mvSimDiagStrip';
  strip.className = 'mv-sim-diag-strip';
  strip.dataset.collapsed = '1';
  strip.innerHTML = `
    <button type="button" class="mv-sim-diag-head" aria-expanded="false">
      <span class="mv-sim-diag-summary" id="mvSimDiagSummary"></span>
      <span class="mv-sim-diag-chevron" aria-hidden="true">▾</span>
    </button>
    <div class="mv-sim-diag-body" id="mvSimDiagBody"></div>`;
  host.appendChild(strip);
  // F45 · header click toggles collapsed/expanded within the
  // current session ONLY — no localStorage persistence. Re-opening
  // live-detect starts collapsed again so the chrome stays quiet
  // unless the operator explicitly drills in this session.
  const header = strip.querySelector('.mv-sim-diag-head');
  header?.addEventListener('click', () => {
    const collapsed = strip.dataset.collapsed === '1';
    const next = !collapsed;
    strip.dataset.collapsed = next ? '1' : '0';
    header.setAttribute('aria-expanded', next ? 'false' : 'true');
  });
  return strip;
}

// One row per kind. Block layout (NOT flex/inline) so on iPhone
// width each k=v pair sits on its own line; CSS handles font sizes
// (key 10 px, value 11 px) and wrap-free overflow. Mismatch flag
// surfaces an amber border so the user spots it at a glance.
function _renderDiagStripLine(kind, fields, opts = {}) {
  if (!fields) return '';
  const pairs = Object.entries(fields)
    .map(
      ([k, v]) =>
        `<div class="mv-sim-diag-pair"><span class="mv-sim-diag-k">${esc(k)}</span><span class="mv-sim-diag-eq">=</span><span class="mv-sim-diag-v">${esc(String(v))}</span></div>`,
    )
    .join('');
  const trailing = opts.trailing ? `<div class="mv-sim-diag-tag">${esc(opts.trailing)}</div>` : '';
  const flagAttr = opts.flag ? ` data-flag="${esc(opts.flag)}"` : '';
  return `<div class="mv-sim-diag-row" data-kind="${esc(kind)}"${flagAttr}><div class="mv-sim-diag-kind">${esc(kind)}</div>${pairs}${trailing}</div>`;
}

function _renderDiagStrip() {
  const strip = _ensureDiagStrip();
  if (!strip) return;
  // B7 · refresh the tick row on every paint so the deltas stay
  // truthful even when the rest of the strip is updating for other
  // reasons. Cheap (date math + computed status flag).
  _refreshTickRow();
  _refreshCadenceRow();
  // B12' · MOUNT row split out from the inline fields so the row can
  // appear at the TOP of the strip even on the success path (muted)
  // — drawing the eye first to "did the mount succeed" before
  // anything else. The _err flag picked from the record promotes
  // the row to red without using the trailing-tag mechanism.
  let mountRow = '';
  if (_diagState.mount) {
    const m = _diagState.mount;
    const fields = {
      started_at: m.started_at,
      started_with_camId: m.started_with_camId,
      torn_down_prev: m.torn_down_prev,
      chrome_mounted: m.chrome_mounted,
      first_tick_scheduled: m.first_tick_scheduled,
    };
    if (m.error) fields.error = m.error;
    const opts = m._err ? { flag: 'mount-fail' } : {};
    mountRow = _renderDiagStripLine('mount', fields, opts);
  }
  const rows = [
    mountRow,
    _renderDiagStripLine('tick', _diagState.tick?.fields, _diagState.tick?.opts || {}),
    _renderDiagStripLine('cadence', _diagState.cadence?.fields, _diagState.cadence?.opts || {}),
    _renderDiagStripLine('bbox', _diagState.bbox?.fields, _diagState.bbox?.opts || {}),
    _renderDiagStripLine('trails', _diagState.trails?.fields, _diagState.trails?.opts || {}),
    _renderDiagStripLine('zonemask', _diagState.zonemask?.fields, _diagState.zonemask?.opts || {}),
    _renderDiagStripLine('media', _diagState.media?.fields, _diagState.media?.opts || {}),
  ].filter(Boolean);
  if (_diagState.posFail) {
    rows.push(_renderDiagStripLine('position-fail', _diagState.posFail));
  }
  if (_diagState.paintFail) {
    rows.push(_renderDiagStripLine('paint-fail', _diagState.paintFail));
  }
  // C56 · the body holds the full multi-row dump; the summary line
  // at the top is the one-glance "TICK <status> · BBOX dets=<n> ·
  // MEDIA <branch> · MOUNT <ok|err>" the user sees when the strip is
  // collapsed. Both are written here so they stay synced on every
  // tick refresh.
  const body = strip.querySelector('.mv-sim-diag-body') || strip;
  body.innerHTML = rows.join('');
  const summaryEl = strip.querySelector('.mv-sim-diag-summary');
  if (summaryEl) summaryEl.textContent = _buildDebugSummary();
}

// C56 · compact summary string for the collapsed header. Order is
// fixed (TICK · BBOX · MEDIA · MOUNT) so a screenshot reader knows
// where to look for the primary signal. Truncation handled by CSS
// (text-overflow: ellipsis).
function _buildDebugSummary() {
  const parts = [];
  const tickFields = _diagState.tick?.fields || {};
  const tickFlag = _diagState.tick?.opts?.flag;
  const tickStatus = tickFlag === 'tick-stuck' ? 'STUCK' : tickFlag === 'tick-warn' ? 'WARN' : 'ok';
  parts.push(`TICK ${tickStatus}`);
  const bboxFields = _diagState.bbox?.fields || {};
  if ('dets' in bboxFields) parts.push(`BBOX dets=${bboxFields.dets}`);
  const mediaFields = _diagState.media?.fields || {};
  if ('branch' in mediaFields) parts.push(`MEDIA ${mediaFields.branch}`);
  if (_diagState.mount) parts.push(`MOUNT ${_diagState.mount._err ? 'err' : 'ok'}`);
  return parts.join(' · ');
}

function _updateDiagStrip(kind, fields, opts = {}) {
  if (!_debugDiagOn()) return;
  if (kind === 'position-fail') {
    _diagState.posFail = fields;
  } else if (kind === 'paint-fail') {
    _diagState.paintFail = fields;
  } else if (kind in _diagState) {
    _diagState[kind] = { fields, opts };
  }
  _renderDiagStrip();
}

// A1 · gather the rich bbox-row fields used by the debug strip.
// Reads SVG geometry + computed style + the mediaEl
// _positionSvgOverImage would pick + fittedRect(). A3 extends this
// with bbox_space / source / snap and the space-mismatch flag.
function _collectBboxDiagFields(svg, fs) {
  const wrap = byId('lightboxMediaWrap');
  const videoEl = byId('lightboxVideo');
  const imgEl = byId('lightboxImg');
  const usingVideo = videoEl && videoEl.style.display !== 'none' && videoEl.videoWidth > 0;
  const mediaEl = usingVideo ? videoEl : imgEl && imgEl.style.display !== 'none' ? imgEl : null;
  const mediaTag = mediaEl ? (mediaEl === videoEl ? 'video' : 'img') : 'null';
  const wrapBox = wrap?.getBoundingClientRect();
  const svgRect = svg.getBoundingClientRect();
  const cs = window.getComputedStyle(svg);
  let mediaDims = 'n/a';
  let fitDims = 'n/a';
  if (mediaEl) {
    const nW = mediaEl.naturalWidth || 0;
    const nH = mediaEl.naturalHeight || 0;
    const vW = mediaEl.videoWidth || 0;
    const vH = mediaEl.videoHeight || 0;
    const cW = mediaEl.clientWidth || 0;
    const cH = mediaEl.clientHeight || 0;
    mediaDims = `nat=${nW}×${nH} vid=${vW}×${vH} cli=${cW}×${cH}`;
    try {
      const fit = fittedRect(mediaEl);
      fitDims = `${Math.round(fit.w)}×${Math.round(fit.h)}@${Math.round(fit.x)},${Math.round(fit.y)}`;
    } catch {
      fitDims = 'err';
    }
  }
  const source = _session?.lastSourceFrameSize;
  const snap = _session?.lastSnapshotFrameSize;
  const bboxSpace = _session?.lastBboxSpace || '?';
  // A3 · viewBox is set from _session.lastFrameSize, which equals
  // the top-level data.frame_size — the backend's stated bbox-space
  // size. bbox_space says which space the bbox tuples actually use.
  // The two should match: "source" ↔ source == frame_size,
  // "snapshot" ↔ snap == frame_size. If they don't, the response is
  // internally inconsistent — flag SPACE MISMATCH so the user sees
  // it instead of staring at invisible boxes.
  let mismatch = false;
  if (bboxSpace === 'source' && source && (source.w !== fs.w || source.h !== fs.h)) {
    mismatch = true;
  } else if (bboxSpace === 'snapshot' && snap && (snap.w !== fs.w || snap.h !== fs.h)) {
    mismatch = true;
  }
  const fields = {
    dets: (_session.lastDetections || []).length,
    raw: _session.lastRawCount ?? '?',
    bbox_space: bboxSpace,
    source: source ? `${source.w}×${source.h}` : 'n/a',
    snap: snap ? `${snap.w}×${snap.h}` : 'n/a',
    viewBox: `${fs.w}×${fs.h}`,
    svgRect: `${Math.round(svgRect.width)}×${Math.round(svgRect.height)}@${Math.round(svgRect.left - (wrapBox?.left || 0))},${Math.round(svgRect.top - (wrapBox?.top || 0))}`,
    zIndex: cs.zIndex,
    display: cs.display,
    bboxesOn: _overlays.bboxes ? 'true' : 'false',
    media: mediaTag,
    mediaDims,
    fit: fitDims,
  };
  const opts = mismatch ? { flag: 'space-mismatch', trailing: 'SPACE MISMATCH' } : {};
  return { fields, opts };
}

// B7 · paint the tick lifecycle row from the raw _tickState numbers.
// Always runs (no-ops when debug strip is OFF). The row carries the
// single primary signal: STUCK in red means the loop is wedged. The
// values themselves let the user tell apart "never started" (Infinity
// since last tick) from "started but request hangs" (lastTickAt
// recent but no lastRespAt) from "ticking but each tick errors"
// (lastTickAt+lastRespAt both recent, lastStatus 503/neterr).
function _refreshTickRow() {
  if (!_debugDiagOn()) return;
  const now = Date.now();
  const sessionOn = !!_session;
  // B7' · field names match the new spec exactly so the iPhone
  // screenshot can be diffed against the prompt without translating:
  //   sinceTick  → last_tick_started_ms_ago
  //   sinceResp  → last_resp_ok_ms_ago (only set on ok=true responses)
  //   mountedAt  → mounted_ms_ago      (drives the "never-resp + age"
  //                                     STUCK trigger below)
  const sinceTick = _tickState.lastTickAt ? now - _tickState.lastTickAt : Infinity;
  const sinceResp = _tickState.lastRespAt ? now - _tickState.lastRespAt : Infinity;
  const sinceMount = _tickState.startedAt ? now - _tickState.startedAt : Infinity;
  const nextIn = _tickState.nextTickAt ? Math.max(0, _tickState.nextTickAt - now) : null;
  const abortPending = !!(
    _session &&
    _session.abort &&
    _session.abort.signal &&
    !_session.abort.signal.aborted
  );
  // STUCK rules (B7'):
  //   red  · session=="mounted" AND (
  //             last_tick_started_ms_ago > 15000
  //           OR last_resp_ok_ms_ago === Infinity AND mounted_ms_ago > 8000
  //         )
  //   amber· session=="mounted" AND last_tick_started_ms_ago > 5000
  // The "Infinity + 8 s mount age" rule catches Session 1's pattern:
  // chrome mounted, tick fires repeatedly, but no ok response ever
  // — by 8 s after openLiveDetect we know that's the real fail mode.
  let flag = null;
  let trailing = '';
  if (sessionOn) {
    const neverResp = !Number.isFinite(sinceResp);
    if (sinceTick > 15_000 || (neverResp && sinceMount > 8_000)) {
      flag = 'tick-stuck';
      trailing = 'STUCK';
    } else if (sinceTick > 5_000) {
      flag = 'tick-warn';
    }
  }
  const fmtMs = (v) => (Number.isFinite(v) ? String(Math.round(v)) : '∞');
  const fields = {
    session: sessionOn ? 'mounted' : 'idle',
    camId: _tickState.startedWithCamId || '—',
    last_tick_started_ms_ago: fmtMs(sinceTick),
    last_resp_ok_ms_ago: fmtMs(sinceResp),
    last_status: String(_tickState.lastStatus ?? '—'),
    next_in_ms: nextIn == null ? '—' : String(nextIn),
    camId_match: sessionOn && _session.camId === _tickState.startedWithCamId ? 'true' : 'false',
    abort_pending: abortPending ? 'true' : 'false',
    mounted_ms_ago: fmtMs(sinceMount),
  };
  // B31' · counter + reason for the most recent silent drop. Both
  // hidden when N=0 so the healthy case stays clean.
  if ((_tickState.ticksDroppedLate || 0) > 0) {
    fields.dropped = String(_tickState.ticksDroppedLate);
    if (_tickState.lastDropReason) fields.drop_reason = _tickState.lastDropReason;
  }
  const opts = flag ? { flag, trailing } : {};
  _diagState.tick = { fields, opts };
}

// C73 · paint the CADENCE row from _tickState's last-scheduled
// snapshot + the running EMA. Compact one-row dump (floor / cycle /
// next / mode / hold) — keeps the strip readable on iPhone width.
// Called from _scheduleNext and from _renderDiagStrip so the row
// stays current even when the loop is wedged.
function _refreshCadenceRow() {
  if (!_debugDiagOn()) return;
  const src = _session?.lastFrameSrc || 'unknown';
  const mode = src === 'sub' ? 'sub-fast' : src === 'main_fallback' ? 'main-slow' : 'unknown';
  const floor = _tickState.lastFloorMs;
  const cycle = _tickState.lastCycleMs;
  const delay = _tickState.lastDelayMs;
  const fields = {
    mode,
    floor_ms: Number.isFinite(floor) ? String(Math.round(floor)) : '—',
    last_cycle_ms: Number.isFinite(cycle) ? String(Math.round(cycle)) : '—',
    next_in_ms: Number.isFinite(delay) ? String(Math.round(delay)) : '—',
    hold_ms: Number.isFinite(_holdMsActive) ? String(Math.round(_holdMsActive)) : '—',
    avg_cycle_ms: Number.isFinite(_cycleEmaMs) ? String(Math.round(_cycleEmaMs)) : '—',
  };
  _diagState.cadence = { fields, opts: {} };
}

// Pull current wrap/img/video geometry into the "media" row. Called
// from each overlay render path so the row stays in sync with the
// other three. Cheap (three getBoundingClientRect calls).
function _refreshMediaRow() {
  if (!_debugDiagOn()) return;
  const wrap = byId('lightboxMediaWrap');
  const imgEl = byId('lightboxImg');
  const videoEl = byId('lightboxVideo');
  const _box = (el) => {
    if (!el) return 'n/a';
    const r = el.getBoundingClientRect();
    return `${Math.round(r.width)}×${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)}`;
  };
  // B19 · include the branch _positionSvgOverImage last took so a
  // screenshot tells us instantly whether the SVG was sized off the
  // img-rect, video-rect, or one of the wrap fallbacks. videoReady
  // surfaces the readyState gate the new validity check uses; B19'
  // adds video_rejected / img_rejected as the explicit "why" string
  // for the screenshot reader.
  const videoReady = videoEl
    ? `rs=${videoEl.readyState || 0} vW=${videoEl.videoWidth || 0}`
    : 'n/a';
  const fields = {
    wrap: _box(wrap),
    img: imgEl ? `${_box(imgEl)} disp=${window.getComputedStyle(imgEl).display}` : 'n/a',
    video: videoEl ? `${_box(videoEl)} disp=${window.getComputedStyle(videoEl).display}` : 'n/a',
    videoReady,
    branch: _lastMediaBranch || '—',
  };
  if (_lastVideoRejected) fields.video_rejected = _lastVideoRejected;
  if (_lastImgRejected) fields.img_rejected = _lastImgRejected;
  _diagState.media = { fields, opts: {} };
}

function _renderBboxOverlay() {
  const svg = _ensureBboxOverlay();
  if (!svg || !_session) return;
  svg.style.display = _overlays.bboxes ? 'block' : 'none';
  if (!_overlays.bboxes) {
    svg.innerHTML = '';
    _updateSuppressedHint(0);
    _renderEmptyHint(false);
    return;
  }
  const fs = _session.lastFrameSize || { w: 1920, h: 1080 };
  svg.setAttribute('viewBox', `0 0 ${fs.w} ${fs.h}`);
  _positionSvgOverImage(svg);
  // A1/A3 · refresh the debug strip on every render so the user
  // can screenshot it on iPhone without DevTools. No-op when the
  // Debug pill is off — _updateDiagStrip / _refreshMediaRow gate on
  // _debugDiagOn() so non-debug sessions pay zero cost.
  _refreshMediaRow();
  if (_debugDiagOn()) {
    const fields = _collectBboxDiagFields(svg, fs);
    _updateDiagStrip('bbox', fields.fields, fields.opts);
  }
  const rect = svg.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    _updateDiagStrip('position-fail', {
      svg: svg.id,
      svgRect: `${Math.round(rect.width)}×${Math.round(rect.height)}`,
    });
    svg.innerHTML = '';
    return;
  }
  // A1 · clear any sticky position-fail from the last cycle now
  // that the SVG has a real size again. Same for paint-fail
  // (rebuilt below if needed).
  if (_diagState.posFail) {
    _diagState.posFail = null;
    _renderDiagStrip();
  }
  // gp384 / C84 — hold-time merge. Prefer the live tick's detections
  // (full opacity, _holdAge=0). If the tick is empty, fall back to
  // the most recent detection per label from _detBuffer — each
  // entry carries its age so the render can fade the bbox out over
  // the active hold-time (dynamic per cadence — see C84). One entry
  // per label is enough; older entries on the same label are
  // dominated by the most-recent one's opacity anyway. holdMs falls
  // back to the legacy 1500 ms ceiling until the first cycle EMA
  // observation lands, so the first tick still gets a sensible hold.
  const now = Date.now();
  const holdMs = Number.isFinite(_holdMsActive) ? _holdMsActive : _HOLD_MS_CEILING;
  const liveDets = _session.lastDetections || [];
  let renderDets;
  if (liveDets.length) {
    renderDets = liveDets.map((d) => ({ ...d, _holdAge: 0 }));
  } else {
    const seen = new Set();
    const held = [];
    for (let i = _detBuffer.length - 1; i >= 0; i--) {
      const e = _detBuffer[i];
      const age = now - e.ms;
      if (age > holdMs) break; // _detBuffer is push-order → older entries follow
      if (seen.has(e.label)) continue; // one bbox per label, most-recent wins
      seen.add(e.label);
      held.push({
        label: e.label,
        score: e.score,
        bbox: e.bbox,
        verdict: e.verdict,
        _holdAge: age,
      });
    }
    renderDets = held;
  }
  // wv612 — verdict-aware rendering. Backend's test-detection
  // endpoint already tags each detection with a verdict — pass /
  // belowthresh / filtered (class not in object_filter). Render each
  // state with a visually distinct style so the user can SEE which
  // detections passed the gates and which were rejected:
  //   pass         → solid stroke, full opacity, "label · NN %"
  //   belowthresh  → solid stroke at 0.55 opacity, "label · unter Schwelle"
  //   filtered     → grey-toned dashed stroke at 0.45 opacity,
  //                  "label · gefiltert" (class-disabled by filter)
  // A small legend below the toggle row only renders while at least
  // one non-pass bbox is currently on screen.
  let _hasSuppressed = false;
  svg.innerHTML = renderDets
    .map((d) => {
      const baseC = colors[d.label] || colors.unknown;
      const isPass = d.verdict === 'pass';
      const isBelow = d.verdict === 'belowthresh';
      const isFiltered = !isPass && !isBelow; // 'filtered' or absent
      if (!isPass) _hasSuppressed = true;
      const c = isFiltered ? '#94a3b8' : baseC; // slate-grey for class-filtered
      const verdictOp = isPass ? 1 : isBelow ? 0.55 : 0.45;
      const holdMul = d._holdAge > 0 ? Math.max(0, 1 - d._holdAge / holdMs) : 1;
      const op = verdictOp * holdMul;
      const dash = isFiltered ? '12 8' : isBelow ? '6 6' : 'none';
      const [x, y, bw, bh] = d.bbox;
      const lbl = OBJ_LABEL[d.label] || d.label;
      const suffix = isPass
        ? `${Math.round((d.score || 0) * 100)} %`
        : isBelow
          ? 'unter Schwelle'
          : 'gefiltert';
      const txt = `${lbl} · ${suffix}`;
      const stroke = _selectedLabel === d.label ? 5 : 3;
      const dashAttr = dash === 'none' ? '' : ` stroke-dasharray="${dash}"`;
      return `<g opacity="${op.toFixed(2)}" data-label="${esc(d.label)}" style="pointer-events:auto;cursor:pointer">
      <rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="none" stroke="${c}" stroke-width="${stroke}" vector-effect="non-scaling-stroke"${dashAttr}/>
      <text x="${x + 4}" y="${y + 20}" fill="${c}" font-size="14" font-family="system-ui, sans-serif" font-weight="700" paint-order="stroke" stroke="rgba(0,0,0,0.7)" stroke-width="3">${esc(txt)}</text>
    </g>`;
    })
    .join('');
  // D52 · count non-pass dets currently on the canvas so the
  // muted "<n> verworfen — antippen" line can show. _hasSuppressed
  // already flagged the existence; the count is the bare arithmetic.
  const _nonPass = renderDets.reduce((n, d) => n + (d.verdict === 'pass' ? 0 : 1), 0);
  _updateSuppressedHint(_nonPass);
  _renderEmptyHint(renderDets.length === 0);
  // A4 · paint-fail check. The SVG itself has size > 0 (we'd have
  // hit the position-fail branch above otherwise), but the painted
  // children might still collapse to 0×0 — happens when the bbox
  // coords land outside the viewBox or when stroke-only rects had
  // their geometry attrs clobbered. Differentiates "SVG sized
  // correctly but children collapsed" from "SVG never got
  // dimensions" — same visual failure, different fix.
  if (renderDets.length > 0) {
    const firstG = svg.firstElementChild;
    const childRect = firstG ? firstG.getBoundingClientRect() : null;
    if (childRect && childRect.width === 0 && childRect.height === 0) {
      const first = renderDets[0];
      const fs = _session.lastFrameSize || { w: 0, h: 0 };
      _updateDiagStrip('paint-fail', {
        childRect: '0×0',
        parentRect: `${Math.round(rect.width)}×${Math.round(rect.height)}`,
        viewBox: `${fs.w}×${fs.h}`,
        bboxRaw: `[${(first.bbox || []).join(',')}]`,
      });
    } else if (_diagState.paintFail) {
      _diagState.paintFail = null;
      _renderDiagStrip();
    }
  } else if (_diagState.paintFail) {
    _diagState.paintFail = null;
    _renderDiagStrip();
  }
  // Click handler — toggle detail-pill selection.
  svg.style.pointerEvents = 'auto';
  svg.querySelectorAll('[data-label]').forEach((g) => {
    g.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const lbl = g.dataset.label;
      _selectedLabel = _selectedLabel === lbl ? null : lbl;
      _renderBboxOverlay();
      _renderDetailPill();
    });
  });
}

// F2 · empty-state banner. Mounts a small dark-glass pill at the
// top of the media wrap when:
//   1. the bbox layer is enabled, and
//   2. the latest BACKEND tick truly returned raw=0 from Coral
//      (i.e. Coral found nothing — not "all dets below threshold"),
//      and
//   3. no held bbox is still visible from a previous tick, and
//   4. it's been at least _EMPTY_HINT_MS since the last non-empty
//      tick (or since live-detect mount if no tick has ever
//      brought detections).
// The (2) gate is the F2 tightening: previously the banner could
// appear whenever the render buffer was empty even though backend
// might have returned belowthresh/filtered dets in the most recent
// tick. Reading data.diag.gates.raw directly via _session
// .lastRawCount makes the banner's meaning exactly "Coral found
// nothing for this frame". Removes itself when any condition
// flips back. Idempotent.
function _renderEmptyHint(noBboxes) {
  // F12 · banner overlays the video slot only.
  const wrap = _slot('video') || byId('lightboxMediaWrap');
  if (!wrap) return;
  let banner = byId('mvLdEmptyHint');
  const remove = () => {
    if (banner) banner.remove();
  };
  if (!noBboxes || !_overlays.bboxes || !_session) {
    remove();
    return;
  }
  // F2 · last raw count must be 0 to show the banner. A
  // belowthresh-only tick (raw>0 pass=0) leaves lastRawCount>0;
  // even if every bbox is currently faded out, the banner stays
  // suppressed because Coral DID find something — the threshold
  // just rejected it. Default 0 (no tick yet) → mount-time silence
  // is governed by the lastSeen condition below.
  if ((_session.lastRawCount ?? 0) > 0) {
    remove();
    return;
  }
  const now = Date.now();
  const lastSeen = _session.lastNonEmptyTickMs || _session.startedMs || now;
  if (now - lastSeen < _EMPTY_HINT_MS) {
    remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'mvLdEmptyHint';
    banner.className = 'mv-ld-empty-hint';
    banner.textContent = 'Coral findet aktuell nichts · der Detektor analysiert weiter';
    wrap.appendChild(banner);
  }
}

// Position an overlay SVG to cover the IMAGE's visible rect, not the
// whole #lightboxMediaWrap. The image uses object-fit:contain so its
// on-screen rect is letterboxed inside the wrap; without this
// correction every overlay SVG (bboxes / zones / masks) covers the
// wrap and preserveAspectRatio:meet letterboxes the content inside
// the WRAP bounds — polygons land tiny in the corner on 32:9
// monitors and miss the actual pixels. fittedRect is the canonical
// "where does the media really sit inside this element" helper;
// same math drives the canvas zone overlay in the Mediathek +
// Wetter-TL paths.
function _positionSvgOverImage(svg) {
  // Pick whichever media element is currently visible. HLS path
  // uses `<video>` (iOS + desktop hls.js); MJPEG fallback uses
  // `<img>`. Both honour object-fit:contain so the SVG must align
  // to whichever element actually carries the pixels.
  //
  // B19' · video valid only when display!='none' AND videoWidth>0
  // AND readyState>=2 (HAVE_CURRENT_DATA — actual frame decoded,
  // not just metadata). Image valid unless naturalWidth==0 AND
  // complete==false (browser is still fetching the first byte).
  // Rejection reasons are stashed so the MEDIA debug row can show
  // exactly WHY a candidate was skipped on a half-mounted session.
  const videoEl = byId('lightboxVideo');
  const imgEl = byId('lightboxImg');
  const wrap = byId('lightboxMediaWrap');
  if (!wrap) {
    _setMediaBranch('skipped-no-wrap');
    _lastVideoRejected = null;
    _lastImgRejected = null;
    return;
  }
  // Video validity.
  let videoValid = false;
  let videoRejected = null;
  if (!videoEl) {
    videoRejected = 'no-el';
  } else if (videoEl.style.display === 'none') {
    videoRejected = 'display=none';
  } else if (!videoEl.videoWidth) {
    videoRejected = `videoWidth=0 readyState=${videoEl.readyState || 0}`;
  } else if ((videoEl.readyState || 0) < 2) {
    videoRejected = `readyState=${videoEl.readyState || 0}`;
  } else {
    videoValid = true;
  }
  // Image validity. B19' tightens to also reject "not loaded yet"
  // (naturalWidth=0 AND complete=false). Note: complete is true on
  // multipart-replace MJPEG even when naturalWidth=0, so the AND is
  // the right join — img with complete=true is usable for layout
  // measurement even if the natural dimensions read zero.
  let imgValid = false;
  let imgRejected = null;
  if (!imgEl) {
    imgRejected = 'no-el';
  } else if (imgEl.style.display === 'none') {
    imgRejected = 'display=none';
  } else if ((imgEl.naturalWidth || 0) === 0 && !imgEl.complete) {
    imgRejected = 'naturalWidth=0 complete=false';
  } else {
    imgValid = true;
  }
  _lastVideoRejected = videoValid ? null : videoRejected;
  _lastImgRejected = imgValid ? null : imgRejected;
  const mediaEl = videoValid ? videoEl : imgValid ? imgEl : null;
  const wrapBox = wrap.getBoundingClientRect();
  if (wrapBox.width <= 0) {
    _setMediaBranch('skipped-no-wrap');
    return;
  }
  const imgBox = mediaEl ? mediaEl.getBoundingClientRect() : null;
  let dx, dy, w, h;
  let branch;
  if (mediaEl && imgBox.width > 0 && imgBox.height > 0) {
    const fit = fittedRect(mediaEl);
    // fit is relative to the img's content box; the img's content
    // box top-left = imgBox.top/left - wrapBox.top/left.
    dx = imgBox.left - wrapBox.left + fit.x;
    dy = imgBox.top - wrapBox.top + fit.y;
    w = fit.w;
    h = fit.h;
    branch = mediaEl === videoEl ? 'video-rect' : 'img-rect';
    if (w <= 0 || h <= 0) {
      // fittedRect returned 0×0 (image laid out but naturalWidth=0,
      // the MJPEG case on Safari). Fall through to aspect-fallback
      // below — DO NOT cover the full wrap height: the wrap also
      // contains the toggle pills row, and covering the full wrap
      // pushes the SVG below the image by exactly the toggle-row
      // height. That's the y=242 offset the screenshot showed.
      dx = null;
    }
  }
  if (dx == null) {
    // B19 · aspect-correct fallback. The wrap may be TALLER than
    // the visible image (toggle pills stacked below it). The image
    // itself is letterboxed inside its own slot via object-fit:
    // contain, but we don't know that slot's height directly. We DO
    // know the source aspect (fs.w / fs.h), so we compute the SVG
    // height as wrap.width * fs.h / fs.w, pin to top:0, and let the
    // SVG's preserveAspectRatio:meet finish the letterbox math.
    const fs = _session?.lastFrameSize;
    dx = 0;
    dy = 0;
    w = wrapBox.width;
    if (fs && fs.w > 0 && fs.h > 0) {
      h = (wrapBox.width * fs.h) / fs.w;
      branch = 'wrap-fallback-aspect';
    } else {
      // No frame size known yet — first tick hasn't returned.
      // Cover the full wrap (legacy behaviour) so the SVG is at
      // least visible somewhere. Surface this as a distinct branch
      // so the user sees it on the media row and knows the fix is
      // "wait for the first tick".
      h = wrapBox.height;
      branch = 'wrap-fallback-full';
    }
  }
  svg.style.left = `${dx}px`;
  svg.style.top = `${dy}px`;
  svg.style.width = `${w}px`;
  svg.style.height = `${h}px`;
  svg.style.right = 'auto';
  svg.style.bottom = 'auto';
  svg.style.inset = 'auto';
  _setMediaBranch(branch);
}

// B19 / B19' · stash the branch + per-candidate rejection reasons
// that _positionSvgOverImage produced so the next _refreshMediaRow()
// pickup includes them without an extra plumbing arg. Plain module-
// level scratch — the position helper writes them, the media-row
// builder reads them.
let _lastMediaBranch = null;
let _lastVideoRejected = null;
let _lastImgRejected = null;
function _setMediaBranch(branch) {
  _lastMediaBranch = branch;
}

// Per-label trail cap — newest N centroids drawn behind the bbox.
// Matches the batch-A Mediathek trail (mediaview/canvas/trail-layer.js)
// so the recorded and live UIs read identically.
const _LIVE_TRAIL_MAX_POINTS = 20;

// Trails layer. Connects per-label bbox centroids from the 60 s
// _detBuffer window into a fading polyline. Visual matches the
// batch-A Mediathek trail (last N points, linear opacity ramp,
// solid head-dot) via the shared `buildTrailSvg` helper —
// recorded clips and live simulation render trails the same way.
function _renderTrailsOverlay() {
  const svg = _ensureTrailsOverlay();
  if (!svg || !_session) return;
  svg.style.display = _overlays.trails ? 'block' : 'none';
  if (!_overlays.trails) {
    svg.innerHTML = '';
    return;
  }
  const fs = _session.lastFrameSize || { w: 1920, h: 1080 };
  svg.setAttribute('viewBox', `0 0 ${fs.w} ${fs.h}`);
  _positionSvgOverImage(svg);
  _refreshMediaRow();
  const rect = svg.getBoundingClientRect();
  if (_debugDiagOn()) {
    // A1 · same-shape rich row for trails. _detBuffer length is the
    // number of buffered detection samples in the rolling window
    // (one entry per detection per tick, dropped after _LIVE_WINDOW_MS).
    const cs = window.getComputedStyle(svg);
    const wrap = byId('lightboxMediaWrap');
    const wrapBox = wrap?.getBoundingClientRect();
    const left = wrapBox ? Math.round(rect.left - wrapBox.left) : Math.round(rect.left);
    const top = wrapBox ? Math.round(rect.top - wrapBox.top) : Math.round(rect.top);
    _updateDiagStrip('trails', {
      buffer: _detBuffer.length,
      viewBox: `${fs.w}×${fs.h}`,
      svgRect: `${Math.round(rect.width)}×${Math.round(rect.height)}@${left},${top}`,
      zIndex: cs.zIndex,
      display: cs.display,
      trailsOn: _overlays.trails ? 'true' : 'false',
    });
  }
  // Same 0×0 guard as the bbox layer — wait for the image to size
  // before paint so the polylines don't land in a sub-pixel corner.
  if (rect.width <= 0 || rect.height <= 0) {
    _updateDiagStrip('position-fail', {
      svg: svg.id,
      svgRect: `${Math.round(rect.width)}×${Math.round(rect.height)}`,
    });
    svg.innerHTML = '';
    return;
  }
  // Group buffered detections by label so each label gets its own
  // contiguous trail. Pre-sort by ms inside each group; the
  // detBuffer is push-order but a polling-cadence change could
  // technically interleave entries from one to the next.
  const byLabel = new Map();
  for (const e of _detBuffer) {
    if (!byLabel.has(e.label)) byLabel.set(e.label, []);
    byLabel.get(e.label).push(e);
  }
  const strokeW = Math.max(2, Math.round(fs.w / 720));
  const parts = [];
  for (const [label, entries] of byLabel) {
    if (entries.length < 2) continue;
    entries.sort((a, b) => a.ms - b.ms);
    // Keep only the newest N centroids — same cap the recorded
    // Mediathek trail uses so the visual reads identically.
    const tail = entries.slice(-_LIVE_TRAIL_MAX_POINTS);
    const points = tail.map((e) => ({
      x: e.bbox[0] + e.bbox[2] / 2,
      y: e.bbox[1] + e.bbox[3] / 2,
    }));
    const c = colors[label] || colors.unknown;
    parts.push(buildTrailSvg(points, c, strokeW));
  }
  svg.innerHTML = parts.join('');
}

function _renderZoneMaskOverlay() {
  const canvas = _ensureZoneMaskOverlay();
  if (!canvas || !_session) return;
  const showZones = _overlays.zones;
  const showMasks = _overlays.masks;
  if (!showZones && !showMasks) {
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.style.display = 'none';
    return;
  }
  canvas.style.display = 'block';
  const fs = _session.lastFrameSize || { w: 1920, h: 1080 };
  const cam = (state.cameras || []).find((c) => c.id === _session.camId) || {};
  // Normalise polygons through the shared resolver so source_w/h
  // are always present (modern stamp wins, legacy fall back to
  // preview_resolution / 1280×720 default).
  const zones = showZones
    ? (cam.zones || []).map((z) => normalizePolygon(z, cam)).filter(Boolean)
    : [];
  const masks = showMasks
    ? (cam.masks || []).map((m) => normalizePolygon(m, cam)).filter(Boolean)
    : [];
  // The MJPEG <img> never reports a reliable naturalWidth on Safari
  // (the multipart-replace stream confuses the natural-dims tracker).
  // Pass the backend-reported frame_size to the shared zone-layer
  // so its letterbox math uses the same coordinate base the rest of
  // the live-detect overlays (bbox, trails) already use.
  const liveImg = byId('lightboxImg');
  renderZoneLayerForMediaEl(canvas, liveImg, { zones, masks }, { srcW: fs.w, srcH: fs.h });
  _refreshMediaRow();
  const rect = canvas.getBoundingClientRect();
  if (_debugDiagOn()) {
    const cs = window.getComputedStyle(canvas);
    const wrap = byId('lightboxMediaWrap');
    const wrapBox = wrap?.getBoundingClientRect();
    const left = wrapBox ? Math.round(rect.left - wrapBox.left) : Math.round(rect.left);
    const top = wrapBox ? Math.round(rect.top - wrapBox.top) : Math.round(rect.top);
    _updateDiagStrip('zonemask', {
      zones: (cam.zones || []).length,
      masks: (cam.masks || []).length,
      viewBox: `${fs.w}×${fs.h}`,
      svgRect: `${Math.round(rect.width)}×${Math.round(rect.height)}@${left},${top}`,
      zIndex: cs.zIndex,
      display: cs.display,
      zonesOn: _overlays.zones ? 'true' : 'false',
      masksOn: _overlays.masks ? 'true' : 'false',
    });
  }
  if (rect.width <= 0 || rect.height <= 0) {
    _updateDiagStrip('position-fail', {
      svg: canvas.id,
      svgRect: `${Math.round(rect.width)}×${Math.round(rect.height)}`,
    });
  }
}

function _renderDetectionsPanel(data) {
  const detHost = byId('mvLdDetections');
  if (!detHost) return;
  const dets = data.detections || [];
  // D67 · no header, no empty-state row. When there are no rows the
  // panel collapses to zero height; the suppressed-hint above the
  // panel already tells the user about non-pass items.
  // Sort: pass first, then belowthresh, then filtered; within each
  // bucket descending by score. Backed by the D52 detections-expanded
  // toggle — pass-only by default, expanded shows everything.
  const verdictRank = { pass: 0, belowthresh: 1, filtered: 2 };
  const expanded = _detectionsExpanded();
  const visible = (expanded ? dets : dets.filter((d) => d.verdict === 'pass'))
    .slice()
    .sort((a, b) => {
      const ra = verdictRank[a.verdict] ?? 3;
      const rb = verdictRank[b.verdict] ?? 3;
      if (ra !== rb) return ra - rb;
      return (b.score || 0) - (a.score || 0);
    });
  if (!visible.length) {
    detHost.innerHTML = '';
    return;
  }
  detHost.innerHTML = visible
    .map((d) => {
      const c = colors[d.label] || colors.unknown;
      const lblText = OBJ_LABEL[d.label] || d.label;
      const tone = d.verdict === 'pass' ? 'ok' : d.verdict === 'belowthresh' ? 'warn' : 'mute';
      const verdictText =
        d.verdict === 'pass'
          ? 'PASS'
          : d.verdict === 'belowthresh'
            ? 'unter Schwelle'
            : d.verdict === 'filtered'
              ? 'gefiltert'
              : '—';
      return `<button type="button" class="mv-ld-row" data-tone="${tone}" data-label="${esc(d.label)}">
      <span class="mv-ld-row-bar" style="background:${c}"></span>
      <span class="mv-ld-row-label">${esc(lblText)}</span>
      <span class="mv-ld-row-score">${Math.round((d.score || 0) * 100)} %</span>
      <span class="mv-ld-row-verdict">${esc(verdictText)}</span>
    </button>`;
    })
    .join('');
  detHost.querySelectorAll('.mv-ld-row').forEach((row) => {
    row.addEventListener('click', () => {
      const lbl = row.dataset.label;
      _selectedLabel = _selectedLabel === lbl ? null : lbl;
      _renderBboxOverlay();
      _renderDetailPill();
    });
  });
}

function _renderLiveSwimlane() {
  // Build a synthetic _tracks payload from the 60 s buffer (one
  // synthetic track per label) and ask the recorded swimlane to
  // render it. Sample timestamps are shifted into [0, 60] so the
  // existing rendering treats the window as a 60-second "clip".
  if (!_session) return;
  const now = Date.now();
  const windowStart = now - _LIVE_WINDOW_MS;
  const byLabel = new Map();
  for (const e of _detBuffer) {
    if (e.ms < windowStart) continue;
    const t = (e.ms - windowStart) / 1000;
    if (!byLabel.has(e.label)) byLabel.set(e.label, []);
    byLabel.get(e.label).push({
      f: byLabel.get(e.label).length,
      t,
      bbox: {
        x1: e.bbox?.[0] || 0,
        y1: e.bbox?.[1] || 0,
        x2: (e.bbox?.[0] || 0) + (e.bbox?.[2] || 0),
        y2: (e.bbox?.[1] || 0) + (e.bbox?.[3] || 0),
      },
      score: e.score,
      source: 'detect',
    });
  }
  // 1-based per-render _num so the timeline-panel renders "#1", "#2"
  // bar labels instead of "#undefined". Mirrors the stamping that
  // bbox-overlay/fetcher.js does on recorded tracks at fetch time —
  // the timeline-panel reads tr._num directly. Label-ordered via
  // entries() insertion order; since each label gets one synthetic
  // track in the live window, _num maps 1:1 to the visible bar.
  const tracks = [];
  let _num = 0;
  for (const [label, samples] of byLabel.entries()) {
    _num += 1;
    tracks.push({
      track_id: `live-${label}`,
      _num,
      label,
      color: colors[label] || '#94a3b8',
      first_frame: 0,
      last_frame: samples.length - 1,
      best_score: Math.max(0, ...samples.map((s) => s.score || 0)),
      best_frame: 0,
      samples,
    });
  }
  const liveItem = {
    type: 'live-detect',
    event_id: `live-${_session.camId}`,
    camera_id: _session.camId,
    _tracks: { tracks, filter_applied: null, duration_s: _LIVE_WINDOW_MS / 1000 },
  };
  lbRenderTrackTimeline(liveItem);
  _pinScrubberRight();
}

function _renderDetailPill() {
  // F12 · detail pill overlays the video slot (anchored absolutely
  // inside it) so it never escapes the media region.
  const wrap = _slot('video') || byId('lightboxMediaWrap');
  if (!wrap) return;
  let pill = byId('mvLiveDetailPill');
  if (!_selectedLabel) {
    if (pill) pill.remove();
    return;
  }
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'mvLiveDetailPill';
    pill.className = 'mv-live-detail-pill';
    wrap.appendChild(pill);
  }
  const c = colors[_selectedLabel] || colors.unknown;
  const lblText = OBJ_LABEL[_selectedLabel] || _selectedLabel;
  // Find the live detection for this label (most recent).
  const det = (_session?.lastDetections || []).find((d) => d.label === _selectedLabel);
  if (!det) {
    pill.innerHTML = `<div class="mv-live-detail-head" style="color:${c}">${esc(lblText)}</div>
      <div class="mv-live-detail-empty">Aktuell nicht im Bild</div>`;
    return;
  }
  const cam = (state.cameras || []).find((x) => x.id === _session.camId) || {};
  const perCls = cam.label_thresholds || {};
  const generalThresh = Number(cam.detection_min_score) || 0.55;
  const scoreThresh =
    perCls[_selectedLabel] != null ? Number(perCls[_selectedLabel]) : generalThresh;
  const fs = _session.lastFrameSize || { w: 1920, h: 1080 };
  const bh = det.bbox?.[3] || 0;
  const bw = det.bbox?.[2] || 0;
  const fracH = fs.h > 0 ? bh / fs.h : 0;
  const fracArea = fs.w * fs.h > 0 ? (bw * bh) / (fs.w * fs.h) : 0;
  const score = det.score || 0;
  const scorePct = Math.round(score * 100);
  const threshPct = Math.round(scoreThresh * 100);
  const heightPct = Math.round(fracH * 100);
  const areaPct = Math.round(fracArea * 100);
  const scoreColor = score >= scoreThresh ? c : '#f59e0b';
  pill.innerHTML = `
    <div class="mv-live-detail-head" style="color:${c}">${esc(lblText)}</div>
    <div class="mv-live-detail-gauge">
      <div class="mv-live-detail-row">
        <span class="mv-live-detail-key">Score</span>
        <span class="mv-live-detail-val">${scorePct} %</span>
      </div>
      <div class="mv-live-detail-bar">
        <span class="mv-live-detail-fill" style="width:${scorePct}%;background:${scoreColor}"></span>
        <span class="mv-live-detail-tick" style="left:${threshPct}%"></span>
      </div>
      <div class="mv-live-detail-row">
        <span class="mv-live-detail-key">Höhe</span>
        <span class="mv-live-detail-val">${heightPct} %</span>
      </div>
      <div class="mv-live-detail-bar">
        <span class="mv-live-detail-fill" style="width:${heightPct}%;background:${c}"></span>
      </div>
      <div class="mv-live-detail-row">
        <span class="mv-live-detail-key">Fläche</span>
        <span class="mv-live-detail-val">${areaPct} %</span>
      </div>
      <div class="mv-live-detail-bar">
        <span class="mv-live-detail-fill" style="width:${areaPct}%;background:${c}"></span>
      </div>
    </div>`;
}

function _appendTrace(lines) {
  if (!Array.isArray(lines) || !_session?.fold) return;
  for (const line of lines) {
    _traceLines.push({ kind: _classifyTrace(line), text: line });
  }
  while (_traceLines.length > _TRACE_CAP) _traceLines.shift();
  const body = document.querySelector('#lightboxSettings .mv-fafold-body');
  const wasAtBottom = body ? body.scrollHeight - body.scrollTop - body.clientHeight < 24 : true;
  _session.fold.setLines(_traceLines);
  if (body && wasAtBottom) {
    body.scrollTop = body.scrollHeight;
  }
}

function _classifyTrace(line) {
  if (!line) return 'info';
  if (line.indexOf(' PASS') !== -1) return 'pass';
  if (line.indexOf(' REJECTED') !== -1 || line.indexOf(' FILTERED') !== -1) return 'reject';
  if (line.indexOf('no detection survived') !== -1) return 'no-detection';
  return 'info';
}

// Suppress the OBJ_SVG / objIconSvg "imported but unused" warnings —
// kept around in case a future refactor lifts the detail-pill into
// the shared detail-pill.js module which uses these for the
// per-class icon glyph above the gauges. Cheaper than re-importing
// when that lands.
void OBJ_SVG;
void objIconSvg;

window.closeLiveDetect = closeLiveDetect;
