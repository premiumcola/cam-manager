// ─── camedit/erk-sim/live.js ───────────────────────────────────────────────
// Live-detection toggle. Pressing the simulate button starts a 1 Hz
// polling loop against /api/cameras/<id>/test-detection; pressing
// again stops it and freezes the last-rendered frame in place. A
// client-side IoU tracker (tracker.js) keeps subject identity stable
// across ticks so detected objects get a fading path-trail rather
// than blinking on/off whenever inference timing skews a bbox.
//
// The polling lifecycle self-polices: every tick checks that the
// camera id in the form still matches what the loop was started
// against AND that the result panel is still visible. Either failing
// silently stops the loop — no hard coupling to editCamera() or the
// panel-close handler.
import { byId, esc } from '../../core/dom.js';
import { state as appState } from '../../core/state.js';
import { _renderErkSimError, _renderErkSimResult } from './snapshot.js';
import { IoUTracker } from './tracker.js';
import { LiveTimeline } from './timeline.js';
import { renderThresholdStrip, hideThresholdStrip } from './thresholds.js';
import { renderOverlayToggles } from '../../mediaview/overlay-toggles.js';
import {
  ZONE_STROKE, ZONE_FILL, MASK_STROKE, MASK_FILL,
} from '../../core/zone-tokens.js';
import { buildTrailSvg } from '../../mediaview/canvas/trail-layer.js';

// Floor/ceiling for the adaptive polling cadence. Fast healthy ticks
// stay at 1 Hz (the floor); a backend that takes ~3 s to deliver a
// validated frame backs us off to 0.25 Hz so requests don't pile up.
// The 1.2× multiplier on the previous cycle gives the loop a bit of
// headroom over the measured rate without latching to a slow value.
const _TICK_MIN_MS = 1000;
const _TICK_MAX_MS = 4000;
const _TICK_FACTOR = 1.2;
const _PATH_CAP = 12;     // points painted per trail; tracker stores up to 60

let _session = null;      // null when idle; one object per active live run

// Layer visibility flags driven by the overlay-toggles pill bar.
// Module-scoped so the SVG layer renderers and the toggle handler
// share state without round-tripping through DOM attributes.
const _layerVisible = { bboxes: true, trails: true, zones: false, masks: false };
// Cached frame_size so the pill-toggle redraws can re-render zones /
// masks without needing a fresh inference response (zones don't
// change per tick — they're static camera config). Trails / bboxes
// have no stand-alone redraw because they need fresh tick data.
let _lastFrameSize = null;

const _IDLE_HTML = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polygon points="5 3 19 12 5 21 5 3"/>
  </svg>
  <span class="erk-test-btn-lbl">Erkennung jetzt simulieren</span>
`;

const _LIVE_HTML = `
  <span class="erk-live-dot" aria-hidden="true"></span>
  <span class="erk-test-btn-lbl">Live-Erkennung läuft · Stop</span>
`;

// Public — wired by erk-sim/index.js as the simulate-button click
// handler. Single function gates start/stop, so the button's text
// + class swap drive a single state machine.
export function _onErkSimulateClick(ev){
  if (_session){
    stopLive();
  } else {
    startLive(ev.currentTarget);
  }
}

// Public — called by the panel-close handler in index.js so dismiss
// stops the loop synchronously, not "next tick".
export function stopLive(){
  if (!_session) return;
  const { btn, abort, tickHandle, toggleHandle } = _session;
  try { abort?.abort(); } catch { /* ignore */ }
  if (tickHandle) clearTimeout(tickHandle);
  try { toggleHandle?.teardown?.(); } catch { /* ignore */ }
  const togRow = byId('erkSimToggles');
  if (togRow) togRow.remove();
  hideThresholdStrip();
  _session = null;
  _lastFrameSize = null;
  if (btn){
    btn.classList.remove('is-live');
    btn.disabled = false;
    btn.innerHTML = _IDLE_HTML;
  }
}

function startLive(btn){
  const camId = byId('cameraForm')?.elements?.['id']?.value;
  if (!camId || !btn) return;
  btn.classList.add('is-live');
  btn.innerHTML = _LIVE_HTML;
  const timeline = new LiveTimeline();
  const tlHost = byId('erkSimTimeline');
  if (tlHost){
    tlHost.hidden = false;
    timeline.render(tlHost, Date.now(), Date.now());  // empty-state hello
  }
  // Overlay-toggles pill bar — same component the Mediathek and live-
  // view contexts mount. Lives just above the snapshot wrap so the
  // pills sit naturally next to the frame they affect; the
  // contextKey scopes localStorage so bboxes/trails persist across
  // page loads but zones/masks always re-open at the declared default.
  const toggleHandle = _mountToggleBar();
  // Sync the initial layer state to whatever the toggle bar resolved
  // (persisted user preference for bboxes/trails; declared defaults
  // for zones/masks). Without this the layer renderers' own defaults
  // could diverge from a remembered "user turned X off last time"
  // preference.
  const initial = toggleHandle?.getState?.() || {};
  if ('bboxes' in initial) _layerVisible.bboxes = !!initial.bboxes;
  if ('trails' in initial) _layerVisible.trails = !!initial.trails;
  if ('zones'  in initial) _layerVisible.zones  = !!initial.zones;
  if ('masks'  in initial) _layerVisible.masks  = !!initial.masks;
  _applyLayerVisibility();
  _session = {
    btn,
    camId,
    tracker: new IoUTracker(),
    timeline,
    toggleHandle,
    startedAt: Date.now(),
    abort: null,
    tickHandle: null,
  };
  // Kick the first tick immediately so the user sees a frame within
  // a couple hundred ms; subsequent ticks are paced by _scheduleNext.
  _tick();
}

function _mountToggleBar(){
  const wrap = byId('erkSimResult');
  if (!wrap) return null;
  // Insert the bar between the result-head and the live body so the
  // pills sit above the snapshot — matches the Mediathek lightbox
  // layout where the pill row is the first thing under the close × bar.
  let row = byId('erkSimToggles');
  const body = byId('erkSimLiveBody');
  if (!row){
    row = document.createElement('div');
    row.id = 'erkSimToggles';
    row.className = 'mv-live-toggles erk-sim-toggles';
    if (body && body.parentNode){
      body.parentNode.insertBefore(row, body);
    } else {
      wrap.appendChild(row);
    }
  }
  return renderOverlayToggles(row, {
    available:  ['bboxes', 'trails', 'zones', 'masks'],
    contextKey: 'erk-sim',
    hintText:   'Lange drücken für Beschreibung',
    onChange: (id, on, _all) => {
      if (!(id in _layerVisible)) return;
      _layerVisible[id] = !!on;
      _applyLayerVisibility();
      // Zones / masks don't get re-painted from a tick (they're
      // static camera config), so force a redraw of just that layer
      // whenever the user flips their pills. Bboxes / trails are
      // tick-driven so toggling them is purely a visibility flip
      // — the next tick redraws into the layer either way.
      if (id === 'zones' || id === 'masks') _redrawZoneMaskLayer();
    },
  });
}

function _applyLayerVisibility(){
  const ovl = byId('erkSimOverlay');
  if (!ovl) return;
  for (const id of ['bboxes', 'trails', 'zones', 'masks']){
    // zones and masks share one layer group (erk-zonemask-layer);
    // either flag visible → render group; both off → hide.
    let g = null;
    if (id === 'bboxes') g = ovl.querySelector('.erk-bboxes-layer');
    else if (id === 'trails') g = ovl.querySelector('.erk-trails-layer');
    // Zone/mask group visibility is computed once below — the
    // individual zones/masks pills affect _what_ paints into the
    // group, not whether the group itself is hidden.
    if (g) g.setAttribute('visibility', _layerVisible[id] ? 'visible' : 'hidden');
  }
  const zg = ovl.querySelector('.erk-zonemask-layer');
  if (zg){
    const anyOn = _layerVisible.zones || _layerVisible.masks;
    zg.setAttribute('visibility', anyOn ? 'visible' : 'hidden');
  }
}

function _redrawZoneMaskLayer(){
  const ovl = byId('erkSimOverlay');
  const layer = ovl?.querySelector('.erk-zonemask-layer');
  if (!layer || !_session) return;
  const cam = (appState.cameras || []).find(c => (c.id || '') === _session.camId);
  if (!cam){ layer.innerHTML = ''; return; }
  const fs = _lastFrameSize || { w: 1920, h: 1080 };
  // Parse preview_resolution ("640×360") for legacy polygons missing
  // source_w/source_h — same fallback the Mediathek mount uses, so
  // legacy zones drawn against the substream snapshot keep mapping
  // correctly onto the simulation snapshot's frame size.
  let fbW = 0, fbH = 0;
  const pres = String(cam.preview_resolution || '');
  const presM = pres.match(/(\d+)\s*[x×]\s*(\d+)/);
  if (presM){ fbW = parseInt(presM[1], 10) || 0; fbH = parseInt(presM[2], 10) || 0; }
  // SVG strokeWidth scales with the viewBox; use vector-effect so a
  // 2 px stroke reads the same regardless of frame_size.
  const polyToSvg = (poly, stroke, fill) => {
    const points = (poly.points || poly.poly || poly);
    if (!Array.isArray(points) || points.length < 2) return '';
    const srcW = poly.source_w || fbW || fs.w;
    const srcH = poly.source_h || fbH || fs.h;
    const sx = fs.w / Math.max(1, srcW);
    const sy = fs.h / Math.max(1, srcH);
    const pts = points.map(pt => {
      const x = (pt.x ?? pt[0]) ?? 0;
      const y = (pt.y ?? pt[1]) ?? 0;
      return `${x * sx},${y * sy}`;
    }).join(' ');
    return `<polygon points="${pts}" fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="2" vector-effect="non-scaling-stroke" />`;
  };
  const parts = [];
  if (_layerVisible.masks){
    for (const m of (cam.masks || [])){
      parts.push(polyToSvg(m, MASK_STROKE, MASK_FILL));
    }
  }
  if (_layerVisible.zones){
    for (const z of (cam.zones || [])){
      parts.push(polyToSvg(z, ZONE_STROKE, ZONE_FILL));
    }
  }
  layer.innerHTML = parts.join('');
}

async function _tick(){
  const session = _session;
  if (!session) return;
  // Self-policing invariants — bail when the form swapped to a
  // different camera or the result panel got dismissed.
  const formCamId = byId('cameraForm')?.elements?.['id']?.value;
  const wrap = byId('erkSimResult');
  if (formCamId !== session.camId){ stopLive(); return; }
  if (wrap?.hidden && wrap.dataset.everShown === '1'){ stopLive(); return; }

  try { session.abort?.abort(); } catch { /* ignore */ }
  session.abort = new AbortController();
  const controller = session.abort;

  // performance.now is monotonic and immune to wall-clock jumps; we
  // only care about elapsed milliseconds, so it's the right basis for
  // the adaptive cadence below.
  const cycleStart = performance.now();

  try {
    const r = await fetch(
      `/api/cameras/${encodeURIComponent(session.camId)}/test-detection`,
      { method: 'POST', signal: controller.signal },
    );
    if (_session !== session) return;  // superseded by a stop click
    let data = null;
    try { data = await r.json(); } catch { /* keep null */ }
    // Structured 503: backend says it can't honour the freshness
    // contract right now. Surface a precise banner so the user knows
    // we're not faking a real-time picture, and skip the bbox/trail
    // painting entirely — there's no valid frame to draw on.
    if (r.status === 503 && data && data.code){
      _renderErkSimError(data);
      if (wrap) wrap.dataset.everShown = '1';
      _scheduleNext(session, performance.now() - cycleStart);
      return;
    }
    if (!r.ok || !data?.ok){
      // Other transient backend failure — keep polling silently. The
      // user gets visual feedback only via the absence of fresh boxes.
      _scheduleNext(session, performance.now() - cycleStart);
      return;
    }

    _renderErkSimResult(data);
    if (wrap) wrap.dataset.everShown = '1';
    _lastFrameSize = data.frame_size || _lastFrameSize;
    _redrawZoneMaskLayer();
    _applyLayerVisibility();

    const dets = (data.detections || []).map(d => ({
      label: d.label,
      bbox: d.bbox,
      score: d.score,
      verdict: d.verdict,
    }));
    const now_ms = Date.now();
    // Push the latest form thresholds into the tracker BEFORE the tick
    // so editing track_iou_match_threshold / track_miss_grace_seconds
    // takes effect immediately. The IoU and grace thresholds are the
    // two the tracker actually uses for matching/expiry; spawn/cont
    // floors are scoring-only and reported via the strip below.
    const formEl = byId('cameraForm');
    const fF = formEl?.elements;
    const _live = (name) => {
      const v = parseFloat(fF?.[name]?.value);
      return Number.isFinite(v) && v > 0 ? v : null;
    };
    session.tracker.setThresholds({
      minIou: _live('track_iou_match_threshold'),
      missGraceMs: (() => {
        const s = _live('track_miss_grace_seconds');
        return s != null ? s * 1000 : null;
      })(),
    });
    const confirmed = session.tracker.tick(dets, now_ms);
    const dropped = session.tracker.lastDropped();
    _renderTrails(confirmed, data.frame_size);
    session.timeline.observe(confirmed, dropped, now_ms);
    const tlHost = byId('erkSimTimeline');
    if (tlHost) session.timeline.render(tlHost, now_ms, session.startedAt);
    // K13 · threshold info strip — paints AFTER tick() so the strip
    // reads the freshest tracker state. Hidden on stopLive() so a
    // frozen frame doesn't show stale "aktuell" numbers as if the
    // loop were still running.
    if (formEl) renderThresholdStrip(formEl, session.tracker, now_ms);
  } catch (e) {
    if (e?.name === 'AbortError') return;
    // network error — keep polling, intentionally silent (a toast on
    // every tick would be noise).
  }
  _scheduleNext(session, performance.now() - cycleStart);
}

function _scheduleNext(session, lastCycleMs){
  if (_session !== session) return;
  // Clamp the next delay to [floor, ceiling]. Slow cycles back off
  // automatically; fast cycles stay at the floor so a healthy stream
  // still polls at 1 Hz.
  const projected = Math.round((Number.isFinite(lastCycleMs) ? lastCycleMs : _TICK_MIN_MS) * _TICK_FACTOR);
  const delay = Math.min(_TICK_MAX_MS, Math.max(_TICK_MIN_MS, projected));
  session.tickHandle = setTimeout(_tick, delay);
}

// Per-track palette — 12 distinct hues so two simultaneous subjects
// always paint distinguishable trails regardless of class. Indexed by
// the IoUTracker's monotonically-increasing track id; ids 13+ wrap
// back to the top, which is fine because the visual collision only
// matters within a single concurrent set (the tracker drops stale
// ids well before the next one of the same modulo arrives).
const _TRAIL_PALETTE = [
  '#facc15', '#fb923c', '#38bdf8', '#f87171', '#a78bfa', '#34d399',
  '#f472b6', '#fbbf24', '#22d3ee', '#fb7185', '#c084fc', '#86efac',
];
function _trailColorForTrack(id){
  const n = Math.max(0, (id | 0) - 1);
  return _TRAIL_PALETTE[n % _TRAIL_PALETTE.length];
}

// Paint per-track polyline trails into the dedicated layer group
// inside the SVG overlay. The layer's z-order (declared in
// snapshot.js's overlay skeleton) keeps trails BEHIND bboxes.
//
// Stroke is per-TRACK-id so two simultaneous subjects get visibly
// distinct trails. Each polyline is split into per-segment lines
// with linearly-ramped stroke-opacity so the newest segment reads
// nearly solid and the oldest fades toward transparent — matches
// the Mediathek lightbox trail layer's visual treatment so the
// user sees the same UI between the recorded and live contexts.
function _renderTrails(tracks, frame_size){
  const ovl = byId('erkSimOverlay');
  const layer = ovl?.querySelector('.erk-trails-layer');
  if (!layer){ return; }
  if (!tracks || tracks.length === 0){
    layer.innerHTML = '';
    return;
  }
  const fs = frame_size || { w: 1920, h: 1080 };
  const strokeW = Math.max(2, Math.round(fs.w / 720));
  const verdictMul = (v) => v === 'pass' ? 1
                          : v === 'belowthresh' ? 0.7
                          : v === 'filtered' ? 0.4 : 0.85;
  // Same fade ramp + head-dot visual as the Mediathek recorded-clip
  // trail layer (mediaview/canvas/trail-layer.js · buildTrailSvg).
  // Per-verdict opacity scaling dims filtered/below-threshold tracks
  // uniformly so the alarm vs noise signal stays readable.
  const parts = [];
  for (const t of tracks){
    const path = t.path.slice(-_PATH_CAP);
    if (path.length < 2) continue;
    const c = _trailColorForTrack(t.id);
    const points = path.map(p => ({ x: p.cx, y: p.cy }));
    const inner = buildTrailSvg(points, c, strokeW, verdictMul(t.last_verdict));
    if (inner) parts.push(`<g class="erk-track-trail" data-track="${t.id}">${inner}</g>`);
  }
  layer.innerHTML = parts.join('');
}
