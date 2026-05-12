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
import { renderPanelTabs } from './panel-tabs.js';
import {
  ZONE_STROKE as _ZS, ZONE_FILL as _ZF,
  MASK_STROKE as _MS, MASK_FILL as _MF, LINE_W as _LW,
} from '../core/zone-tokens.js';
import { fittedRect } from '../core/video-fit.js';
import { lbRenderTrackTimeline } from '../mediathek/bbox-overlay/index.js';
import { _setupVideoChrome } from '../lightbox.js';

const _TICK_MIN_MS = 1000;
const _TICK_MAX_MS = 4000;
const _TICK_FACTOR = 1.2;
// 60 s sliding window for the swimlane. Detections older than this
// age out of the visible strip.
const _LIVE_WINDOW_MS = 60_000;
const _TRACE_CAP = 80;

let _session = null;
let _traceLines = [];
let _detBuffer = [];  // [{ms, label, score, bbox, verdict}, …]
let _overlays = { bboxes: true, trails: true, zones: true, masks: true };
let _selectedLabel = null;  // for detail-pill pin

export function openLiveDetect({ camId, cameraName }){
  if (!camId) return;
  closeLiveDetect();
  _session = { camId, cameraName, abort: null, tickHandle: null, fold: null };
  _traceLines = [];
  _detBuffer = [];
  _selectedLabel = null;
  _overlays = { bboxes: true, trails: true, zones: false, masks: false };
  _setupLiveChrome(camId, cameraName);
  _mountPanels();
  _tick();
  document.body.style.overflow = 'hidden';
}

export function closeLiveDetect(){
  const session = _session;
  _session = null;
  _traceLines = [];
  _detBuffer = [];
  _selectedLabel = null;
  if (!session) return;
  try { session.abort?.abort(); } catch { /* ignore */ }
  if (session.tickHandle) clearTimeout(session.tickHandle);
  const modal = byId('lightboxModal');
  if (modal) modal.classList.remove('lb-live-detect');
  const overlay = byId('lightboxLiveOverlay');
  if (overlay) overlay.remove();
  const toggleRow = byId('mvLiveToggles');
  if (toggleRow) toggleRow.remove();
  const livePill = byId('mvLiveScrubPill');
  if (livePill) livePill.remove();
}

function _setupLiveChrome(camId, cameraName){
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
    type:        'live-detect',
    event_id:    `live-${camId}`,
    camera_id:   camId,
    camera_name: cameraName || camId,
    time:        '',
    weather:     null,
    api_snapshot: null,
    _tracks:     { tracks: [] },
  };
  // _setupVideoChrome mounts lb-fs-video + relocates Close/Confirm/
  // Delete to the top-bar action cluster + calls lbRenderTrackTimeline
  // + mountRecordedPanels. We replace the panels mount below since
  // live-detect needs a Detections-only tab strip + the live
  // overlay-toggles row above the playbar.
  _setupVideoChrome(liveItem);
  const modal = byId('lightboxModal');
  if (modal){
    modal.classList.add('lb-live-detect');
    modal.classList.remove('hidden');
  }
  // Live mode title-bar marker — replaces the recorded timestamp.
  const tsEl = byId('lightboxTopTime');
  if (tsEl) tsEl.textContent = '● Live';
  // kr493 — Simulieren v2 continuous-stream redesign. The video is
  // now the SAME MJPEG sub-stream the dashboard tile + Live modal
  // use (stream.mjpg, ~15-25 fps), and the polling tick fetches
  // ONLY the detection payload (no_snapshot=1, ~1 kB response). The
  // bbox/trail overlays update at the detector's natural rate
  // (~1-2 fps) while the video itself stays smooth — no more
  // "5 seconds per real second" felt lag.
  const imgEl = byId('lightboxImg');
  const videoEl = byId('lightboxVideo');
  if (videoEl){ videoEl.pause(); videoEl.src = ''; videoEl.style.display = 'none'; }
  if (imgEl){
    const mjpegUrl = `/api/camera/${encodeURIComponent(camId)}/stream.mjpg`;
    imgEl.src = mjpegUrl;
    imgEl.style.display = 'block';
    // ph817 — zones + masks + bboxes must redraw whenever the
    // image's rendered size changes (first MJPEG frame arriving,
    // window resize, FS enter/exit, address-bar collapse on iOS).
    // The polling tick at 1 Hz repaints on its own cadence; this
    // listener bridges the gap so the overlays sit on the right
    // pixels the moment a frame paints, not 1 s later.
    if (!imgEl._zoneRefreshInstalled){
      const refresh = () => {
        _renderBboxOverlay();
        _renderZoneMaskOverlay();
      };
      imgEl.addEventListener('load', refresh);
      try {
        const obs = new ResizeObserver(refresh);
        obs.observe(imgEl);
        // Stash so a future re-mount can disconnect if needed.
        imgEl._zoneResizeObs = obs;
      } catch { /* older browsers — load listener still helps */ }
      imgEl._zoneRefreshInstalled = true;
    }
  }
  const confirmBtn = byId('lightboxConfirm');
  if (confirmBtn) confirmBtn.style.display = 'none';
  const delBtn = byId('lightboxDelete');
  if (delBtn) delBtn.style.display = 'none';
  _ensureBboxOverlay();
  _ensureZoneMaskOverlay();
  _mountOverlayToggles();
  _pinScrubberRight();
}

function _ensureBboxOverlay(){
  let svg = byId('lightboxLiveOverlay');
  if (svg) return svg;
  const wrap = byId('lightboxMediaWrap');
  if (!wrap) return null;
  svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'lightboxLiveOverlay';
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5';
  wrap.appendChild(svg);
  return svg;
}

function _ensureZoneMaskOverlay(){
  let svg = byId('lightboxLiveZoneMask');
  if (svg) return svg;
  const wrap = byId('lightboxMediaWrap');
  if (!wrap) return null;
  svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'lightboxLiveZoneMask';
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:4';
  wrap.appendChild(svg);
  return svg;
}

const _TOGGLES = [
  { id: 'bboxes',    label: 'Bboxes',
    desc: 'Erkannte Objekte als Rahmen über dem Video einblenden' },
  { id: 'trails',    label: 'Trails',
    desc: 'Bewegungspfade jeder erkannten Spur einzeichnen' },
  { id: 'zones',     label: 'Zonen',
    desc: 'Erkennungs-Zonen (grün) anzeigen' },
  { id: 'masks',     label: 'Masken',
    desc: 'Ausschluss-Masken (rot) anzeigen' },
];

// Shared tooltip popover state — one element, reused. Created lazily
// on the first hover / long-press. Same dark surface the rest of
// the lightbox uses, no new colours.
let _toggleTipEl = null;
let _toggleTipHoverTimer = 0;
let _toggleTipLongPressTimer = 0;

function _ensureToggleTip(){
  if (_toggleTipEl) return _toggleTipEl;
  _toggleTipEl = document.createElement('div');
  _toggleTipEl.className = 'mv-live-toggle-tip';
  _toggleTipEl.setAttribute('role', 'tooltip');
  _toggleTipEl.hidden = true;
  document.body.appendChild(_toggleTipEl);
  return _toggleTipEl;
}

function _showToggleTip(target, text){
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

function _hideToggleTip(){
  if (_toggleTipEl) _toggleTipEl.hidden = true;
  clearTimeout(_toggleTipHoverTimer);
  clearTimeout(_toggleTipLongPressTimer);
}

function _mountOverlayToggles(){
  const inner = byId('lightboxInner');
  const stack = byId('lightboxBottomStack');
  if (!inner || !stack) return;
  let row = byId('mvLiveToggles');
  if (!row){
    row = document.createElement('div');
    row.id = 'mvLiveToggles';
    row.className = 'mv-live-toggles';
    inner.insertBefore(row, stack);
  }
  // ``title`` carries the desktop-native tooltip fallback for
  // platforms where the custom hover bubble doesn't engage (the
  // browser will show its own bubble after ~700 ms). Touch devices
  // never trigger ``title`` — they get the long-press popover
  // below instead.
  row.innerHTML = _TOGGLES.map(t => (
    `<button type="button" class="mv-live-toggle" data-tog="${t.id}" data-desc="${esc(t.desc)}" data-on="${_overlays[t.id] ? '1' : '0'}" title="${esc(t.desc)}" aria-label="${esc(t.label)}: ${esc(t.desc)}">${t.label}</button>`
  )).join('') + '<span class="mv-live-toggles-hint">Esc · Klicke Bbox für Details</span>';
  row.querySelectorAll('.mv-live-toggle').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      // Suppress click after a long-press touch: the long-press
      // already opened the tooltip, the user didn't intend to
      // toggle. Detect via a flag set by touchstart below.
      if (btn._suppressClick){
        btn._suppressClick = false;
        ev.preventDefault();
        return;
      }
      const id = btn.dataset.tog;
      _overlays[id] = !_overlays[id];
      btn.dataset.on = _overlays[id] ? '1' : '0';
      _hideToggleTip();
      _renderBboxOverlay();
      _renderZoneMaskOverlay();
    });
    // Desktop hover — 300 ms before the tooltip appears.
    btn.addEventListener('pointerenter', (ev) => {
      if (ev.pointerType !== 'mouse') return;
      clearTimeout(_toggleTipHoverTimer);
      _toggleTipHoverTimer = setTimeout(
        () => _showToggleTip(btn, btn.dataset.desc || ''),
        300,
      );
    });
    btn.addEventListener('pointerleave', _hideToggleTip);
    // Touch long-press — ≥ 500 ms. Short-press still toggles via
    // the click handler above (touchend → click in the standard
    // event cycle); long-press shows the tooltip and suppresses
    // the synthetic click via the _suppressClick flag.
    btn.addEventListener('touchstart', () => {
      clearTimeout(_toggleTipLongPressTimer);
      _toggleTipLongPressTimer = setTimeout(() => {
        btn._suppressClick = true;
        _showToggleTip(btn, btn.dataset.desc || '');
      }, 500);
    }, { passive: true });
    btn.addEventListener('touchend', () => {
      clearTimeout(_toggleTipLongPressTimer);
      // Don't hide instantly — the user may want to read the
      // tooltip after lifting their finger. Auto-dismiss on the
      // next document touchstart.
    }, { passive: true });
    btn.addEventListener('touchcancel', () => {
      clearTimeout(_toggleTipLongPressTimer);
    });
  });
  // Outside-tap dismiss for the touch path.
  document.addEventListener('touchstart', (ev) => {
    if (!_toggleTipEl || _toggleTipEl.hidden) return;
    if (ev.target.closest && ev.target.closest('.mv-live-toggle')) return;
    _hideToggleTip();
  }, { passive: true });
}

function _pinScrubberRight(){
  // Live mode has no recorded clip → no seek; pin the playhead to
  // the right edge by writing --play-pct=1 and adding an "LIVE" pill
  // overlay anchored to the scrubber row. lbRenderTrackTimeline
  // rebuilds the stack on each call so this re-pins after each refresh.
  const stack = document.querySelector('.lb-time-stack');
  if (stack) stack.style.setProperty('--play-pct', '1');
  const stackHost = byId('lightboxBottomStack');
  if (!stackHost) return;
  let pill = byId('mvLiveScrubPill');
  if (!pill){
    pill = document.createElement('span');
    pill.id = 'mvLiveScrubPill';
    pill.className = 'mv-live-scrub-pill';
    pill.textContent = '● LIVE';
    stackHost.appendChild(pill);
  }
}

function _mountPanels(){
  const host = byId('lightboxSettings');
  if (!host) return;
  host.hidden = false;
  host.innerHTML = `
    <div class="mv-recorded-panels">
      <div class="mv-recorded-tabs"></div>
      <div class="mv-recorded-fafold"></div>
    </div>`;
  const tabsHost = host.querySelector('.mv-recorded-tabs');
  const faHost = host.querySelector('.mv-recorded-fafold');
  const tabs = [{
    id: 'detections',
    label: 'Detections',
    render: (h) => {
      h.innerHTML = `<div id="mvLdDetections" class="mv-ld-detections"><div class="mv-ld-empty">Noch keine Detektion …</div></div>`;
    },
  }];
  renderPanelTabs(tabsHost, tabs, { initialId: 'detections' });
  const fold = renderFineAnalysisFold(faHost, null, { defaultOpen: true });
  if (_session) _session.fold = fold;
}

async function _tick(){
  const session = _session;
  if (!session) return;
  try { session.abort?.abort(); } catch { /* ignore */ }
  session.abort = new AbortController();
  const controller = session.abort;
  const cycleStart = performance.now();
  try {
    const r = await fetch(
      `/api/cameras/${encodeURIComponent(session.camId)}/test-detection?no_snapshot=1`,
      { method: 'POST', signal: controller.signal },
    );
    if (_session !== session) return;
    let data = null;
    try { data = await r.json(); } catch { /* keep null */ }
    if (data?.ok) _renderFrame(data);
  } catch (err) {
    if (err?.name === 'AbortError') return;
  }
  _scheduleNext(session, performance.now() - cycleStart);
}

function _scheduleNext(session, lastCycleMs){
  if (_session !== session) return;
  const projected = Math.round(
    (Number.isFinite(lastCycleMs) ? lastCycleMs : _TICK_MIN_MS) * _TICK_FACTOR,
  );
  const delay = Math.min(_TICK_MAX_MS, Math.max(_TICK_MIN_MS, projected));
  session.tickHandle = setTimeout(_tick, delay);
}

function _renderFrame(data){
  // kr493 — Simulieren v2 no longer paints data.snapshot into
  // #lightboxImg. The img element streams the continuous MJPEG
  // (set in _setupLiveChrome on mount); this tick only updates
  // the detection overlays + state. data.snapshot is still emitted
  // by the backend when ?no_snapshot is unset (other callers rely
  // on it) — Simulieren just ignores it.
  // Frame state for the bbox + zone/mask overlays.
  _session.lastFrameSize = data.frame_size || { w: 1920, h: 1080 };
  _session.lastDetections = data.detections || [];
  // Buffer detections for the swimlane window (one entry per detection
  // per tick; per-track id would be ideal here but the live tracker
  // doesn't expose ids — group by label instead).
  const now = Date.now();
  for (const d of (data.detections || [])){
    _detBuffer.push({ ms: now, label: d.label, score: d.score, bbox: d.bbox, verdict: d.verdict });
  }
  // Drop entries older than the window.
  const cutoff = now - _LIVE_WINDOW_MS;
  _detBuffer = _detBuffer.filter(e => e.ms >= cutoff);
  _renderBboxOverlay();
  _renderZoneMaskOverlay();
  _renderDetectionsPanel(data);
  _renderLiveSwimlane();
  _appendTrace(data.decision_trace || []);
}

function _renderBboxOverlay(){
  const svg = _ensureBboxOverlay();
  if (!svg || !_session) return;
  svg.style.display = _overlays.bboxes ? 'block' : 'none';
  if (!_overlays.bboxes){ svg.innerHTML = ''; return; }
  const fs = _session.lastFrameSize || { w: 1920, h: 1080 };
  svg.setAttribute('viewBox', `0 0 ${fs.w} ${fs.h}`);
  _positionSvgOverImage(svg);
  svg.innerHTML = (_session.lastDetections || []).map(d => {
    const c = colors[d.label] || colors.unknown;
    const op = d.verdict === 'pass' ? 1 : d.verdict === 'belowthresh' ? 0.55 : 0.30;
    const [x, y, bw, bh] = d.bbox;
    const txt = `${OBJ_LABEL[d.label] || d.label} · ${Math.round((d.score || 0) * 100)} %`;
    const stroke = (_selectedLabel === d.label) ? 5 : 3;
    return `<g opacity="${op}" data-label="${esc(d.label)}" style="pointer-events:auto;cursor:pointer">
      <rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="none" stroke="${c}" stroke-width="${stroke}" vector-effect="non-scaling-stroke"/>
      <text x="${x + 4}" y="${y + 20}" fill="${c}" font-size="14" font-family="system-ui, sans-serif" font-weight="700" paint-order="stroke" stroke="rgba(0,0,0,0.7)" stroke-width="3">${esc(txt)}</text>
    </g>`;
  }).join('');
  // Click handler — toggle detail-pill selection.
  svg.style.pointerEvents = 'auto';
  svg.querySelectorAll('[data-label]').forEach(g => {
    g.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const lbl = g.dataset.label;
      _selectedLabel = (_selectedLabel === lbl) ? null : lbl;
      _renderBboxOverlay();
      _renderDetailPill();
    });
  });
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
function _positionSvgOverImage(svg){
  const imgEl = byId('lightboxImg');
  const wrap = byId('lightboxMediaWrap');
  if (!imgEl || !wrap) return;
  const wrapBox = wrap.getBoundingClientRect();
  const imgBox = imgEl.getBoundingClientRect();
  if (wrapBox.width <= 0 || imgBox.width <= 0) return;
  const fit = fittedRect(imgEl);
  // fit is relative to the img's content box; the img's content box
  // top-left = imgBox.top/left - wrapBox.top/left.
  const dx = (imgBox.left - wrapBox.left) + fit.x;
  const dy = (imgBox.top  - wrapBox.top)  + fit.y;
  svg.style.left = `${dx}px`;
  svg.style.top  = `${dy}px`;
  svg.style.width  = `${fit.w}px`;
  svg.style.height = `${fit.h}px`;
  svg.style.right  = 'auto';
  svg.style.bottom = 'auto';
  svg.style.inset  = 'auto';
}


function _renderZoneMaskOverlay(){
  const svg = _ensureZoneMaskOverlay();
  if (!svg || !_session) return;
  const showZones = _overlays.zones;
  const showMasks = _overlays.masks;
  if (!showZones && !showMasks){ svg.innerHTML = ''; svg.style.display = 'none'; return; }
  svg.style.display = 'block';
  const fs = _session.lastFrameSize || { w: 1920, h: 1080 };
  svg.setAttribute('viewBox', `0 0 ${fs.w} ${fs.h}`);
  _positionSvgOverImage(svg);
  const cam = (state.cameras || []).find(c => c.id === _session.camId) || {};
  // Stroke / fill colours pulled from core/zone-tokens.js so the
  // visual matches the cam-edit polygon editor + every other
  // read-only overlay context exactly (cm-43). SVG viewBox is
  // already in source coordinates, so a non-scaling-stroke keeps
  // the LINE_W constant regardless of the rendered size.
  const parts = [];
  if (showZones){
    for (const z of (cam.zones || [])){
      const pts = (z.points || z.poly || []).map(p => `${p.x || p[0]},${p.y || p[1]}`).join(' ');
      if (pts){
        parts.push(`<polygon points="${pts}" fill="${_ZF}" stroke="${_ZS}" stroke-width="${_LW}" vector-effect="non-scaling-stroke"/>`);
      }
    }
  }
  if (showMasks){
    for (const m of (cam.masks || [])){
      const pts = (m.points || m.poly || []).map(p => `${p.x || p[0]},${p.y || p[1]}`).join(' ');
      if (pts){
        parts.push(`<polygon points="${pts}" fill="${_MF}" stroke="${_MS}" stroke-width="${_LW}" vector-effect="non-scaling-stroke"/>`);
      }
    }
  }
  svg.innerHTML = parts.join('');
}

function _renderDetectionsPanel(data){
  const detHost = byId('mvLdDetections');
  if (!detHost) return;
  const dets = data.detections || [];
  if (!dets.length){
    detHost.innerHTML = `<div class="mv-ld-empty">Keine Objekte erkannt</div>`;
    return;
  }
  detHost.innerHTML = dets.map(d => {
    const c = colors[d.label] || colors.unknown;
    const lblText = OBJ_LABEL[d.label] || d.label;
    const tone = d.verdict === 'pass' ? 'ok' : d.verdict === 'belowthresh' ? 'warn' : 'mute';
    const verdictText = d.verdict === 'pass' ? 'PASS'
                      : d.verdict === 'belowthresh' ? 'unter Schwelle'
                      : d.verdict === 'filtered' ? 'gefiltert' : '—';
    return `<div class="mv-ld-row" data-tone="${tone}" data-label="${esc(d.label)}">
      <span class="mv-ld-row-bar" style="background:${c}"></span>
      <span class="mv-ld-row-label">${esc(lblText)}</span>
      <span class="mv-ld-row-score">${Math.round((d.score || 0) * 100)} %</span>
      <span class="mv-ld-row-verdict">${esc(verdictText)}</span>
    </div>`;
  }).join('');
  detHost.querySelectorAll('.mv-ld-row').forEach(row => {
    row.addEventListener('click', () => {
      const lbl = row.dataset.label;
      _selectedLabel = (_selectedLabel === lbl) ? null : lbl;
      _renderBboxOverlay();
      _renderDetailPill();
    });
  });
}

function _renderLiveSwimlane(){
  // Build a synthetic _tracks payload from the 60 s buffer (one
  // synthetic track per label) and ask the recorded swimlane to
  // render it. Sample timestamps are shifted into [0, 60] so the
  // existing rendering treats the window as a 60-second "clip".
  if (!_session) return;
  const now = Date.now();
  const windowStart = now - _LIVE_WINDOW_MS;
  const byLabel = new Map();
  for (const e of _detBuffer){
    if (e.ms < windowStart) continue;
    const t = (e.ms - windowStart) / 1000;
    if (!byLabel.has(e.label)) byLabel.set(e.label, []);
    byLabel.get(e.label).push({
      f: byLabel.get(e.label).length,
      t,
      bbox: { x1: e.bbox?.[0] || 0, y1: e.bbox?.[1] || 0,
              x2: (e.bbox?.[0] || 0) + (e.bbox?.[2] || 0),
              y2: (e.bbox?.[1] || 0) + (e.bbox?.[3] || 0) },
      score: e.score,
      source: 'detect',
    });
  }
  const tracks = [];
  for (const [label, samples] of byLabel.entries()){
    tracks.push({
      track_id: `live-${label}`,
      label,
      color: colors[label] || '#94a3b8',
      first_frame: 0,
      last_frame: samples.length - 1,
      best_score: Math.max(0, ...samples.map(s => s.score || 0)),
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

function _renderDetailPill(){
  const wrap = byId('lightboxMediaWrap');
  if (!wrap) return;
  let pill = byId('mvLiveDetailPill');
  if (!_selectedLabel){
    if (pill) pill.remove();
    return;
  }
  if (!pill){
    pill = document.createElement('div');
    pill.id = 'mvLiveDetailPill';
    pill.className = 'mv-live-detail-pill';
    wrap.appendChild(pill);
  }
  const c = colors[_selectedLabel] || colors.unknown;
  const lblText = OBJ_LABEL[_selectedLabel] || _selectedLabel;
  // Find the live detection for this label (most recent).
  const det = (_session?.lastDetections || []).find(d => d.label === _selectedLabel);
  if (!det){
    pill.innerHTML = `<div class="mv-live-detail-head" style="color:${c}">${esc(lblText)}</div>
      <div class="mv-live-detail-empty">Aktuell nicht im Bild</div>`;
    return;
  }
  const cam = (state.cameras || []).find(x => x.id === _session.camId) || {};
  const perCls = cam.label_thresholds || {};
  const generalThresh = Number(cam.detection_min_score) || 0.55;
  const scoreThresh = perCls[_selectedLabel] != null
    ? Number(perCls[_selectedLabel]) : generalThresh;
  const fs = _session.lastFrameSize || { w: 1920, h: 1080 };
  const bh = det.bbox?.[3] || 0;
  const bw = det.bbox?.[2] || 0;
  const fracH = fs.h > 0 ? bh / fs.h : 0;
  const fracArea = (fs.w * fs.h) > 0 ? (bw * bh) / (fs.w * fs.h) : 0;
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

function _appendTrace(lines){
  if (!Array.isArray(lines) || !_session?.fold) return;
  for (const line of lines){
    _traceLines.push({ kind: _classifyTrace(line), text: line });
  }
  while (_traceLines.length > _TRACE_CAP) _traceLines.shift();
  const body = document.querySelector('#lightboxSettings .mv-fafold-body');
  const wasAtBottom = body
    ? (body.scrollHeight - body.scrollTop - body.clientHeight) < 24
    : true;
  _session.fold.setLines(_traceLines);
  if (body && wasAtBottom){
    body.scrollTop = body.scrollHeight;
  }
}

function _classifyTrace(line){
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
void OBJ_SVG; void objIconSvg;

window.closeLiveDetect = closeLiveDetect;
