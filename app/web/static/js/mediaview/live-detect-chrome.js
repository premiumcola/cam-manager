// ─── mediaview/live-detect-chrome.js ───────────────────────────────────────
// Mounts the live-detect chrome onto the recorded lightbox shell + 5-zone
// skeleton: the snapshot <img>, the SVG overlay layers, the shared overlay-
// toggle bar, the STREAM + Aus/Motion-ROI/2x2/3x3 sim controls, the scrubber
// pin, and the Detections/Trace panel hosts. Reads state via S.
import { byId, esc } from '../core/dom.js';
import { S } from './live-detect-state.js';
import { MV_DETECTION_MODES } from './mode-indicator.js';
import { renderOverlayToggles } from './overlay-toggles.js';
import { renderFineAnalysisFold } from './fine-analysis-fold.js';
import { _setupVideoChrome } from '../lightbox.js';
import { _renderBboxOverlay } from './live-detect-bbox.js';
import { zoneEl, mountLdSkeleton } from './live-detect-skeleton.js';
import {
  _installLiveOverlayRefresh,
  _ensureBboxOverlay,
  _ensureTrailsOverlay,
  _ensureZoneMaskOverlay,
  _renderTrailsOverlay,
  _renderZoneMaskOverlay,
} from './live-detect-overlays.js';
import { _renderLiveSwimlane } from './live-detect-panels.js';
import { _tick } from './live-detect-poll.js';

export function _setupLiveChrome(camId, cameraName) {
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
export function _forceImmediateTick() {
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
export function _mountSimControls() {
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

export function _mountPanels() {
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

