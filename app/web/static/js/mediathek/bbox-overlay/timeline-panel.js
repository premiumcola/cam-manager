// ─── mediathek/bbox-overlay/timeline-panel.js ──────────────────────────────
// Bottom-of-lightbox component: one row per class with ≥1 track. Each
// row renders a class badge (toggle button) + a strip with per-track
// bars. Bars carry the track's per-clip number (#1, #2, …) and a red
// × marker when the track ended before video duration. Tap a bar to
// seek the video; tap the badge to hide that class's bboxes.
import { byId } from '../../core/dom.js';
import { colors, OBJ_LABEL, OBJ_SVG } from '../../core/icons.js';
import { apiPost } from '../../core/api.js';
import { trackColor } from '../../core/track-color.js';
import { lbState } from '../state.js';
import { _state } from './_state.js';
import { _getHiddenClassesForCam, _setHiddenClassesForCam } from './hidden-classes.js';
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

// ``host`` defaults to the legacy #lightboxBottomStack so every existing
// caller keeps working unchanged; the MediaView shell passes its own
// playbar slot so the same renderer can mount into the shared shell
// (D · migration enabler) without a fork.
export function lbClearTrackTimeline(host) {
  const el = host || byId('lightboxBottomStack');
  if (!el) return;
  el.innerHTML = '';
}

// Classify a single sample into one of four buckets matching the
// status visual language. Mirrors renderer._classifyTrackStatus but
// at sample granularity so per-segment textures can be emitted along
// a single bar.
//
//   confirmed — detect sample with score ≥ threshold, NOT masked.
//   weak      — detect sample with score < threshold, NOT masked.
//   predicted — non-detect sample (source = predicted), NOT masked.
//   masked    — subject ground point inside an exclusion mask
//               (overrides everything else — alerting filter wins).
function _classifySample(s, threshold, masks, natW, natH) {
  if (!s) return 'confirmed';
  const bb = s.bbox || {};
  const cx = (bb.x1 + bb.x2) / 2;
  const cy = bb.y2;
  if (masks && masks.length && _isPointInAnyMask(cx, cy, natW, natH, masks)) {
    return 'masked';
  }
  const src = s.source;
  const isDetect = src === undefined || src === null || src === 'detect' || src === 'track';
  if (!isDetect) return 'predicted';
  const sc = s.score;
  if (typeof sc === 'number' && sc < threshold) return 'weak';
  return 'confirmed';
}

// Collapse a per-sample classification into contiguous runs along
// the [t0, t1] timeline. Each run carries a `status` + its time
// boundaries so the bar template can paint one overlay per non-
// confirmed run.
function _segmentTrack(samples, threshold, masks, natW, natH) {
  if (!samples.length) return [];
  const out = [];
  let curStatus = _classifySample(samples[0], threshold, masks, natW, natH);
  let curStart = samples[0].t;
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    const status = _classifySample(s, threshold, masks, natW, natH);
    if (status !== curStatus) {
      out.push({ status: curStatus, t0: curStart, t1: s.t });
      curStatus = status;
      curStart = s.t;
    }
  }
  const last = samples[samples.length - 1].t;
  out.push({ status: curStatus, t0: curStart, t1: last });
  return out;
}

// H4 · tier classification — top vs bottom sub-band.
//   top    — best_score ≥ spawn-threshold AND not essentially all-
//            masked. Strong, alerting-eligible track. Painted as a
//            solid block in the track color.
//   bottom — ghost (never confirmed) OR almost-entirely masked.
//            Painted smaller + neutral gray in the de-emphasised
//            second band.
function _classifyTrackTier(tr, threshold, segments, t0, t1) {
  const bestScore = typeof tr.best_score === 'number' ? tr.best_score : 0;
  if (bestScore < threshold) return 'ghost';
  const span = Math.max(0.0001, t1 - t0);
  const maskedSpan = segments
    .filter((s) => s.status === 'masked')
    .reduce((a, s) => a + (s.t1 - s.t0), 0);
  if (maskedSpan >= 0.95 * span) return 'masked';
  return 'confirmed';
}

// H4 · greedy mini-row assignment for the top sub-band. Each
// confirmed track lands in the lowest mini-row index where no
// previously-placed track still occupies its time window. Result
// is one number per track + the total mini-row count so the
// strip can size its top band.
function _assignTopMiniRows(tracks) {
  const rows = [];
  const assignment = new Map();
  for (const tr of tracks) {
    const samples = tr.samples || [];
    if (!samples.length) continue;
    const start = samples[0].t;
    const end = samples[samples.length - 1].t;
    let placed = -1;
    for (let r = 0; r < rows.length; r++) {
      if (rows[r] <= start) {
        rows[r] = end;
        placed = r;
        break;
      }
    }
    if (placed < 0) {
      rows.push(end);
      placed = rows.length - 1;
    }
    assignment.set(tr, placed);
  }
  return { assignment, rowCount: rows.length || 1 };
}

function _renderTrackBar(tr, duration, fallbackC, threshold, natW, natH, masks, opts = {}) {
  const samples = tr.samples || [];
  if (!samples.length) return '';
  const t0 = Math.max(0, samples[0].t);
  const tLast = samples[samples.length - 1].t;
  const t1 = Math.min(duration, tLast);
  if (t1 - t0 < 0.05 && tLast > duration) return '';
  const left = Math.max(0, (t0 / duration) * 100);
  const width = Math.max(0.5, ((t1 - t0) / duration) * 100);
  const trackColor = tr.color || fallbackC;
  const segments = _segmentTrack(samples, threshold, masks, natW, natH);
  const tier = _classifyTrackTier(tr, threshold, segments, t0, t1);
  // × lost marker — keep the existing rules. end_reason === "timeout"
  // AND the bar still ends > 0.4 s before clip duration.
  const endReason = tr.end_reason;
  const endedEarlyGap = duration - t1 > 0.4;
  let showEndX;
  if (endReason === 'timeout') showEndX = endedEarlyGap;
  else if (endReason === undefined || endReason === null) showEndX = endedEarlyGap;
  else showEndX = false;
  const endRight = Math.max(0, ((duration - t1) / duration) * 100);
  const predictedSpan = segments
    .filter((s) => s.status === 'predicted')
    .reduce((acc, s) => acc + (s.t1 - s.t0), 0);
  let tt = `Track #${tr._num} · ${t0.toFixed(1)}s → ${t1.toFixed(1)}s`;
  if (predictedSpan > 0.05) tt += ` · ${predictedSpan.toFixed(1)} s prädiziert`;
  if (tier === 'ghost') tt += ' · Ghost (nie bestätigt)';
  else if (tier === 'masked') tt += ' · Maskiert';
  const idx = tr._num - 1;
  // BOTTOM sub-band — ghost (dotted outline gray) or masked (gray
  // solid fill). Smaller, de-emphasised. No per-segment overlays
  // here; the whole track is in the secondary tier.
  if (tier !== 'confirmed') {
    const barStyle = `left:${left.toFixed(2)}%;width:${width.toFixed(2)}%`;
    const maskedBadge =
      tier === 'masked'
        ? `<span class="lbtt-bar-masked" aria-label="Maskiert" title="Außerhalb Alarmierung">⊘</span>`
        : '';
    return `<button type="button" class="lbtt-bar lbtt-bar--lo" data-status="${tier}" data-seek="${t0.toFixed(3)}" title="${tt}" aria-label="${tt}" style="${barStyle}">
      <span class="lbtt-bar-num">#${tr._num}</span>
      ${maskedBadge}
      ${showEndX ? `<span class="lbtt-bar-end" data-track-idx="${idx}" data-track-num="${tr._num}" tabindex="0" role="button" aria-label="Track #${tr._num} verloren" style="right:-${endRight.toFixed(2)}%">×</span>` : ''}
    </button>`;
  }
  // TOP sub-band — confirmed track. Solid track-color block with
  // per-segment hatch overlays for any sub-spans that dipped below
  // confirmation (weak/predicted) or fell inside a mask. The
  // overlays paint in the SAME track color (the hatch is dark
  // stripes laid OVER the colored base — the base hue shows
  // through the gaps so identity stays readable).
  const totalSpan = Math.max(0.0001, t1 - t0);
  const overlayParts = [];
  for (const seg of segments) {
    if (seg.status === 'confirmed') continue;
    const segL = Math.max(0, ((seg.t0 - t0) / totalSpan) * 100);
    const segW = Math.max(0, ((Math.min(seg.t1, t1) - Math.max(seg.t0, t0)) / totalSpan) * 100);
    if (segW < 0.01) continue;
    const cls = seg.status === 'masked' ? 'lbtt-bar-maskspan' : 'lbtt-bar-predicted';
    overlayParts.push(
      `<span class="${cls}" style="left:${segL.toFixed(2)}%;width:${segW.toFixed(2)}%"></span>`,
    );
  }
  const miniRow = opts.miniRow != null ? opts.miniRow : 0;
  const barStyle = `left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;background:${trackColor};--track-color:${trackColor};--mini-row:${miniRow}`;
  return `<button type="button" class="lbtt-bar lbtt-bar--hi" data-status="confirmed" data-seek="${t0.toFixed(3)}" title="${tt}" aria-label="${tt}" style="${barStyle}">
    ${overlayParts.join('')}
    <span class="lbtt-bar-num">#${tr._num}</span>
    ${showEndX ? `<span class="lbtt-bar-end" data-track-idx="${idx}" data-track-num="${tr._num}" tabindex="0" role="button" aria-label="Track #${tr._num} verloren" style="right:-${endRight.toFixed(2)}%">×</span>` : ''}
  </button>`;
}

// C1 · Auto-populate the swimlane from the event's stored TRIGGER
// detections (item.detections — class + bbox + score, written by the
// recording pipeline) when no tracks.json sidecar exists yet. Builds a
// minimal tracks-shaped object — one single-sample track per detection,
// dropped at the pre-roll boundary (where the motion that started the
// clip occurred; ffmpeg clips have 0 pre-roll → the very start). The
// result feeds the SAME strip renderer as a real sidecar, so a freshly
// opened clip shows its class-coloured lanes with zero clicks. The
// manual "Neu indexieren" pill still REFINES this into full multi-frame
// tracks. Returns null when there are no usable detections (caller then
// falls back to the calm empty placeholder).
//
// NOTE: this stays local to the timeline panel — it is NOT written back
// to item._tracks, so the canvas bbox overlay (_lbDrawDetections) keeps
// its own conservative trigger-frame fallback unchanged.
function _synthTracksFromDetections(item) {
  const dets = (item.detections || []).filter((d) => d && d.bbox && typeof d.bbox.x1 === 'number');
  if (!dets.length) return null;
  const rs = item.recording_settings || {};
  const t0 = Math.max(0, Number(rs.pre_motion_seconds) || 0);
  const tracks = dets.map((d, i) => {
    const tr = {
      label: d.label || 'unknown',
      best_score: typeof d.score === 'number' ? d.score : 0,
      // end_reason set to a non-timeout sentinel so _renderTrackBar
      // never paints a misleading "× lost" marker on a synthetic
      // single-point trigger marker.
      end_reason: 'auto',
      samples: [{ t: t0, f: 0, bbox: d.bbox, score: d.score, source: 'detect' }],
      _auto: true,
    };
    tr._num = i + 1;
    tr.color = trackColor(tr);
    return tr;
  });
  const g = Number(rs.conf_thresh_general);
  const gates = Number.isFinite(g) && g > 0 ? { min_confidence: g } : undefined;
  return { tracks, gates, _auto: true };
}

// Master renderer for the entire bottom-stack chrome — sidebar (play
// button + class badges + tick spacer) and time column (scrubber bar
// + per-class strips + tick row + play cursor). One column owns the
// time-axis x-coordinates, so the scrubber thumb, every strip bar,
// every tick label, and the play cursor all share a single left
// origin. The shared --play-pct CSS variable on .lb-time-stack drives
// scrubber-fill width + scrubber-thumb left + play-line left in
// lockstep so a single rAF write paints all three.
export function lbRenderTrackTimeline(item, opts = {}) {
  // ``opts.host`` overrides the legacy #lightboxBottomStack so the
  // MediaView shell can mount the recorded scrubber + per-class swimlane
  // into its own playbar slot (D). All existing callers pass item only →
  // unchanged behaviour. The play/scrub WIRING (time-axis.js) still binds
  // to the global #lightboxVideo / .lb-time-stack; E wires the shell's
  // video element into that path.
  const host = opts.host || byId('lightboxBottomStack');
  if (!host) return;
  if (!item) {
    host.innerHTML = '';
    return;
  }

  const isTimelapse = item.type === 'timelapse';
  let tracks = item._tracks;
  let haveTracks = !!(tracks && Array.isArray(tracks.tracks) && tracks.tracks.length > 0);
  // C1 · no real sidecar tracks → fall back to the stored trigger
  // detections so the swimlane is populated on first open (zero
  // clicks). Timelapses carry no trigger detections, so they keep
  // their "Nach-Erkennung starten" empty state below.
  if (!haveTracks && !isTimelapse) {
    const synth = _synthTracksFromDetections(item);
    if (synth) {
      tracks = synth;
      haveTracks = true;
    }
  }
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
  const vidDur = Number.isFinite(videoEl?.duration) && videoEl.duration > 0 ? videoEl.duration : 0;
  let maxT = 0;
  if (haveTracks) {
    for (const tr of tracks.tracks) {
      for (const sm of tr.samples || []) {
        if (sm.t > maxT) maxT = sm.t;
      }
    }
  }
  const duration = vidDur || maxT || 1;
  _state.timelineDuration = duration;

  // Per-clip stable index map for the × tooltip handler.
  _state.timelineTrackIndex = haveTracks ? tracks.tracks : [];

  // Group tracks → per-class buckets, ordered by OBJ_LABEL so the
  // strip stack stays stable across re-opens. `_num` was stamped at
  // fetch time (fetcher.js) so this loop only needs to bucket.
  const byLabel = new Map();
  if (haveTracks) {
    for (const tr of tracks.tracks) {
      const lbl = tr.label || 'unknown';
      if (allowed !== null && !allowed.has(lbl)) continue;
      if (!byLabel.has(lbl)) byLabel.set(lbl, []);
      byLabel.get(lbl).push(tr);
    }
  }
  const orderedLabels = Object.keys(OBJ_LABEL).filter((l) => byLabel.has(l));
  for (const l of byLabel.keys()) {
    if (!orderedLabels.includes(l)) orderedLabels.push(l);
  }

  // Build sidebar + time-col items as parallel arrays so vertical
  // alignment between badge[i] and strip[i] is preserved by the flex
  // column natural order.
  const sidebarParts = [];
  const timeColParts = [];

  // Pre-roll / post-roll context spans for the scrubber. The event
  // JSON's recording_settings carries the seconds; we paint two
  // subtle gray bands on the scrub bar so the user can tell at a
  // glance "before this tick is leading buffer, after that tick is
  // trailing tail". For ffmpeg-recorded clips the pre-roll is 0
  // and the leading band collapses to zero width — invisible by
  // design.
  const rs = item.recording_settings || {};
  const preS = Math.max(0, Number(rs.pre_motion_seconds) || 0);
  const postS = Math.max(0, Number(rs.post_motion_seconds) || 0);
  const prePct = duration > 0 ? Math.min(100, (preS / duration) * 100) : 0;
  const postPct = duration > 0 ? Math.min(100, (postS / duration) * 100) : 0;
  const rollHtml =
    prePct > 0 || postPct > 0
      ? `
    ${prePct > 0 ? `<span class="lb-scrub-roll lb-scrub-roll--pre" style="width:${prePct.toFixed(2)}%" title="Vorlauf · ${preS}s"></span>` : ''}
    ${postPct > 0 ? `<span class="lb-scrub-roll lb-scrub-roll--post" style="width:${postPct.toFixed(2)}%" title="Nachlauf · ${postS}s"></span>` : ''}
  `
      : '';

  // Scrubber row — always present. Play button lives in the sidebar
  // (NOT inside the scrubber bar). Scrubber bar is full-width in the
  // time column so its leading 0 % aligns with every strip's 0 %.
  sidebarParts.push(`
    <button type="button" id="lbScrubPlay" class="lb-play-btn" aria-label="Play / Pause">
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5l13 7-13 7z"/></svg>
    </button>`);
  timeColParts.push(`
    <div class="lb-scrub-bar" id="lbScrubBar">
      ${rollHtml}
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

  // Per-clip spawn threshold (gates.min_confidence) drives the
  // status classifier — same value the bbox renderer reads, so the
  // bar texture agrees with the video bbox style for every sample.
  const spawnThreshold =
    tracks && tracks.gates && typeof tracks.gates.min_confidence === 'number'
      ? tracks.gates.min_confidence
      : 0.5;

  // Per-class strips + matching badges. Skip when there are no
  // tracks (motion clips trigger the auto-reindex banner in that
  // case; timelapses fall through to the "Nach-Erkennung starten"
  // placeholder one branch below). Timelapses CAN carry tracks
  // once the user kicks the worker on a timelapse MP4 — the
  // tracks.json sidecar lands alongside the clip exactly like for
  // motion events.
  // I4 · the class-icon trigger marker at t=pre-roll-end was
  // dropped — it duplicated information already obvious from the
  // first confirmed track in each lane and added visual noise
  // above the timeline.
  if (haveTracks && orderedLabels.length > 0) {
    for (const lbl of orderedLabels) {
      const labelText = OBJ_LABEL[lbl] || lbl;
      const rawSvg = OBJ_SVG[lbl] || OBJ_SVG.alarm || '';
      const avatarSvg = rawSvg.replace('width="16" height="16"', 'width="18" height="18"');
      const isOn = !hidden.has(lbl);
      const trs = byLabel.get(lbl) || [];
      // Per-class fallback color from the icons palette — only used
      // when a track lacks its own tracks.json color (legacy
      // sidecars). Modern sidecars always carry tr.color.
      const fallbackC = colors[lbl] || colors.unknown;
      const c = fallbackC;
      // H4 · split this class's tracks into the TOP (confirmed,
      // strong) and BOTTOM (ghost + masked, secondary) sub-bands.
      // We classify here at the strip level — _renderTrackBar
      // re-classifies internally for tooltip/text purposes, but
      // the SPLIT into two flex children happens once per class.
      const topTracks = [];
      const botTracks = [];
      for (const tr of trs) {
        const samples = tr.samples || [];
        if (!samples.length) {
          botTracks.push(tr);
          continue;
        }
        const t0 = Math.max(0, samples[0].t);
        const t1 = Math.min(duration, samples[samples.length - 1].t);
        const segs = _segmentTrack(samples, spawnThreshold, camMasks, _natW, _natH);
        const tier = _classifyTrackTier(tr, spawnThreshold, segs, t0, t1);
        (tier === 'confirmed' ? topTracks : botTracks).push(tr);
      }
      const { assignment: topRows, rowCount: topRowCount } = _assignTopMiniRows(topTracks);
      const topBarsHtml = topTracks
        .map((tr) =>
          _renderTrackBar(tr, duration, fallbackC, spawnThreshold, _natW, _natH, camMasks, {
            miniRow: topRows.get(tr) || 0,
          }),
        )
        .join('');
      const botBarsHtml = botTracks
        .map((tr) =>
          _renderTrackBar(tr, duration, fallbackC, spawnThreshold, _natW, _natH, camMasks),
        )
        .join('');
      const barsHtml = `
        <div class="lbtt-strip-top" data-rows="${topRowCount}">${topBarsHtml}</div>
        ${botTracks.length ? `<div class="lbtt-strip-bot">${botBarsHtml}</div>` : ''}`;
      sidebarParts.push(`
        <button type="button" class="lbtt-badge" data-label="${lbl}" data-on="${isOn ? '1' : '0'}" aria-label="Klasse ein/aus" title="Klasse ein/aus">
          <span class="lbtt-avatar" style="--c:${c}">${avatarSvg}</span>
          <span class="lbtt-name">${labelText}</span>
        </button>`);
      timeColParts.push(`
        <div class="lbtt-strip" data-on="${isOn ? '1' : '0'}" data-label="${lbl}">${barsHtml}</div>`);
    }
  } else if (!haveTracks) {
    // No-tracks placeholder — keep the layout structure so the
    // cursor + scrubber still align with the strips below. For
    // timelapses we add an inline "Nach-Erkennung starten" button
    // that kicks the existing tracking worker against the
    // timelapse MP4. For motion clips the auto-reindex banner
    // inside the video region surfaces the same affordance, so
    // here a plain text line is enough.
    sidebarParts.push(`<div class="lbtt-empty-side"></div>`);
    if (isTimelapse) {
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
      if (indexerRan) {
        const gates = (tracks && tracks.gates) || null;
        const minPct =
          gates && typeof gates.min_confidence === 'number'
            ? Math.round(gates.min_confidence * 100)
            : null;
        const tail =
          minPct != null
            ? `<span class="lbtt-empty-sub">kurze Sichtungen unter ${minPct} % werden gefiltert</span>`
            : '';
        timeColParts.push(
          `<div class="lbtt-empty lbtt-empty-done">` +
            `<span class="lbtt-empty-text">Indexierung fertig · keine Spuren bestätigt</span>` +
            tail +
            `</div>`,
        );
      } else {
        // I1 · clip has no sidecar at all (recorded before the
        // finalize-time enqueue existed, or its sidecar was deleted).
        // Calm, action-oriented copy — the operator can hit the
        // "Neu indexieren" pill in the overlay-toggles row to
        // produce one. No automatic kick.
        timeColParts.push(
          `<div class="lbtt-empty lbtt-empty-unindexed">` +
            `<span class="lbtt-empty-text">Noch nicht indexiert</span>` +
            `<span class="lbtt-empty-sub">über »Neu indexieren« erzeugen</span>` +
            `</div>`,
        );
      }
    }
  }

  // Tick row — gives the user a 0/¼/½/¾/full scale. Now rendered
  // for timelapses too so the scrubber bar has a readable axis
  // (a 6-hour day-timelapse plays in ~20 s; without ticks the
  // operator has no idea where in the day they're scrubbing).
  const N = 4;
  let parts = '';
  for (let i = 0; i < N; i++) {
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
  host.querySelectorAll('.lbtt-badge').forEach((btn) => {
    btn.addEventListener('click', _onTimelineBadgeClick);
  });
  host.querySelectorAll('.lbtt-bar').forEach((btn) => {
    btn.addEventListener('click', _onTimelineBarClick);
  });
  host.querySelectorAll('.lbtt-empty-rescan').forEach((btn) => {
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

function _onTimelineBadgeClick(ev) {
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

function _onTimelineBarClick(ev) {
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
async function _onTimelineRescanClick(ev) {
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
    let d;
    try {
      d = await apiPost(
        `/api/events/${encodeURIComponent(eid)}/rescan?camera_id=${encodeURIComponent(cid)}`,
      );
    } catch (e) {
      if (label) label.textContent = `Fehler: ${e?.message || e}`;
      throw e;
    }
    if (!d?.ok) {
      if (label) label.textContent = `Fehler: ${d?.error || 'Fehler'}`;
      host.dataset.state = 'err';
      btn.disabled = false;
      return;
    }
  } catch (err) {
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
    if (lbState.item?.event_id !== eid) return; // user navigated away
    try {
      lbInvalidateTracks(eid);
      if (lbState.item) delete lbState.item._tracks;
      await lbLoadTracksForItem(lbState.item);
      const fresh = lbState.item?._tracks;
      const ready = !!(fresh && Array.isArray(fresh.tracks) && fresh.tracks.length > 0);
      if (ready) {
        lbRenderTrackTimeline(lbState.item);
        return;
      }
    } catch {
      /* swallow — keep polling */
    }
    if (attempts < maxAttempts) {
      setTimeout(tick, pollInterval);
      return;
    }
    if (label) label.textContent = 'Keine Objekte erkannt';
    host.dataset.state = 'empty';
  };
  setTimeout(tick, pollInterval);
}
