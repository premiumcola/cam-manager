// ─── mediathek/bbox-overlay/timeline-panel.js ──────────────────────────────
// Bottom-of-lightbox component: one row per class with ≥1 track. Each
// row renders a class badge (toggle button) + a strip with per-track
// bars. Bars carry the track's per-clip number (#1, #2, …) and a red
// × marker when the track ended before video duration. Tap a bar to
// seek the video; tap the badge to hide that class's bboxes.
import { byId } from '../../core/dom.js';
import { colors, OBJ_LABEL, OBJ_SVG } from '../../core/icons.js';
import { lbState } from '../state.js';
import { _state } from './_state.js';
import {
  _getHiddenClassesForCam,
  _setHiddenClassesForCam,
} from './hidden-classes.js';
import { _lbDrawDetections, _resolveAllowedLabels } from './renderer.js';
import {
  _updatePlayPct,
  _wirePlayButton,
  _wirePlayCursorDrag,
  _wireScrubBar,
} from './time-axis.js';
import { _wireBarEndTooltips } from './track-loss-tooltip.js';

export function lbClearTrackTimeline(){
  const host = byId('lightboxBottomStack');
  if (!host) return;
  host.innerHTML = '';
}

// Master renderer for the entire bottom-stack chrome — sidebar (play
// button + class badges + tick spacer) and time column (scrubber bar
// + per-class strips + tick row + play cursor). One column owns the
// time-axis x-coordinates, so the scrubber thumb, every strip bar,
// every tick label, and the play cursor all share a single left
// origin. The shared --play-pct CSS variable on .lb-time-stack drives
// scrubber-fill width + scrubber-thumb left + play-line left in
// lockstep so a single rAF write paints all three.
export function lbRenderTrackTimeline(item){
  const host = byId('lightboxBottomStack');
  if (!host) return;
  if (!item){ host.innerHTML = ''; return; }

  const isTimelapse = item.type === 'timelapse';
  const tracks = item._tracks;
  const haveTracks = !!(tracks
    && Array.isArray(tracks.tracks) && tracks.tracks.length > 0);
  // Camera-side allowed-labels filter (same as the canvas render
  // path). Only classes that pass the filter get a row; hidden-classes
  // are still rendered as a row (with the badge dimmed) so the user
  // can re-enable them.
  const allowed = _resolveAllowedLabels();
  const camId = item.camera_id || '';
  const hidden = _getHiddenClassesForCam(camId);

  // Duration — prefer videoEl.duration (real metadata) and fall back
  // to the tracks' max sample timestamp for the rare pre-metadata
  // render. Used for bar percentages + tick labels.
  const videoEl = byId('lightboxVideo');
  const vidDur = Number.isFinite(videoEl?.duration) && videoEl.duration > 0
    ? videoEl.duration : 0;
  let maxT = 0;
  if (haveTracks){
    for (const tr of tracks.tracks){
      for (const sm of (tr.samples || [])){
        if (sm.t > maxT) maxT = sm.t;
      }
    }
  }
  const duration = vidDur || maxT || 1;
  _state.timelineDuration = duration;

  // Per-clip stable index map for the × tooltip handler.
  _state.timelineTrackIndex = haveTracks ? tracks.tracks : [];

  // Group tracks → per-class buckets, ordered by OBJ_LABEL so the
  // strip stack stays stable across re-opens.
  const byLabel = new Map();
  let perClipNum = 0;
  if (haveTracks){
    for (const tr of tracks.tracks){
      perClipNum++;
      const lbl = tr.label || 'unknown';
      if (allowed !== null && !allowed.has(lbl)) continue;
      if (!byLabel.has(lbl)) byLabel.set(lbl, []);
      byLabel.get(lbl).push({ ...tr, _num: perClipNum });
    }
  }
  const orderedLabels = Object.keys(OBJ_LABEL).filter(l => byLabel.has(l));
  for (const l of byLabel.keys()){
    if (!orderedLabels.includes(l)) orderedLabels.push(l);
  }

  // Build sidebar + time-col items as parallel arrays so vertical
  // alignment between badge[i] and strip[i] is preserved by the flex
  // column natural order.
  const sidebarParts = [];
  const timeColParts = [];

  // Scrubber row — always present. Play button lives in the sidebar
  // (NOT inside the scrubber bar). Scrubber bar is full-width in the
  // time column so its leading 0 % aligns with every strip's 0 %.
  sidebarParts.push(`
    <button type="button" id="lbScrubPlay" class="lb-play-btn" aria-label="Play / Pause">
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5l13 7-13 7z"/></svg>
    </button>`);
  timeColParts.push(`
    <div class="lb-scrub-bar" id="lbScrubBar">
      <div class="lb-scrub-fill"></div>
      <div class="lb-scrub-thumb"></div>
      <div class="lb-scrub-hit"></div>
    </div>`);

  // Per-class strips + matching badges. Skip entirely for timelapse
  // (no tracking sidecar) and for motion clips that have no tracks
  // yet (the auto-reindex banner handles the "tracking wird
  // generiert…" state inside the video region).
  if (!isTimelapse && haveTracks && orderedLabels.length > 0){
    for (const lbl of orderedLabels){
      const c = colors[lbl] || colors.unknown;
      const labelText = OBJ_LABEL[lbl] || lbl;
      const rawSvg = OBJ_SVG[lbl] || OBJ_SVG.alarm || '';
      const avatarSvg = rawSvg.replace('width="16" height="16"', 'width="18" height="18"');
      const isOn = !hidden.has(lbl);
      const trs = byLabel.get(lbl) || [];
      const barsHtml = trs.map(tr => {
        const samples = tr.samples || [];
        if (!samples.length) return '';
        const t0 = samples[0].t;
        const t1 = samples[samples.length - 1].t;
        const left = Math.max(0, (t0 / duration) * 100);
        const width = Math.max(0.5, ((t1 - t0) / duration) * 100);
        const endedEarly = (duration - t1) > 0.4;
        const endRight = Math.max(0, ((duration - t1) / duration) * 100);
        const tt = `Track #${tr._num} · ${t0.toFixed(1)}s → ${t1.toFixed(1)}s`;
        const idx = tr._num - 1;
        return `<button type="button" class="lbtt-bar" data-seek="${t0.toFixed(3)}" title="${tt}" aria-label="${tt}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;background:${c}">
          <span class="lbtt-bar-num" style="color:${c}">#${tr._num}</span>
          ${endedEarly ? `<span class="lbtt-bar-end" data-track-idx="${idx}" data-track-num="${tr._num}" tabindex="0" role="button" aria-label="Track #${tr._num} verloren" style="right:-${endRight.toFixed(2)}%">×</span>` : ''}
        </button>`;
      }).join('');
      sidebarParts.push(`
        <button type="button" class="lbtt-badge" data-label="${lbl}" data-on="${isOn ? '1' : '0'}" aria-label="Klasse ein/aus" title="Klasse ein/aus">
          <span class="lbtt-avatar" style="--c:${c}">${avatarSvg}</span>
          <span class="lbtt-name">${labelText}</span>
        </button>`);
      timeColParts.push(`
        <div class="lbtt-strip" data-on="${isOn ? '1' : '0'}" data-label="${lbl}">${barsHtml}</div>`);
    }
  } else if (!isTimelapse && !haveTracks){
    // No-tracks state for motion events — keep the layout structure
    // so the cursor + scrubber still align, just show a one-liner.
    sidebarParts.push(`<div class="lbtt-empty-side"></div>`);
    timeColParts.push(`<div class="lbtt-empty">Keine Track-Daten — erscheinen sobald die Indexierung fertig ist.</div>`);
  }

  // Tick row — always present for motion clips (gives the user a 0
  // / 11 / 22 / 33 s scale). Timelapse skips it since it doesn't
  // carry detection time semantics.
  let ticksHtml = '';
  if (!isTimelapse){
    const N = 4;
    let parts = '';
    for (let i = 0; i < N; i++){
      const tSec = (duration * i) / (N - 1);
      const pct = (i / (N - 1)) * 100;
      const nudge = i === 0 ? 0 : i === N - 1 ? 24 : 12;
      parts += `<span class="lbtt-tick" style="left:calc(${pct.toFixed(2)}% - ${nudge}px)">${tSec.toFixed(0)}s</span>`;
    }
    ticksHtml = parts;
    sidebarParts.push(`<div class="lb-tick-spacer"></div>`);
    timeColParts.push(`<div class="lbtt-ticks">${ticksHtml}</div>`);
  }

  // Play cursor — always present in the time column. Its left is a
  // CSS calc against --play-pct so the position updates automatically
  // when the rAF loop writes the variable. The 16 px hit-area sibling
  // captures pointer events for drag-to-scrub.
  timeColParts.push(`
    <div class="lb-play-cursor" aria-hidden="true">
      <div class="lb-play-line"></div>
      <div class="lb-play-hit"></div>
    </div>`);

  host.innerHTML = `
    <div class="lb-time-stack" style="--play-pct:0">
      <div class="lb-sidebar">${sidebarParts.join('')}</div>
      <div class="lb-time-col">${timeColParts.join('')}</div>
    </div>`;

  // Wire badge / bar clicks + bar-end tooltip + scrubber + play btn
  // + cursor drag. Listeners bind to freshly-rendered elements so
  // we don't need an idempotency flag here — innerHTML replaced any
  // previous bindings.
  host.querySelectorAll('.lbtt-badge').forEach(btn => {
    btn.addEventListener('click', _onTimelineBadgeClick);
  });
  host.querySelectorAll('.lbtt-bar').forEach(btn => {
    btn.addEventListener('click', _onTimelineBarClick);
  });
  _wireBarEndTooltips(host);
  _wirePlayButton();
  _wireScrubBar();
  _wirePlayCursorDrag();
  // Snap the initial --play-pct from current videoEl state so the
  // first paint already has the cursor / scrubber in the right
  // place, even before the rAF loop kicks in.
  _updatePlayPct();
}

function _onTimelineBadgeClick(ev){
  ev.stopPropagation();
  const btn = ev.currentTarget;
  const lbl = btn.dataset.label;
  const camId = lbState.item?.camera_id;
  if (!lbl || !camId) return;
  const hidden = _getHiddenClassesForCam(camId);
  if (hidden.has(lbl)) hidden.delete(lbl);
  else hidden.add(lbl);
  _setHiddenClassesForCam(camId, hidden);
  // Update visual on the row + redraw canvas.
  const isOn = !hidden.has(lbl);
  btn.dataset.on = isOn ? '1' : '0';
  const row = btn.closest('.lbtt-row');
  if (row) row.dataset.on = isOn ? '1' : '0';
  _lbDrawDetections();
}

function _onTimelineBarClick(ev){
  ev.stopPropagation();
  const btn = ev.currentTarget;
  const t = parseFloat(btn.dataset.seek || '0');
  if (!Number.isFinite(t)) return;
  const v = byId('lightboxVideo');
  if (!v) return;
  const dur = Number.isFinite(v.duration) ? v.duration : 0;
  if (dur <= 0) return;
  v.currentTime = Math.min(dur, Math.max(0, t));
  if (v.paused) v.play().catch(() => {});
}
