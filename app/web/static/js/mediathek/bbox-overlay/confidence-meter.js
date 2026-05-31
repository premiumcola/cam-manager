// ─── mediathek/bbox-overlay/confidence-meter.js ────────────────────────────
// Recorded ADAPTER for the shared gauge pill. Finds every track active at
// videoEl.currentTime (visible, non-masked), normalises each into the
// { label, color, score, scoreThresh, fracH, fracArea, num } shape and
// hands the list to the ONE renderer (mediaview/detail-pill.js). The
// gauge markup + legend + amber-below-threshold logic live there now
// (L5); this file owns only the recorded host + the per-frame track
// extraction. Hidden entirely when no track is active.
import { byId } from '../../core/dom.js';
import { colors, OBJ_LABEL } from '../../core/icons.js';
import { lbState } from '../state.js';
import { _BBOX_FLOORS } from './track-loss-tooltip.js';
import { _interpolateTrackAt, _isPointInAnyMask, _resolveMaskPolygonsForCam } from './renderer.js';
import { _getHiddenClassesForCam } from './hidden-classes.js';
import { renderDetailPill } from '../../mediaview/detail-pill.js';

function _ensureConfidenceMeter() {
  let host = byId('lightboxConfidenceMeter');
  if (host) return host;
  const wrap = byId('lightboxMediaWrap');
  if (!wrap) return null;
  host = document.createElement('div');
  host.id = 'lightboxConfidenceMeter';
  host.hidden = true;
  wrap.appendChild(host);
  return host;
}

function _findActiveTracksAt(currentTime, opts = {}) {
  const tracks = lbState.item?._tracks?.tracks || [];
  const out = [];
  const hidden = opts.hidden || new Set();
  const masks = opts.masks || [];
  const natW = opts.natW || 0;
  const natH = opts.natH || 0;
  for (const tr of tracks) {
    // Filter out hidden classes (the per-class toggle in the
    // timeline-panel sidebar) so toggling a class off also
    // removes it from the characteristic card.
    if (hidden.has(tr.label)) continue;
    const sample = _interpolateTrackAt(tr, currentTime);
    if (!sample) continue;
    // Filter out masked-out tracks — same ground-point-in-mask
    // test the bbox renderer uses, so the card stays aligned
    // with which boxes are actually surfaced as alerting.
    if (masks.length) {
      const bb = sample.bbox || {};
      const cx = (bb.x1 + bb.x2) / 2;
      const cy = bb.y2;
      if (_isPointInAnyMask(cx, cy, natW, natH, masks)) continue;
    }
    out.push({ track: tr, sample, num: tr._num || 0 });
  }
  return out;
}

// Normalise one active track into the shared detail-pill card shape.
// fracH/fracArea prefer the sidecar's last_bbox_frac_* (the LAST observed
// bbox the worker gated on); older schema-<2 sidecars fall back to the
// current sample's pixel fraction. Each is gated by the per-class floor
// so a class with no min-size gate shows no Höhe/Fläche row.
function _normaliseTrack(track, sample, num, hasRs, rs, natW, natH) {
  const c = track.color || colors[track.label] || colors.unknown;
  let scoreThresh = null;
  if (hasRs) {
    scoreThresh = rs.conf_thresh_general ?? null;
    const perCls = rs.conf_thresh_per_class || {};
    if (Object.prototype.hasOwnProperty.call(perCls, track.label)) {
      scoreThresh = perCls[track.label];
    }
    if (scoreThresh != null) scoreThresh = parseFloat(scoreThresh);
  }
  let fracH = null;
  let fracArea = null;
  const floors = _BBOX_FLOORS[track.label];
  if (floors) {
    let fH = track.last_bbox_frac_h;
    let fA = track.last_bbox_frac_area;
    if (fH == null || fA == null) {
      const bb = sample.bbox || {};
      const bbW = Math.max(0, (bb.x2 || 0) - (bb.x1 || 0));
      const bbH = Math.max(0, (bb.y2 || 0) - (bb.y1 || 0));
      if (fH == null) fH = bbH / natH;
      if (fA == null) fA = (bbW * bbH) / (natW * natH);
    }
    if (floors.min_h_frac > 0) fracH = fH;
    if (floors.min_area_frac > 0) fracArea = fA;
  }
  return {
    label: OBJ_LABEL[track.label] || track.label || '?',
    color: c,
    score: sample.score || 0,
    scoreThresh: hasRs ? scoreThresh : null,
    fracH,
    fracArea,
    num,
    missingThresh: !hasRs,
  };
}

export function _renderConfidenceMeter() {
  const v = byId('lightboxVideo');
  const host = _ensureConfidenceMeter();
  if (!host || !v || !lbState.item) {
    if (host) host.hidden = true;
    return;
  }
  // Only paint in full-screen video mode — photo events / timelapse
  // shouldn't see this pill at all.
  if (!byId('lightboxModal')?.classList.contains('lb-fs-video')) {
    host.hidden = true;
    return;
  }
  const t = Number.isFinite(v.currentTime) ? v.currentTime : 0;
  const natW = v.videoWidth || 1;
  const natH = v.videoHeight || 1;
  const camId = lbState.item.camera_id || '';
  const hidden = _getHiddenClassesForCam(camId);
  const masks = _resolveMaskPolygonsForCam(camId);
  const active = _findActiveTracksAt(t, { hidden, masks, natW, natH });
  if (active.length === 0) {
    host.hidden = true;
    return;
  }
  const rs = lbState.item.recording_settings;
  const hasRs = !!(rs && typeof rs === 'object' && (rs.mode || rs.conf_thresh_general != null));
  // H3 · the card lists ALL currently-visible / non-masked tracks; hidden
  // classes + masked-out subjects were filtered upstream, so what
  // survives is by definition worth showing.
  const tracks = active.map(({ track, sample, num }) =>
    _normaliseTrack(track, sample, num, hasRs, rs, natW, natH),
  );
  renderDetailPill(host, { tracks });
}
