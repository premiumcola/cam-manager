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
import { S } from './live-detect-state.js';
import { _renderDetectionsPanel, _renderLiveSwimlane, _renderDetailPill, _appendTrace, _renderTraceTab } from './live-detect-panels.js';
import { _renderBboxOverlay } from './live-detect-bbox.js';
import {
  _installLiveOverlayRefresh,
  _ensureBboxOverlay,
  _ensureTrailsOverlay,
  _ensureZoneMaskOverlay,
  _renderTrailsOverlay,
  _renderZoneMaskOverlay,
} from './live-detect-overlays.js';
import { _tick } from './live-detect-poll.js';
import { _debugDiagOn, _renderDiagStrip, _updateDiagStrip, _refreshMediaRow, _refreshCadenceRow, _collectBboxDiagFields } from './live-detect-diag.js';
import { state } from '../core/state.js';
import { OBJ_LABEL, OBJ_SVG, colors, objIconSvg } from '../core/icons.js';
import { renderFineAnalysisFold } from './fine-analysis-fold.js';
// I1 · single source of the Aus/Motion-ROI/2×2/3×3 list — the F
// mode-indicator owns it; _mountSimControls renders from the same
// array so the live chips and the shell badge can never drift.
import { MV_DETECTION_MODES } from './mode-indicator.js';
import { renderOverlayToggles } from './overlay-toggles.js';
import { renderDetailPill } from './detail-pill.js';
import { normalizePolygon } from '../core/polygon-source.js';
import { renderZoneLayerForMediaEl } from './canvas/zone-layer.js';
import { fittedRect } from '../core/video-fit.js';
// SIMU-03 · lbRenderTrackTimeline is fired indirectly by
// _setupVideoChrome on mount (it paints recorded chrome into
// #lightboxBottomStack before our renderer takes over). Imported
// only for the type/back-compat hint; no direct call site remains
// after SIMU-03b — the live-swimlane.js renderer replaces it on
// every tick.
import { lbRenderTrackTimeline as _lbRenderTrackTimeline } from '../mediathek/bbox-overlay/index.js';
void _lbRenderTrackTimeline;
import { _setupVideoChrome } from '../lightbox.js';
import { buildTrailSvg } from './canvas/trail-layer.js';
import {
  mountLdSkeleton,
  unmountLdSkeleton,
  zoneEl,
  panelEl,
  getActiveTab,
  onTabChange,
} from './live-detect-skeleton.js';
import { renderLiveSwimlane } from './live-swimlane.js';
import { renderLiveTrace, tracePrefix } from './live-trace.js';
import {
  renderDebugPanel,
  startSnapshotPrefetch,
  stopSnapshotPrefetch,
} from './live-detect-debug/index.js';

// C73 · cadence floors. The original 1 Hz floor was set against the
// main-stream cost budget (2560×1440 frame copy + JPEG encode +
// inference ~600-1500 ms). With C41's sub-stream path the per-tick
// cost drops to ~250 ms, so 500 ms is a safe floor on that path.
// _scheduleNext picks the right floor based on the most recent
// diag.frame_src; the main_fallback path keeps the 1 Hz floor so an
// unhealthy / sub-disabled camera doesn't get hammered.
export const _TICK_FLOOR_SUB_MS = 500;
export const _TICK_FLOOR_MAIN_MS = 1000;
export const _TICK_MAX_MS = 4000;
export const _TICK_FACTOR = 1.2;

// C84 · dynamic bbox hold-time scaffolding. The cycle EMA is
// populated by _scheduleNext on every cycle, then S.holdMsActive
// is derived from it (clamp(2*EMA, 800, 1500)). Both stay valid
// at module level so the CADENCE row from C73 can read them
// without late-binding gymnastics.
// 60 s sliding window for the swimlane. Detections older than this
// age out of the visible strip.
export const _LIVE_WINDOW_MS = 60_000;
export const _TRACE_CAP = 80;
// Q2-3 · the Trace tab groups the raw decision-trace BY TICK (one
// backend response = one block, newest on top). Keep the last 20 ticks
// — enough scroll-back to compare a few cycles without unbounded growth.
export const _TRACE_TICK_CAP = 20;
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
export const _HOLD_MS_CEILING = 1500;
export const _HOLD_MS_FLOOR = 800;
// Refresh interval for the hold-time fade. SIMU-02d removed the
// persistent "empty state" video banner — the absence of detections
// is now expressed via the empty Detections tab (SIMU-04+) instead
// of an overlay element that covered ~30% of the video.
// Fires at ~24 Hz; the actual bbox repaints are cheap (innerHTML
// of an SVG with < 10 elements) and only run while live-detect is
// mounted, so the cost is negligible vs. the smoothness gain.
const _HOLD_REFRESH_MS = 250;

// Q2-5 · stall detection. The background is now the per-tick inference
// snapshot (Q2-4), so "no new frame for a while" == "no successful tick
// for a while". The threshold is ADAPTIVE: a healthy camera ticks fast
// but a slow twilight camera can legitimately take many seconds per
// cycle (the user's "Nut Bar" cam runs ~7.8 s avg), so a fixed 4-5 s
// would false-fire constantly there. We flag a stall only when the gap
// since the last frame exceeds max(5 s floor, 2.2 × the camera's own
// recent cadence) — responsive on fast cams, quiet on slow ones.
const _STALL_FLOOR_MS = 5000;
const _STALL_FACTOR = 2.2;
// Auto-retry backoff while stalled: 1 s → 2 s → 4 s → 8 s (capped).
const _STALL_BACKOFF_START = 1000;
const _STALL_BACKOFF_MAX = 8000;

// Q2-5 · stall watchdog state. `active` flips on when the frame gap
// crosses the adaptive threshold; `nextRetryAt` paces the backoff.
// L1 · overlay-layer visibility booleans. The shared overlay-toggles
// bar (overlay-toggles.js) owns the pills + their localStorage
// persistence; live seeds this mirror from the bar's getState() at
// mount (_setupLiveChrome) and the bar's onChange keeps it in sync.
// The SVG render code reads ONLY these booleans, never the pill DOM.

export function openLiveDetect({ camId, cameraName }) {
  if (!camId) return;
  // B12 · capture whether a prior session was mounted BEFORE
  // closeLiveDetect nulls it. Surfaced on the MOUNT row as
  // torn_down_prev so a back-to-back cam switch is visible.
  const tornDownPrev = !!S.session;
  closeLiveDetect();
  S.session = {
    camId,
    cameraName,
    abort: null,
    tickHandle: null,
    fold: null,
    startedMs: Date.now(),
    lastNonEmptyTickMs: 0,
    holdHandle: null,
    // C2/C3 · ephemeral sim controls (per-open, not persisted). Default
    // MAIN stream so the sim mirrors the production alarm pipeline; tiling
    // off until the operator engages a mode.
    stream: 'main',
    detMode: 'off',
  };
  S.traceLines = [];
  S.traceTicks = [];
  S.detBuffer = [];
  S.selectedLabel = null;
  S.stallState = { active: false, backoffMs: _STALL_BACKOFF_START, nextRetryAt: 0, sinceMs: 0 };
  // L1 · overlays are seeded from the shared toggle bar at mount
  // (_setupLiveChrome → renderOverlayToggles().getState()).
  // H2.a · reset the diag-strip state per session so the previous
  // open's last-known SVG dims don't bleed into the new one.
  S.diagState.bbox = null;
  S.diagState.trails = null;
  S.diagState.zonemask = null;
  S.diagState.posFail = null;
  S.diagState.paintFail = null;
  S.diagState.tick = null;
  S.diagState.mount = null;
  S.diagState.cadence = null;
  // B7/B12 · reset tick lifecycle state. Keep startedAt fresh on
  // every open so the strip's mounted_ms_ago matches the user's
  // last action — not some half-finished prior session.
  S.tickState.lastTickAt = 0;
  S.tickState.lastRespAt = 0;
  S.tickState.lastStatus = '—';
  S.tickState.nextTickAt = 0;
  S.tickState.startedAt = Date.now();
  S.tickState.startedWithCamId = camId;
  S.tickState.ticksDroppedLate = 0;
  S.tickState.lastDropReason = null;
  S.tickState.tornDownPrev = tornDownPrev;
  S.tickState.lastTickError = null;
  S.tickState.lastCycleMs = NaN;
  S.tickState.lastFloorMs = NaN;
  S.tickState.lastDelayMs = NaN;
  // C84 · reset hold-time state per session so a fresh cam-open
  // doesn't inherit the previous camera's cadence as the seed EMA.
  S.cycleEmaMs = NaN;
  S.holdMsActive = NaN;
  // B12' · always-on MOUNT row. Tracks every step of the mount path
  // so a screenshot tells us at a glance whether chrome rendered,
  // whether _tick() threw, and whether a first-tick setTimeout was
  // actually scheduled. Healthy mounts paint muted; any error flips
  // the row red and persists until the next successful mount.
  const mountRecord = {
    started_at: new Date(S.tickState.startedAt).toISOString(),
    started_with_camId: camId,
    torn_down_prev: tornDownPrev ? 'true' : 'false',
    chrome_mounted: 'false',
    first_tick_scheduled: 'false',
    error: '',
  };
  let chromeOk = false;
  let mountErr = null;
  try {
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
  S.diagState.mount = { ...mountRecord, _err: !!mountErr };
  _renderDiagStrip();
  _startHoldRefresh();
  // SIMU-FIX-01c · lock both <html> and <body> overflow + height
  // for the lifetime of the live-detect session so the viewport
  // itself never scrolls — only zone-detail does. Previous values
  // are saved on S.session so closeLiveDetect can restore them
  // verbatim (a recorded-clip lightbox might rely on body overflow:
  // scroll, for example). Explicit height:100dvh on both belt-and-
  // suspenders against iOS Safari's address-bar-collapse viewport
  // changes leaving body taller than the new viewport.
  S.session.prevBodyOverflow = document.body.style.overflow;
  S.session.prevHtmlOverflow = document.documentElement.style.overflow;
  S.session.prevBodyHeight = document.body.style.height;
  S.session.prevHtmlHeight = document.documentElement.style.height;
  document.body.style.overflow = 'hidden';
  document.documentElement.style.overflow = 'hidden';
  document.body.style.height = '100dvh';
  document.documentElement.style.height = '100dvh';
  // B12' · 250 ms watchdog. ONE-SHOT — fires once, then cleared.
  // Two outcomes: tickHandle present → mark first_tick_scheduled
  // true (success path); tickHandle still null → promote MOUNT row
  // to error with "no first-tick scheduled within 250ms".
  const expectedSessionStart = S.tickState.startedAt;
  setTimeout(() => {
    // Different session by now → leave its own MOUNT row alone.
    if (!S.session || S.tickState.startedAt !== expectedSessionStart) return;
    const scheduled = !!S.session.tickHandle;
    const rec = S.diagState.mount || {};
    rec.first_tick_scheduled = scheduled ? 'true' : 'false';
    if (!scheduled && !rec.error) {
      rec.error = 'no first-tick scheduled within 250ms';
      rec._err = true;
    }
    S.diagState.mount = rec;
    _renderDiagStrip();
  }, 250);
}

export function closeLiveDetect() {
  const session = S.session;
  S.session = null;
  S.traceLines = [];
  S.traceTicks = [];
  S.detBuffer = [];
  S.selectedLabel = null;
  // Q2-4 · the snapshot <img> holds a per-tick data: URL — drop it so
  // the decoded frame is released when the session closes. (No HLS /
  // MJPEG stream to tear down anymore — the view is snapshot-only.)
  const imgEl = byId('lightboxImg');
  if (imgEl) imgEl.removeAttribute('src');
  if (!session) return;
  try {
    session.abort?.abort();
  } catch {
    /* ignore */
  }
  if (session.tickHandle) clearTimeout(session.tickHandle);
  if (session.holdHandle) clearInterval(session.holdHandle);
  // SIMU-FIX-01c · restore the pre-mount overflow + height values
  // on body and <html> so a subsequent recorded-clip open behaves
  // normally. Empty string clears the inline style, letting the
  // page stylesheet take over.
  if (typeof session.prevBodyOverflow === 'string') {
    document.body.style.overflow = session.prevBodyOverflow;
  }
  if (typeof session.prevHtmlOverflow === 'string') {
    document.documentElement.style.overflow = session.prevHtmlOverflow;
  }
  if (typeof session.prevBodyHeight === 'string') {
    document.body.style.height = session.prevBodyHeight;
  }
  if (typeof session.prevHtmlHeight === 'string') {
    document.documentElement.style.height = session.prevHtmlHeight;
  }
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
  // L1 · tear down the shared overlay-toggle bar (its document
  // touch-dismiss listener) before removing the row node.
  try {
    session.overlayToggles?.teardown?.();
  } catch {
    /* ignore */
  }
  const toggleRow = byId('mvLiveToggles');
  if (toggleRow) toggleRow.remove();
  const simControls = byId('mvSimControls');
  if (simControls) simControls.remove();
  const diagStrip = byId('mvSimDiagStrip');
  if (diagStrip) diagStrip.remove();
  const livePill = byId('mvLiveScrubPill');
  if (livePill) livePill.remove();
  // D52 · the "<n> verworfen — antippen für Details" hint sits
  // outside the toggle row; remove it on session teardown.
  const suppressedHint = byId('mvLiveSuppressedHint');
  if (suppressedHint) suppressedHint.remove();
  // Q2-5 · drop the stall banner if a teardown happens while stalled.
  _hideStallBanner();
  // SIMU-FIX-05c · stop the debug-snapshot pre-fetch loop so it
  // doesn't keep hitting the closed session's camId.
  stopSnapshotPrefetch();
  // SIMU-01 · tear down the 5-zone skeleton last so any remaining
  // children get re-parented back to #lightboxMediaWrap / #lightbox
  // Inner before the container is removed. Recorded-clip lightbox
  // re-uses these IDs and expects them at their original parents.
  unmountLdSkeleton();
}

// gp384 — bbox hold + empty-banner refresh. Drives the per-frame
// opacity fade-out for held detections and the show/hide of the
// "Aktuell keine Detektionen" banner. setInterval rather than
// requestAnimationFrame so the rate is fixed (the detector tick is
// 1 Hz anyway — animating at 60 Hz would just burn CPU without
// any visible benefit).
function _startHoldRefresh() {
  if (!S.session) return;
  if (S.session.holdHandle) clearInterval(S.session.holdHandle);
  S.session.holdHandle = setInterval(() => {
    if (!S.session) return;
    _renderBboxOverlay();
    // B7 · piggyback the tick-row refresh on the existing 250 ms
    // hold loop so the on-screen deltas stay current even when the
    // tick loop is wedged (no _renderFrame call would otherwise
    // drive _renderDiagStrip). Cheap — _renderDiagStrip is a no-op
    // when the Debug pill is OFF.
    if (_debugDiagOn()) _renderDiagStrip();
    // Q2-5 · piggyback the stall watchdog on the same fixed-rate loop.
    _checkStall();
  }, _HOLD_REFRESH_MS);
}

// Q2-5 · adaptive stall watchdog. Runs every _HOLD_REFRESH_MS. Compares
// the time since the last painted frame against the camera's own recent
// cadence; on a genuine stall it surfaces the reconnect banner, logs a
// console diagnostic (visible in mobile-Safari Web Inspector), and
// re-kicks the tick loop on a 1/2/4/8 s backoff. Recovery (a fresh
// frame) clears the banner and resets the backoff.
function _checkStall() {
  if (!S.session) return;
  const now = Date.now();
  const t = S.tickState;
  // Reference = last successful frame; before the first frame lands,
  // fall back to mount time so a never-connecting open also surfaces.
  const ref = t.lastRespAt || t.startedAt || now;
  const gap = now - ref;
  const expected = Math.max(S.cycleEmaMs || 0, t.lastDelayMs || 0);
  const stallMs = Math.max(_STALL_FLOOR_MS, Math.round(_STALL_FACTOR * expected));
  const stalled = gap > stallMs;
  if (stalled && !S.stallState.active) {
    S.stallState.active = true;
    S.stallState.sinceMs = ref;
    S.stallState.backoffMs = _STALL_BACKOFF_START;
    // console.warn is the lint-allowed diagnostic escape hatch.
    console.warn(
      `[sim-stall] no frame for ${gap} ms (threshold ${stallMs} ms) · ` +
        `lastFrame=${t.lastRespAt ? new Date(t.lastRespAt).toISOString() : 'none'} · ` +
        `now=${new Date(now).toISOString()}`,
    );
    _showStallBanner();
    _retryTickNow();
    S.stallState.nextRetryAt = now + S.stallState.backoffMs;
  } else if (stalled && S.stallState.active) {
    if (now >= S.stallState.nextRetryAt) {
      S.stallState.backoffMs = Math.min(_STALL_BACKOFF_MAX, S.stallState.backoffMs * 2);
      _retryTickNow();
      S.stallState.nextRetryAt = now + S.stallState.backoffMs;
    }
  } else if (!stalled && S.stallState.active) {
    console.warn(
      `[sim-stall] recovered after ${now - S.stallState.sinceMs} ms · ` +
        `frame=${new Date(t.lastRespAt || now).toISOString()}`,
    );
    S.stallState.active = false;
    S.stallState.backoffMs = _STALL_BACKOFF_START;
    _hideStallBanner();
  }
}

// Abort a possibly-hung in-flight fetch and fire a fresh tick now. The
// hung tick's fetch rejects with AbortError and returns without
// rescheduling, so we don't end up with two live loops.
function _retryTickNow() {
  if (!S.session) return;
  try {
    S.session.abort?.abort();
  } catch {
    /* ignore */
  }
  if (S.session.tickHandle) {
    clearTimeout(S.session.tickHandle);
    S.session.tickHandle = null;
  }
  _tick();
}

function _showStallBanner() {
  const host = zoneEl('video') || byId('lightboxMediaWrap');
  if (!host) return;
  let banner = byId('mvLiveStallBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'mvLiveStallBanner';
    banner.className = 'mv-ld-stall-banner';
    banner.innerHTML =
      '<div class="mv-ld-stall-inner">' +
      '<div class="mv-ld-stall-spinner" aria-hidden="true"></div>' +
      '<div class="mv-ld-stall-text">Verbindung zur Kamera unterbrochen — ' +
      'versuche erneut zu verbinden …</div>' +
      '<button type="button" class="mv-ld-stall-retry" data-action="stall-retry">' +
      'Erneut versuchen</button>' +
      '</div>';
    banner.querySelector('[data-action="stall-retry"]')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      console.warn('[sim-stall] manual retry');
      S.stallState.backoffMs = _STALL_BACKOFF_START;
      _retryTickNow();
    });
    host.appendChild(banner);
  }
  banner.style.display = 'flex';
}

function _hideStallBanner() {
  const banner = byId('mvLiveStallBanner');
  if (banner) banner.remove();
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
  // SIMU-01 · build the 5-zone DOM skeleton inside #lightboxMediaWrap
  // BEFORE any overlay/pill/strip mounts so subsequent appendChild
  // calls land in the right zone. Idempotent — a back-to-back cam
  // switch just refreshes the title text inside the existing zones.
  mountLdSkeleton({ camId, cameraName });
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
  // Q2-4 · "show what the AI sees", not live security footage.
  //
  // The earlier kr493 design streamed a continuous MJPEG/HLS video here
  // and drew the bbox overlay from the 1 Hz detection tick on TOP of it.
  // But the video element carries its own RTSP + network buffering
  // (seconds on HLS — the only path that paints on iOS Safari), while
  // the detector runs on a fresh sub-stream snapshot. So the overlay
  // always ran AHEAD of the visible picture: a box framed a person
  // several steps before they appeared there ("seeing the future").
  //
  // The simulation view's whole job is to show the exact frame the
  // detector reasoned about — so we now paint the SAME snapshot
  // inference ran on (returned per-tick as data.snapshot, with bbox
  // coords already in that frame's space) into the <img>, and the
  // overlay sits on identical pixels. Bbox and picture CANNOT desync
  // because they are one frame. As a bonus, a static <img> sidesteps
  // the iOS "MJPEG-in-<img> shows a broken image" limitation entirely
  // without needing HLS at all — no stream, no buffering, no lead.
  //
  // Do NOT re-introduce a live stream here without re-reading Q2-4:
  // any stream brings back the latency that this view exists to remove.
  const imgEl = byId('lightboxImg');
  const videoEl = byId('lightboxVideo');
  if (videoEl) {
    videoEl.pause?.();
    videoEl.removeAttribute('src');
    videoEl.load?.();
    videoEl.style.display = 'none';
  }
  if (imgEl) {
    // Cleared here; _renderFrame swaps in each tick's inference snapshot.
    imgEl.removeAttribute('src');
    imgEl.style.display = 'block';
    imgEl.alt = '';
    _installLiveOverlayRefresh(imgEl);
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
  // L1 · the ONE shared overlay-toggle bar (overlay-toggles.js). The row
  // (#mvLiveToggles) was created by _setupVideoChrome's
  // mountWeatherToggleBar; re-home it into zone-video so the floating
  // pill strip sits over the video, then let the shared renderer own the
  // pills + their persistence. onChange drives the SVG layers; the
  // initial layer state is seeded from the bar's getState().
  const _togHost = byId('mvLiveToggles');
  const _togZone = zoneEl('video');
  if (_togHost && _togZone && _togHost.parentNode !== _togZone) {
    _togZone.appendChild(_togHost);
  }
  if (_togHost && S.session) {
    const _tog = renderOverlayToggles(_togHost, {
      available: ['bboxes', 'trails', 'zones', 'masks'],
      contextKey: 'live',
      onChange: (id, on) => {
        S.overlays[id] = on;
        _renderBboxOverlay();
        _renderTrailsOverlay();
        _renderZoneMaskOverlay();
      },
    });
    if (_tog) {
      S.overlays = _tog.getState();
      S.session.overlayToggles = _tog;
    }
  }
  _mountSimControls();
  _pinScrubberRight();
  // dn487 — paint zones + masks BEFORE the first detection tick
  // arrives. _renderZoneMaskOverlay falls back to {w:1920, h:1080}
  // when S.session.lastFrameSize isn't set yet; the first tick
  // (~1 s later) repaints with the real frame_size so polygon
  // positions converge. Without this paint-before-tick the user
  // sees a 1 s window of no zone visuals after opening Simulieren.
  _renderZoneMaskOverlay();
  // SIMU-03b · paint an empty live-swimlane immediately so the
  // recorded chrome that _setupVideoChrome briefly drops into
  // #lightboxBottomStack is replaced before the first tick lands.
  _renderLiveSwimlane();
}

// Bind a `load` + ResizeObserver listener that re-runs the overlay
// renderers whenever the media element's rendered size changes (first
// frame arriving, window resize, address-bar collapse on iOS, FS
// enter/exit). The polling tick repaints at ~1 Hz on its own, but
// this listener bridges the sub-second gap so polygons + bboxes sit
// on the right pixels the instant the frame paints. Idempotent —
// the install flag is per-element so a re-mount on a different
// element doesn't double-bind.
function _forceImmediateTick() {
  const session = S.session;
  if (!session) return;
  if (session.tickHandle) {
    clearTimeout(session.tickHandle);
    session.tickHandle = null;
  }
  try {
    session.abort?.abort();
  } catch {
    /* ignore */
  }
  _tick();
}

// C2/C3 · always-visible controls row pinned top-right over the video:
// a Sub/Main stream toggle + an Aus/Motion-ROI/2×2/3×3 detection-mode
// segmented control. Ephemeral (session-scoped) — no persistence here
// (per-camera persistence is D3). Re-rendered on each change to refresh
// the active-state highlight.
function _mountSimControls() {
  const host = zoneEl('video') || byId('lightboxInner');
  if (!host || !S.session) return;
  let row = byId('mvSimControls');
  if (!row) {
    row = document.createElement('div');
    row.id = 'mvSimControls';
    row.className = 'mv-sim-controls';
  }
  if (row.parentNode !== host) host.appendChild(row);
  const stream = S.session.stream || 'main';
  const mode = S.session.detMode || 'off';
  const MODES = MV_DETECTION_MODES;
  const streamBtn =
    `<button type="button" class="mv-sim-ctl" data-ctl="stream" data-val="${esc(stream)}" ` +
    `title="Welchen Stream der Simulator prüft (Main = Produktions-Pipeline, Sub = 640×360)" ` +
    `aria-label="Stream umschalten, aktuell ${esc(stream)}">` +
    `<span class="mv-sim-ctl-chip"><span class="mv-sim-ctl-k">Stream</span>` +
    `<span class="mv-sim-ctl-v">${stream === 'sub' ? 'Sub' : 'Main'}</span></span></button>`;
  const modeBtns = MODES.map(
    ([id, lbl]) =>
      `<button type="button" class="mv-sim-seg" data-ctl="mode" data-val="${id}" ` +
      `data-on="${id === mode ? '1' : '0'}" aria-pressed="${id === mode ? 'true' : 'false'}" ` +
      `aria-label="Erkennungsmodus ${esc(lbl)}"><span class="mv-sim-ctl-chip">${esc(lbl)}</span></button>`,
  ).join('');
  row.innerHTML =
    streamBtn +
    `<span class="mv-sim-seg-group" role="group" aria-label="Erkennungsmodus">${modeBtns}</span>`;
  row.querySelectorAll('button[data-ctl]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!S.session) return;
      if (btn.dataset.ctl === 'stream') {
        S.session.stream = S.session.stream === 'sub' ? 'main' : 'sub';
      } else {
        S.session.detMode = btn.dataset.val;
      }
      _mountSimControls();
      _forceImmediateTick();
    });
  });
}

export function _pinScrubberRight() {
  // Live mode has no recorded clip → no seek; pin the playhead to
  // the right edge by writing --play-pct=1. The legacy "LIVE" pill
  // that previously sat at the scrubber edge was removed in
  // SIMU-FIX-01b — the SIMU-03d swimlane renderer now owns the
  // single LIVE marker (stacked pill + vertical green line).
  const stack = document.querySelector('.lb-time-stack');
  if (stack) stack.style.setProperty('--play-pct', '1');
  // Defensive teardown in case a previous render left a stale pill.
  const stale = byId('mvLiveScrubPill');
  if (stale) stale.remove();
}

function _mountPanels() {
  const host = byId('lightboxSettings');
  if (!host) return;
  host.hidden = false;
  // C3 · the Diagnose panel sits between the Detections tab and the
  // Fein-Analyse fold. It's a native <details> with class hooks so
  // collapse state is browser-managed (and persists across iOS Safari
  // bfcache restores without extra JS). Collapsed by default so the
  // panel doesn't dominate the layout the first time the user opens
  // Simulieren; one tap expands.
  // D67 · the Detections "tab" header was redundant — only one tab,
  // and the panel IS the detections. Render the rows directly.
  // D78 · the Diagnose <details> + Fein-Analyse fold get merged into
  // a single Trace fold. The Diagnose summary's "raw=N · pass=N"
  // pulse is now part of the Trace fold's summary line.
  host.innerHTML = `
    <div class="mv-recorded-panels">
      <div id="mvLdDetections" class="mv-ld-detections"></div>
      <div class="mv-recorded-fafold"></div>
    </div>`;
  const faHost = host.querySelector('.mv-recorded-fafold');
  // B23 · live: true so the empty-state copy reads "Warte auf
  // ersten Tick …" instead of the recorded-clip "Kein Server-Trace
  // gespeichert" string. Subsequent setLines() calls (via the tick
  // loop's _appendTrace path) replace the empty state with the real
  // decision_trace; if the loop is stuck the muted "Warte" line
  // serves as a downstream tell-tale for the B7/B12 STUCK row.
  const fold = renderFineAnalysisFold(faHost, null, { defaultOpen: false, live: true });
  if (S.session) S.session.fold = fold;
}

window.closeLiveDetect = closeLiveDetect;
// SIMU-06c · live-detect-debug.js reads the current overlay-toggle
// snapshot via this bridge so the debug snapshot reflects exactly
// what the user has on screen at copy-time.
window._mvLdOverlaysSnapshot = function () {
  const parts = [];
  for (const [k, v] of Object.entries(S.overlays)) {
    parts.push(`${k}=${v ? 'on' : 'off'}`);
  }
  return parts.join(' · ');
};
