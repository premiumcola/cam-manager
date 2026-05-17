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
import {
  _isPointInAnyMask,
  _lbDrawDetections,
  _resolveAllowedLabels,
  _resolveMaskPolygonsForCam,
} from './renderer.js';
import { lbInvalidateTracks, lbLoadTracksForItem } from './fetcher.js';
import {
  _updatePlayPct,
  _wirePlayButton,
  _wirePlayCursorDrag,
  _wireScrubBar,
} from './time-axis.js';
import { _wireBarEndTooltips } from './track-loss-tooltip.js';

// Per-track masked classification. Walks each sample's ground point
// (bottom-center of bbox) and counts how many fall inside an exclusion
// mask. A track whose majority of samples sit inside a mask is
// rendered gray on the timeline + carries the ⊘ corner badge in the
// row's bar so the operator sees the same alert-filtered indication
// they see on the video bbox. C7 will refine this to per-segment.
function _maskedRatioForTrack(track, srcW, srcH, masks){
  if (!masks || !masks.length) return 0;
  const samples = track?.samples || [];
  if (!samples.length) return 0;
  let masked = 0;
  for (const s of samples){
    const bb = s.bbox || {};
    const cx = (bb.x1 + bb.x2) / 2;
    const cy = bb.y2;
    if (_isPointInAnyMask(cx, cy, srcW, srcH, masks)) masked++;
  }
  return masked / samples.length;
}

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

  // Mask resolution + source dims for the per-track masked test. Read
  // once per render so the inner loop doesn't re-resolve the camera /
  // re-parse preview_resolution per track.
  const camMasks = _resolveMaskPolygonsForCam(camId);
  const _natW = videoEl?.videoWidth || 0;
  const _natH = videoEl?.videoHeight || 0;

  // Per-class strips + matching badges. Skip when there are no
  // tracks (motion clips trigger the auto-reindex banner in that
  // case; timelapses fall through to the "Nach-Erkennung starten"
  // placeholder one branch below). Timelapses CAN carry tracks
  // once the user kicks the worker on a timelapse MP4 — the
  // tracks.json sidecar lands alongside the clip exactly like for
  // motion events.
  if (haveTracks && orderedLabels.length > 0){
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
        // Find the last DETECT sample — anything after it forms the
        // predicted tail. Tolerant to old tracks.json without a
        // `source` field: missing/undefined is treated as detect so
        // pre-2026-05 clips keep rendering as solid bars.
        let lastDetectIdx = -1;
        for (let i = samples.length - 1; i >= 0; i--){
          const src = samples[i].source;
          if (src === undefined || src === null || src === 'detect' || src === 'track'){
            lastDetectIdx = i;
            break;
          }
        }
        const hasPredictedTail = lastDetectIdx >= 0 && lastDetectIdx < samples.length - 1;
        const tDetectEnd = hasPredictedTail ? samples[lastDetectIdx].t : t1;
        const predictedSpan = hasPredictedTail ? Math.max(0, t1 - tDetectEnd) : 0;
        // Two segments (when there's a predicted tail) share the
        // bar's solid colour as the base, with a striped overlay
        // covering only the predicted region. The percentages are
        // relative to the bar itself, not the strip, so width:100%
        // on the bar maps to the full track span [t0, t1].
        const totalSpan = Math.max(0.0001, t1 - t0);
        const detectFrac = hasPredictedTail
          ? Math.max(0, Math.min(1, (tDetectEnd - t0) / totalSpan))
          : 1;
        const predLeftPct = (detectFrac * 100).toFixed(2);
        const predWidthPct = ((1 - detectFrac) * 100).toFixed(2);
        // × marker only when end_reason === "timeout" AND the bar
        // (predicted tail included) still ends >0.4 s before the
        // clip's end. Tracks that re-acquired (last sample is
        // detect) or that closed because the clip simply ended
        // (end_reason === "ended_at_clip") get no marker. Older
        // tracks.json without end_reason fall back to the legacy
        // duration-gap rule so those clips don't lose the cue.
        const endReason = tr.end_reason;
        const endedEarlyGap = (duration - t1) > 0.4;
        let showEndX;
        if (endReason === 'timeout') showEndX = endedEarlyGap;
        else if (endReason === undefined || endReason === null) showEndX = endedEarlyGap;
        else showEndX = false;
        const endRight = Math.max(0, ((duration - t1) / duration) * 100);
        let tt = `Track #${tr._num} · ${t0.toFixed(1)}s → ${t1.toFixed(1)}s`;
        if (predictedSpan > 0.05) tt += ` · ${predictedSpan.toFixed(1)} s prädiziert`;
        const idx = tr._num - 1;
        const predictedOverlay = hasPredictedTail
          ? `<span class="lbtt-bar-predicted" style="left:${predLeftPct}%;width:${predWidthPct}%"></span>`
          : '';
        // ⊘ Maskiert — track whose subject sits inside an exclusion
        // mask the majority of the time. Bar background overrides
        // the track color to neutral gray and shows the ⊘ corner
        // glyph so the row visually matches the bbox's masked
        // modifier on the video.
        const maskedRatio = _maskedRatioForTrack(tr, _natW, _natH, camMasks);
        const isMasked = maskedRatio >= 0.5;
        const barBg = isMasked ? '#94a3b8' : c;
        const maskedAttrs = isMasked ? ' data-masked="1"' : '';
        const maskedBadge = isMasked
          ? `<span class="lbtt-bar-masked" aria-label="Maskiert" title="Außerhalb Alarmierung (Maskiert)">⊘</span>`
          : '';
        return `<button type="button" class="lbtt-bar${hasPredictedTail ? ' lbtt-bar-has-pred' : ''}"${maskedAttrs} data-seek="${t0.toFixed(3)}" title="${tt}" aria-label="${tt}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;background:${barBg}">
          ${predictedOverlay}
          <span class="lbtt-bar-num" style="color:${barBg}">#${tr._num}</span>
          ${maskedBadge}
          ${showEndX ? `<span class="lbtt-bar-end" data-track-idx="${idx}" data-track-num="${tr._num}" tabindex="0" role="button" aria-label="Track #${tr._num} verloren" style="right:-${endRight.toFixed(2)}%">×</span>` : ''}
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
  } else if (!haveTracks){
    // No-tracks placeholder — keep the layout structure so the
    // cursor + scrubber still align with the strips below. For
    // timelapses we add an inline "Nach-Erkennung starten" button
    // that kicks the existing tracking worker against the
    // timelapse MP4. For motion clips the auto-reindex banner
    // inside the video region surfaces the same affordance, so
    // here a plain text line is enough.
    sidebarParts.push(`<div class="lbtt-empty-side"></div>`);
    if (isTimelapse){
      const eid = item.event_id || '';
      const cid = item.camera_id || '';
      timeColParts.push(`
        <div class="lbtt-empty lbtt-empty-tl" data-event-id="${eid}" data-camera-id="${cid}">
          <span class="lbtt-empty-text">Noch keine Track-Daten</span>
          <button type="button" class="lbtt-empty-rescan">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8A5.5 5.5 0 0 1 13 5M13.5 8A5.5 5.5 0 0 1 3 11"/><polyline points="12,2 12,5.5 8.5,5.5"/><polyline points="4,14 4,10.5 7.5,10.5"/></svg>
            <span>Nach-Erkennung starten</span>
          </button>
        </div>`);
    } else {
      // K3 · split the no-tracks branch on whether the indexer has
      // FINISHED for this clip. A sidecar that exists but has an
      // empty tracks array (carries built_at OR schema>=3) tells us
      // the worker ran but found nothing trackable — different
      // message than "the indexer hasn't started yet". The gates
      // block (schema 4+) lets us surface the spawn-confidence floor
      // inline so the user knows WHY a short low-confidence sighting
      // didn't survive (e.g. "kurze Sichtungen unter 50 % werden
      // gefiltert"). Legacy clips without the gates field gracefully
      // fall back to a shorter message.
      const indexerRan = !!(tracks && (tracks.built_at || tracks.schema));
      if (indexerRan){
        const gates = (tracks && tracks.gates) || null;
        const minPct = gates && typeof gates.min_confidence === 'number'
          ? Math.round(gates.min_confidence * 100)
          : null;
        const tail = minPct != null
          ? `<span class="lbtt-empty-sub">kurze Sichtungen unter ${minPct} % werden gefiltert</span>`
          : '';
        timeColParts.push(
          `<div class="lbtt-empty lbtt-empty-done">`
          + `<span class="lbtt-empty-text">Indexierung fertig · keine Spuren bestätigt</span>`
          + tail
          + `</div>`,
        );
      } else {
        timeColParts.push(`<div class="lbtt-empty">Keine Track-Daten — erscheinen sobald die Indexierung fertig ist.</div>`);
      }
    }
  }

  // Tick row — gives the user a 0/¼/½/¾/full scale. Now rendered
  // for timelapses too so the scrubber bar has a readable axis
  // (a 6-hour day-timelapse plays in ~20 s; without ticks the
  // operator has no idea where in the day they're scrubbing).
  const N = 4;
  let parts = '';
  for (let i = 0; i < N; i++){
    const tSec = (duration * i) / (N - 1);
    const pct = (i / (N - 1)) * 100;
    const nudge = i === 0 ? 0 : i === N - 1 ? 24 : 12;
    parts += `<span class="lbtt-tick" style="left:calc(${pct.toFixed(2)}% - ${nudge}px)">${tSec.toFixed(0)}s</span>`;
  }
  const ticksHtml = parts;
  sidebarParts.push(`<div class="lb-tick-spacer"></div>`);
  timeColParts.push(`<div class="lbtt-ticks">${ticksHtml}</div>`);

  // Play cursor — promoted to a STACK-level sibling (was: inside the
  // time column) so its 2 px line visually cuts through every row at
  // the same x — sidebar badges AND time-col strips. The CSS picks
  // up the same --play-pct variable on the stack so a single rAF
  // write still paints scrubber-fill width + scrubber-thumb left +
  // playhead-cursor left in lockstep. The 16 px hit-area sibling
  // still captures pointer events for drag-to-scrub; its mapping
  // through .lb-time-col's bounding rect (in time-axis.js) is
  // unchanged.
  //
  // Suppressed entirely when the swimlane has no tracks — without it
  // the cursor would draw straight through the centred "Nach-
  // Erkennung starten" empty-state button (timelapse) or the
  // "Keine Track-Daten" placeholder text (motion). There's no
  // playback to anchor anyway when nothing has been indexed yet;
  // the next render (after rescan completes) brings the cursor back.
  const playCursor = haveTracks
    ? `<div class="lb-play-cursor" aria-hidden="true">
         <div class="lb-play-line"></div>
         <div class="lb-play-hit"></div>
       </div>`
    : '';

  host.innerHTML = `
    <div class="lb-time-stack" style="--play-pct:0">
      <div class="lb-sidebar">${sidebarParts.join('')}</div>
      <div class="lb-time-col">${timeColParts.join('')}</div>
      ${playCursor}
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
  host.querySelectorAll('.lbtt-empty-rescan').forEach(btn => {
    btn.addEventListener('click', _onTimelineRescanClick);
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

// "Nach-Erkennung starten" inline button — fires the existing rescan
// endpoint (/api/events/<id>/rescan) which enqueues a TrackingJob
// against the timelapse MP4. Idempotent on the backend; here we
// just need to keep the user informed while the worker runs and
// poll for tracks.json once. When the sidecar lands the swimlane
// re-renders via the existing fetcher path. If the worker never
// produces tracks (no detectable motion at all), surface a final
// "Keine Objekte erkannt" state rather than spinning forever.
async function _onTimelineRescanClick(ev){
  ev.preventDefault();
  ev.stopPropagation();
  const btn = ev.currentTarget;
  const host = btn.closest('.lbtt-empty');
  if (!host) return;
  const eid = host.dataset.eventId;
  const cid = host.dataset.cameraId || '';
  if (!eid) return;
  const label = host.querySelector('.lbtt-empty-text');
  btn.disabled = true;
  if (label) label.textContent = 'Erkennung läuft …';
  host.dataset.state = 'running';
  try {
    const r = await fetch(
      `/api/events/${encodeURIComponent(eid)}/rescan?camera_id=${encodeURIComponent(cid)}`,
      { method: 'POST' },
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok){
      if (label) label.textContent = `Fehler: ${d.error || r.statusText}`;
      host.dataset.state = 'err';
      btn.disabled = false;
      return;
    }
  } catch (err){
    if (label) label.textContent = `Fehler: ${err?.message || err}`;
    host.dataset.state = 'err';
    btn.disabled = false;
    return;
  }
  // Poll the tracks.json sidecar — the worker writes it atomically
  // when the job finishes. Six attempts at 4 s = 24 s; long enough
  // for a typical garden timelapse to be indexed. Each poll bypasses
  // the cache so the new file replaces the cached null entry.
  let attempts = 0;
  const maxAttempts = 6;
  const pollInterval = 4000;
  const tick = async () => {
    attempts += 1;
    if (lbState.item?.event_id !== eid) return;   // user navigated away
    try {
      lbInvalidateTracks(eid);
      if (lbState.item) delete lbState.item._tracks;
      await lbLoadTracksForItem(lbState.item);
      const fresh = lbState.item?._tracks;
      const ready = !!(fresh
        && Array.isArray(fresh.tracks) && fresh.tracks.length > 0);
      if (ready){
        lbRenderTrackTimeline(lbState.item);
        return;
      }
    } catch { /* swallow — keep polling */ }
    if (attempts < maxAttempts){
      setTimeout(tick, pollInterval);
      return;
    }
    if (label) label.textContent = 'Keine Objekte erkannt';
    host.dataset.state = 'empty';
  };
  setTimeout(tick, pollInterval);
}
