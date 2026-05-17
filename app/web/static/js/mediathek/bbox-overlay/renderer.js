// ─── mediathek/bbox-overlay/renderer.js ────────────────────────────────────
// Canvas-overlay renderer + per-track interpolation helpers. The MP4 is
// NEVER modified; this paints a separate canvas on top of the media
// element. Track colours come from the deterministic tracks.json
// palette so multiple subjects in one clip get distinguishable strokes.
import { byId } from '../../core/dom.js';
import { state } from '../../core/state.js';
import { colors, OBJ_LABEL } from '../../core/icons.js';
import { _lbClearDetections } from '../../lightbox.js';
import { lbState } from '../state.js';
import { _TRACK_SPAWN_SCORE } from './_state.js';
import { _isReindexBannerActive } from './reindex.js';
import { _getHiddenClassesForCam } from './hidden-classes.js';
import { renderTrailLayer } from '../../mediaview/canvas/trail-layer.js';

// Bbox + trail visibility — flipped by the overlay-toggles pill bar
// (bboxes/trails). Module-scoped so the RAF redraw loop and the
// toggle handler share state without round-tripping through DOM
// attributes. Defaults mirror overlay-toggles.js (both on by default).
const _overlayVisibility = { showBboxes: true, showTrails: true };

export function setBboxOverlayVisibility({ showBboxes, showTrails }){
  if (typeof showBboxes === 'boolean') _overlayVisibility.showBboxes = showBboxes;
  if (typeof showTrails === 'boolean') _overlayVisibility.showTrails = showTrails;
  _lbDrawDetections();
}

export function _interpolateTrackAt(track, t){
  const samples = track.samples || [];
  if (!samples.length) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (t < first.t - 0.05) return null;
  if (t > last.t + 0.05) return null;
  let prev = first, next = last;
  for (let i = 0; i < samples.length; i++){
    if (samples[i].t <= t) prev = samples[i];
    if (samples[i].t >= t){ next = samples[i]; break; }
  }
  if (prev === next || next.t === prev.t){
    return { bbox: prev.bbox, score: prev.score, label: track.label };
  }
  const a = (t - prev.t) / (next.t - prev.t);
  const lerp = (k) => prev.bbox[k] + (next.bbox[k] - prev.bbox[k]) * a;
  return {
    bbox: { x1: lerp('x1'), y1: lerp('y1'), x2: lerp('x2'), y2: lerp('y2') },
    score: (prev.source === 'detect' ? prev.score
           : next.source === 'detect' ? next.score
           : track.best_score) ?? 0,
    label: track.label,
  };
}

function _firstSampleOfTrack(track){
  const s = (track.samples || [])[0];
  if (!s) return null;
  return {
    bbox: s.bbox,
    score: s.source === 'detect' ? s.score : (track.best_score ?? 0),
    label: track.label,
  };
}

// Resolve the camera-config object_filter set, or null when unfiltered.
// tracks.json schema≥2 stores filter_applied at write time so this
// matches what the worker actually used; older sidecars + the legacy
// path fall back to the camera's live config.
export function _resolveAllowedLabels(){
  const tracks = lbState.item?._tracks;
  if (tracks && Array.isArray(tracks.filter_applied)){
    return new Set(tracks.filter_applied);
  }
  const camId = lbState.item?.camera_id;
  if (camId){
    const cam = (state.cameras || []).find(c => (c.id || '') === camId);
    const of = cam?.object_filter;
    if (Array.isArray(of) && of.length > 0){
      return new Set(of);
    }
  }
  return null;
}

// Combined visibility check — closure read once per render, called
// per track / per detection.
function _makeLabelVisibleFn(){
  const allowed = _resolveAllowedLabels();
  const camId = lbState.item?.camera_id;
  const hidden = _getHiddenClassesForCam(camId);
  return (label) => {
    if (hidden.has(label)) return false;
    return allowed === null || allowed.has(label);
  };
}

export function _lbDrawDetections(){
  const cv = byId('lightboxDetections');
  if (!cv || !lbState.item) return;
  const ctx = cv.getContext('2d');
  const videoEl = byId('lightboxVideo');
  const imgEl = byId('lightboxImg');
  const usingVideo = videoEl && videoEl.style.display !== 'none' && videoEl.videoWidth > 0;
  const usingImage = imgEl && imgEl.style.display !== 'none' && imgEl.naturalWidth > 0;
  const media = usingVideo ? videoEl : (usingImage ? imgEl : null);
  if (!media){ _lbClearDetections(); return; }
  const natW = usingVideo ? videoEl.videoWidth : imgEl.naturalWidth;
  const natH = usingVideo ? videoEl.videoHeight : imgEl.naturalHeight;
  const wrap = byId('lightboxMediaWrap');
  if (!wrap) return;
  const wrapRect = wrap.getBoundingClientRect();
  const mediaRect = media.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  cv.style.width = wrapRect.width + 'px';
  cv.style.height = wrapRect.height + 'px';
  cv.width  = Math.round(wrapRect.width * dpr);
  cv.height = Math.round(wrapRect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, wrapRect.width, wrapRect.height);

  const scale = Math.min(mediaRect.width / natW, mediaRect.height / natH);
  const renderedW = natW * scale, renderedH = natH * scale;
  const offX = (mediaRect.width - renderedW) / 2 + (mediaRect.left - wrapRect.left);
  const offY = (mediaRect.height - renderedH) / 2 + (mediaRect.top - wrapRect.top);

  const tracks = lbState.item._tracks;
  const haveTracks = tracks && Array.isArray(tracks.tracks) && tracks.tracks.length > 0;
  const sidecarFetched = tracks !== undefined;
  const sidecarEmpty = !!(tracks
    && Array.isArray(tracks.tracks) && tracks.tracks.length === 0);
  // Per-clip spawn threshold (gates.min_confidence) wins over the
  // module constant so the dashed/solid styling reflects what the
  // worker's classifier actually used. Falls back to the constant
  // for older sidecars without the gates block.
  const spawnThreshold = (tracks && tracks.gates
                          && typeof tracks.gates.min_confidence === 'number')
    ? tracks.gates.min_confidence
    : _TRACK_SPAWN_SCORE;
  const isVisible = _makeLabelVisibleFn();

  ctx.font = '600 12px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
  ctx.textBaseline = 'top';

  if (haveTracks){
    // Interpolate every track's bbox to the current playback time.
    // The RAF loop calls us every frame during play so the box
    // moves smoothly; the seeked/pause/ended listeners call us on
    // every scrub tick so the box snaps to the new position on
    // pause + drag. _interpolateTrackAt returns null outside the
    // track's [first.t, last.t] window — the track simply doesn't
    // paint until its first sample is reached, which keeps the
    // overlay honest about the subject's actual appearance time.
    const t = usingVideo ? (videoEl.currentTime || 0) : null;

    // Trails first so the bbox stroke sits on top — visually anchors
    // the leading dot to the box. Skipped when the trails pill is
    // off OR we're rendering a still photo (no time axis = no trail).
    if (_overlayVisibility.showTrails && t != null){
      for (const tr of tracks.tracks){
        if (!isVisible(tr.label)) continue;
        renderTrailLayer(ctx, tr, t, tr.color, offX, offY, scale);
      }
    }

    if (_overlayVisibility.showBboxes){
      for (const tr of tracks.tracks){
        if (!isVisible(tr.label)) continue;
        const sample = (t == null)
          ? _firstSampleOfTrack(tr)
          : _interpolateTrackAt(tr, t);
        if (!sample) continue;
        const status = _classifyTrackStatus(tr, sample, spawnThreshold);
        _drawTrackBox(ctx, sample, tr.color, offX, offY, scale, status);
      }
    }
    return;
  }

  // Indexer ran and produced an empty sidecar → keep the canvas
  // clean. Showing the trigger-frame detection here would be a
  // stationary, mis-positioned box that pops in only on scrub, with
  // no relationship to where the subject actually was during the
  // recorded clip. The timeline panel surfaces the WHY (gate values
  // + filter) so the operator understands the empty state without
  // a misleading box.
  if (sidecarFetched && sidecarEmpty) return;

  // Legacy single-bbox fallback for clips with no sidecar yet (404 /
  // pending fetch). Suppressed entirely while the reindex banner is
  // active (avoids staring at the same trigger-frame box for ~17 s)
  // and during active playback (the trigger bbox is one moment in
  // time; painting it during motion would lie about subject
  // location). Pause / ended / still-image branches paint the box
  // back at the trigger position so the user has SOMETHING to see
  // before the indexer finishes.
  if (_isReindexBannerActive()) return;

  const isPlaying = usingVideo && !videoEl.paused && !videoEl.ended
                    && (videoEl.currentTime || 0) > 0.05;
  if (isPlaying) return;
  if (!_overlayVisibility.showBboxes) return;

  const dets = (lbState.item.detections || [])
    .filter(d => d && d.bbox && typeof d.bbox.x1 === 'number')
    .filter(d => isVisible(d.label));
  if (!dets.length) return;
  for (const d of dets){
    const c = colors[d.label] || colors.unknown;
    const sample = { bbox: d.bbox, score: d.score, label: d.label };
    const status = _classifyTrackStatus(null, sample, spawnThreshold);
    _drawTrackBox(ctx, sample, c, offX, offY, scale, status);
  }
}

/**
 * Classify a track-or-detection sample against the spawn threshold.
 *
 *   confirmed — the SAMPLE's score is ≥ threshold right now.
 *   weak      — the track's best_score reached threshold at some
 *               point, but the CURRENT sample is below it.
 *   ghost     — best_score NEVER reached threshold (the track was
 *               kept alive entirely on tentative continuation).
 *
 * Legacy fallback path (single detection, no track): treat as
 * confirmed/weak based purely on score vs threshold — there's no
 * track history to derive a "best ever" from.
 */
export function _classifyTrackStatus(track, sample, threshold){
  const t = (typeof threshold === 'number') ? threshold : _TRACK_SPAWN_SCORE;
  const cur = (sample && sample.score != null) ? sample.score : null;
  const best = (track && track.best_score != null) ? track.best_score : null;
  // Track history available — three-tier classification.
  if (best != null){
    if (best < t) return 'ghost';
    if (cur != null && cur < t) return 'weak';
    return 'confirmed';
  }
  // No track context — collapse to the two-tier legacy view.
  if (cur != null && cur < t) return 'weak';
  return 'confirmed';
}

// Style table for the three tracking-status categories. The bbox
// renderer AND the legend component read these (the legend swatch is
// just a 24×16 stroke painted with the same lineDash + alpha), so
// changing a number here propagates to every status surface.
export const _STATUS_STYLE = {
  confirmed: { dash: [],     alpha: 1.00, marker: ''   },
  weak:      { dash: [6, 4], alpha: 1.00, marker: '↓ ' },
  ghost:     { dash: [2, 4], alpha: 0.55, marker: '≈ ' },
};

function _drawTrackBox(ctx, sample, color, offX, offY, scale, status){
  const b = sample.bbox;
  const x1 = offX + b.x1 * scale, y1 = offY + b.y1 * scale;
  const x2 = offX + b.x2 * scale, y2 = offY + b.y2 * scale;
  const w = x2 - x1, h = y2 - y1;
  if (w <= 0 || h <= 0) return;
  const c = color || '#22c55e';
  const cat = (status && _STATUS_STYLE[status]) ? status : 'confirmed';
  const style = _STATUS_STYLE[cat];
  ctx.save();
  ctx.globalAlpha = style.alpha;
  ctx.strokeStyle = c;
  ctx.lineWidth = 2;
  ctx.setLineDash(style.dash);
  ctx.strokeRect(x1, y1, w, h);
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  const lblName = OBJ_LABEL[sample.label] || sample.label || '';
  if (lblName){
    const pct = sample.score != null ? Math.round(sample.score * 100) : null;
    const scoreText = pct != null ? `${style.marker}${pct}%` : '';
    const text = scoreText ? `${lblName} · ${scoreText}` : lblName;
    const padX = 6, pillH = 18;
    const tw = ctx.measureText(text).width;
    const pillY = Math.max(0, y1 - pillH - 2);
    ctx.globalAlpha = style.alpha;
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(x1, pillY, tw + padX * 2, pillH);
    ctx.fillStyle = c;
    ctx.fillText(text, x1 + padX, pillY + 3);
  }
  ctx.restore();
}
