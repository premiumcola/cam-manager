// ─── mediaview/live-detect-poll.js ─────────────────────────────────────────
// The 1 Hz test-detection poll loop: _tick fetches a frame, _scheduleNext paces
// the adaptive cadence + hold EMA, _renderFrame fans the result out to every
// overlay/panel renderer. Plus the Debug-tab render bridge, the onTabChange
// hook, the SAHI diag-fold, and the black-screen one-shot diagnostic. State via S.
import { byId, esc } from '../core/dom.js';
import { S } from './live-detect-state.js';
import { _renderBboxOverlay } from './live-detect-bbox.js';
import { _renderTrailsOverlay, _renderZoneMaskOverlay } from './live-detect-overlays.js';
import { _renderDetectionsPanel, _renderLiveSwimlane, _appendTrace, _renderTraceTab } from './live-detect-panels.js';
import { _refreshCadenceRow } from './live-detect-diag.js';
import { _renderDebugTab, _renderDiagPanel } from './live-detect-tabs.js';
import {
  _HOLD_MS_CEILING,
  _HOLD_MS_FLOOR,
  _LIVE_WINDOW_MS,
  _TICK_FLOOR_SUB_MS,
  _TICK_FLOOR_MAIN_MS,
  _TICK_MAX_MS,
  _TICK_FACTOR,
} from './live-detect.js';

export function _logSimDiag() {
  if (!S.session || S.session._diagLogged) return;
  S.session._diagLogged = true;
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
    `[sim-diag] S.session.lastDetections.length=${(S.session.lastDetections || []).length}`,
  );
}

// L1 · the toggle-pill glyphs, _TOGGLES dict and the hover/long-press
// tooltip popover were lifted into the shared overlay-toggles.js (which
// uses core/tooltip.js for the popover). Live now mounts that one bar in
// _setupLiveChrome — see the renderOverlayToggles call there.

// C2/C3 · re-tick immediately when the operator changes a sim control so
// the new stream / mode takes visible effect on the next frame instead of
// waiting out the current cadence delay.

export async function _tick() {
  const session = S.session;
  if (!session) return;
  S.tickState.lastTickAt = Date.now();
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
    // Q2-4 · no_snapshot is intentionally OFF now: the simulation view
    // paints the exact frame inference ran on (data.snapshot) as the
    // background so the bbox overlay and the picture are one and the
    // same frame. See _setupLiveChrome for the full rationale.
    // C2/C3 · pass the ephemeral sim controls — which stream to inspect
    // (main|sub) and the detection mode (off|roi|2x2|3x3).
    const _params = new URLSearchParams({
      stream: session.stream || 'main',
      mode: session.detMode || 'off',
    });
    const r = await fetch(
      `/api/cameras/${encodeURIComponent(session.camId)}/test-detection?${_params}`,
      { method: 'POST', signal: controller.signal },
    );
    S.tickState.lastStatus = r.status;
    // B31 / B31' · late-tick guard. The session can be replaced
    // or nulled by a concurrent stopLive / cam switch between
    // fetch-issue and fetch-resolve. We count the drop and stash
    // the reason ("session_null" when nothing is mounted now,
    // "cam_mismatch" when a different cam was opened in between)
    // so a STUCK-looking TICK row + dropped=N + drop_reason tells
    // the user "responses ARE arriving, they're just landing too
    // late" — a very different fix from "loop isn't running".
    if (S.session !== session) {
      S.tickState.ticksDroppedLate = (S.tickState.ticksDroppedLate || 0) + 1;
      S.tickState.lastDropReason = S.session === null ? 'session_null' : 'cam_mismatch';
      return;
    }
    let data = null;
    try {
      data = await r.json();
    } catch {
      /* keep null */
    }
    if (data?.ok) {
      S.tickState.lastRespAt = Date.now();
      S.tickState.lastTickError = null;
      // B23' · a successful tick clears any error banner the fold
      // may have been showing. _renderFrame's _appendTrace path
      // will repopulate the trace lines anyway, but the explicit
      // clear protects against an empty-trace ok=true response.
      S.session?.fold?.setLastError?.(null);
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
      S.tickState.lastTickError = text;
      S.session?.fold?.setLastError?.(text);
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      S.tickState.lastStatus = 'abort';
      return;
    }
    S.tickState.lastStatus = 'neterr';
    const text = `neterr · ${(err && (err.message || String(err))) || 'unknown'}`;
    S.tickState.lastTickError = text;
    S.session?.fold?.setLastError?.(text);
  }
  _scheduleNext(session, performance.now() - cycleStart);
}

export function _scheduleNext(session, lastCycleMs) {
  if (S.session !== session) return;
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
  S.tickState.nextTickAt = Date.now() + delay;
  S.tickState.lastCycleMs = cycleMs;
  S.tickState.lastFloorMs = floor;
  S.tickState.lastDelayMs = delay;
  // C84 · EMA over recent cycle wall-times. First observation seeds
  // the EMA so the hold isn't 0-initialised on the very first tick;
  // subsequent ticks pull the average toward the new cycle at factor
  // 0.4 (a 5-tick effective window). Hold = clamp(2 * EMA, 800,
  // 1500): two cycles of slack absorbs one missed tick at the
  // current cadence without lingering across multiple.
  if (!Number.isFinite(S.cycleEmaMs)) {
    S.cycleEmaMs = cycleMs;
  } else {
    S.cycleEmaMs = 0.4 * cycleMs + 0.6 * S.cycleEmaMs;
  }
  S.holdMsActive = Math.min(_HOLD_MS_CEILING, Math.max(_HOLD_MS_FLOOR, 2 * S.cycleEmaMs));
  session.tickHandle = setTimeout(_tick, delay);
  _refreshCadenceRow();
}

export function _renderFrame(data) {
  // Q2-4 · paint the exact frame inference ran on as the background.
  // data.snapshot is a base64 JPEG whose pixels are in the SAME
  // coordinate space as the bbox coords + frame_size used by the SVG
  // overlay below — so the box and the picture are guaranteed to match
  // (see _setupLiveChrome for why we abandoned the live stream here).
  // Setting .src fires the <img> load event → _installLiveOverlayRefresh
  // repaints the overlays once decoded; the synchronous repaints later
  // in this function cover the common case.
  if (data.snapshot) {
    const imgEl = byId('lightboxImg');
    if (imgEl && imgEl.getAttribute('src') !== data.snapshot) {
      imgEl.src = data.snapshot;
      if (imgEl.style.display === 'none') imgEl.style.display = 'block';
    }
  }
  // Frame state for the bbox + zone/mask overlays.
  S.session.lastFrameSize = data.frame_size || { w: 1920, h: 1080 };
  S.session.lastDetections = data.detections || [];
  // D52 · cache the full backend response so an out-of-band toggle
  // (e.g. tapping the "<n> verworfen" hint) can re-render the panel
  // without waiting for the next tick.
  S.session.lastFullData = data;
  // A3 · explicit coord-space disclosure from the backend (added in
  // diag by routes/coral_test_detection.py). The debug strip's bbox
  // row reads these to surface bbox_space + source/snap dims; if
  // bbox_space disagrees with the viewBox space (lastFrameSize),
  // the strip flags SPACE MISMATCH so the user sees the regression
  // immediately. All three fall back to undefined on older backends.
  const _diag = data.diag || {};
  S.session.lastBboxSpace = _diag.bbox_space || null;
  S.session.lastSourceFrameSize = _diag.source_frame_size || null;
  S.session.lastSnapshotFrameSize = _diag.snapshot_frame_size || null;
  // C73 · remember which stream the backend served this frame from
  // so _scheduleNext can pick the right floor on the NEXT cycle.
  // Falls back to undefined when an older backend didn't send the
  // field — _scheduleNext treats that as 'unknown' → safe 1 s floor.
  if (_diag.frame_src) S.session.lastFrameSrc = _diag.frame_src;
  // F2.b · one-shot per-session payload diagnostic. Answers the
  // "did the response actually carry detections" question without
  // requiring a tcpdump or the docker logs. Counts by verdict so
  // the user can spot a serialisation drop between Flask and the
  // frontend (rare but possible if response shaping went sideways).
  // Single-line console.warn (lint-allowed escape hatch).
  if (S.session && !S.session._frameDiagLogged) {
    S.session._frameDiagLogged = true;
    const dets = S.session.lastDetections;
    const np = dets.filter((d) => d.verdict === 'pass').length;
    const nb = dets.filter((d) => d.verdict === 'belowthresh').length;
    const nf = dets.filter((d) => d.verdict === 'filtered').length;
    const fs = S.session.lastFrameSize;
    const gates = data.diag?.gates || {};
    console.warn(
      `[sim-frame] dets=${dets.length} pass=${np} below=${nb} filtered=${nf} ` +
        `frame_size=${fs.w}x${fs.h} diag.raw=${gates.raw ?? '?'} ` +
        `outcome=${data.ok ? 'ok' : '?'}`,
    );
  }
  // F2 · track the latest raw count from the backend's diag block.
  // Read by the debug strip + (later) the Detections tab summary
  // line. SIMU-02d removed the in-video banner that used to gate on
  // this value; the field stays for downstream consumers.
  S.session.lastRawCount = Number(data.diag?.gates?.raw ?? data.detections?.length ?? 0);
  // Last-seen marker for the no-detection state. Reset on every
  // tick that brings at least one detection. Read by the Detections
  // tab + Trace tab consumers; the in-video banner that used to
  // depend on this was removed in SIMU-02d.
  if (S.session.lastDetections.length) S.session.lastNonEmptyTickMs = Date.now();
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
    S.detBuffer.push({
      ms: now,
      label: d.label,
      score: d.score,
      bbox: d.bbox,
      verdict: d.verdict,
      // SIMU-02e · track_num is the monotonically-assigned display
      // number from the backend's per-cam test-tracker. May be null
      // on the very first detection of a fresh session if association
      // happened to fail; the renderer then skips the badge.
      track_num: d.track_num,
    });
  }
  // Drop entries older than the window.
  const cutoff = now - _LIVE_WINDOW_MS;
  S.detBuffer = S.detBuffer.filter((e) => e.ms >= cutoff);
  _renderBboxOverlay();
  _renderTrailsOverlay();
  _renderZoneMaskOverlay();
  // SIMU-FIX-05d · append trace lines BEFORE rendering the
  // Detections tab — its Track-Ereignisse section reads from
  // `S.traceLines` and was previously seeing the PREVIOUS tick's
  // trace (empty on the very first tick → "Noch keine Track-
  // Ereignisse" while the Trace tab simultaneously showed SPAWN
  // events from the same response).
  _appendTrace(data.decision_trace || []);
  _renderDetectionsPanel(data);
  _renderLiveSwimlane();
  _renderDiagPanel(data.diag || null);
  _renderDebugTab(data);
}

// SIMU-05 · Debug tab content. Composes the live-status header
// (SIMU-05a) + five problem-clusters. SIMU-FIX-05b · skip rendering
// when the Debug tab isn't visible — the panel sits inside zone-
// detail which is display:none for inactive tabs, so the user
// can't see it anyway. Bailing here saves the per-tick cost of
// renderDebugPanel (header + 5 clusters via 5 outerHTML swaps).
// Subscribed to onTabChange so a switch INTO Debug fires a render
// immediately with the latest tick data.
