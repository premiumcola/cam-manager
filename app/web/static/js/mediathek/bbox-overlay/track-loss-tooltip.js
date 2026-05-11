// ─── mediathek/bbox-overlay/track-loss-tooltip.js ──────────────────────────
// Singleton popover element, lifted from the erk-sim/timeline.js pattern.
// Each × marker on the timeline carries data-track-idx so the handler
// can fetch the full track entry from _state.timelineTrackIndex without
// re-parsing tracks.json. Tooltip content explains WHY the track
// stopped (Konfidenz drop / Klassenfilter / Bbox / Timeout), pulling
// the comparison values from item.recording_settings.
import { OBJ_LABEL } from '../../core/icons.js';
import { lbState } from '../state.js';
import { _state } from './_state.js';

const _END_REASON_LABEL = {
  conf_drop:       'Konfidenz unter Schwelle gefallen',
  class_filter:    'Klasse aus Filter entfernt',
  bbox_too_small:  'Bbox unter Mindestgröße',
  timeout:         'Tracker verloren · keine Detektion',
  ended_at_clip:   'Spielzeit-Ende erreicht',
};

// Per-class minimum bbox floors — mirrors detectors/coral_object.py's
// _LABEL_MIN_BBOX so the tooltip can flag "below floor" without an
// extra API call. Add classes here when the backend grows new
// per-label floors. Exported so the confidence-meter can read the
// same source of truth.
export const _BBOX_FLOORS = {
  person: { min_h_frac: 0.15, min_area_frac: 0.02 },
};

function _ensureBarEndTip(){
  if (_state.barEndTipEl) return _state.barEndTipEl;
  const tip = document.createElement('div');
  tip.className = 'lbtt-end-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);
  _state.barEndTipEl = tip;
  // Scroll / outside-click dismiss — same lifecycle as the erk-sim
  // tooltip util so the user's muscle memory carries over.
  window.addEventListener('scroll', _hideBarEndTip, { passive: true });
  document.addEventListener('click', (ev) => {
    if (_state.barEndTipEl?.hidden) return;
    if (ev.target.closest('.lbtt-bar-end')) return;
    if (ev.target.closest('.lbtt-end-tip')) return;
    _hideBarEndTip();
  });
  return _state.barEndTipEl;
}

function _hideBarEndTip(){
  if (_state.barEndTipEl) _state.barEndTipEl.hidden = true;
}

function _buildBarEndTipHtml(track, trackNum, rs){
  const lbl = OBJ_LABEL[track?.label] || track?.label || '?';
  // span = last - first sample time, in seconds, 1-decimal.
  const samples = track?.samples || [];
  const span = (samples.length >= 2)
    ? (parseFloat(samples[samples.length - 1].t) - parseFloat(samples[0].t)).toFixed(1)
    : '0.0';
  const reason = track?.end_reason;
  const summary = reason
    ? (_END_REASON_LABEL[reason] || `Grund: ${reason}`)
    : 'Grund unbekannt — Re-Index empfohlen';
  // Score row — compare last_score against per-class or general thresh.
  let scoreRow = '<span class="lbtt-end-tip-key">Score:</span> <span class="lbtt-end-tip-val">—</span>';
  const lastScore = track?.last_score;
  if (lastScore != null){
    let thresh = rs?.conf_thresh_general ?? null;
    const perCls = rs?.conf_thresh_per_class || {};
    if (Object.prototype.hasOwnProperty.call(perCls, track.label)){
      thresh = perCls[track.label];
    }
    const pct = Math.round(parseFloat(lastScore) * 100);
    const tpct = thresh != null ? Math.round(parseFloat(thresh) * 100) : null;
    const op = tpct != null ? (pct < tpct ? '<' : '≥') : '·';
    const tone = tpct != null && pct < tpct ? 'is-bad' : 'is-ok';
    scoreRow = `<span class="lbtt-end-tip-key">Score:</span> <span class="lbtt-end-tip-val ${tone}">${pct} %${tpct != null ? ` ${op} ${tpct} %` : ''}</span>`;
  }
  // Bbox row — compare last_bbox_size + frac against the per-class floor.
  let bboxRow = '<span class="lbtt-end-tip-key">Bbox:</span> <span class="lbtt-end-tip-val">—</span>';
  const lbs = track?.last_bbox_size_px;
  if (Array.isArray(lbs) && lbs.length === 2){
    const floors = _BBOX_FLOORS[track.label];
    let bad = false;
    if (floors){
      const fh = track?.last_bbox_frac_h ?? 0;
      const fa = track?.last_bbox_frac_area ?? 0;
      if (fh < floors.min_h_frac || fa < floors.min_area_frac) bad = true;
    }
    const tone = bad ? 'is-bad' : 'is-ok';
    const tick = bad ? '✗' : '✓';
    bboxRow = `<span class="lbtt-end-tip-key">Bbox:</span> <span class="lbtt-end-tip-val ${tone}">${lbs[0]} × ${lbs[1]} px ${tick}</span>`;
  }
  // Class row — green ✓ if class is in the active filter (or filter
  // is null), red ✗ if filter is non-null and excludes the class.
  let classRow = `<span class="lbtt-end-tip-key">Klasse:</span> <span class="lbtt-end-tip-val">${lbl}</span>`;
  const objFilter = rs?.object_filter;
  if (objFilter != null && Array.isArray(objFilter)){
    const ok = objFilter.includes(track.label);
    const tone = ok ? 'is-ok' : 'is-bad';
    const tick = ok ? '✓' : '✗';
    classRow = `<span class="lbtt-end-tip-key">Klasse:</span> <span class="lbtt-end-tip-val ${tone}">${lbl} ${tick}</span>`;
  }
  return `
    <div class="lbtt-end-tip-title">× Track #${trackNum} verloren · ${span} s</div>
    <div class="lbtt-end-tip-row">${scoreRow}</div>
    <div class="lbtt-end-tip-row">${bboxRow}</div>
    <div class="lbtt-end-tip-row">${classRow}</div>
    <div class="lbtt-end-tip-summary">${summary}</div>`;
}

function _showBarEndTip(target){
  const idx = parseInt(target?.dataset?.trackIdx ?? '', 10);
  const trackNum = parseInt(target?.dataset?.trackNum ?? '', 10);
  if (!Number.isFinite(idx) || !Number.isFinite(trackNum)) return;
  const track = _state.timelineTrackIndex[idx];
  if (!track) return;
  const rs = lbState.item?.recording_settings || {};
  const tip = _ensureBarEndTip();
  tip.innerHTML = _buildBarEndTipHtml(track, trackNum, rs);
  tip.hidden = false;
  // Position above the × when there's vertical room, otherwise below.
  // Clamped horizontally to the viewport so the tip never gets cropped
  // at the iPhone-393 edge.
  const r = target.getBoundingClientRect();
  const tipR = tip.getBoundingClientRect();
  const above = r.top - tipR.height - 8;
  const top = above >= 8 ? above : r.bottom + 8;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  let left = r.left + r.width / 2 - tipR.width / 2;
  left = Math.max(8, Math.min(vw - tipR.width - 8, left));
  tip.style.top = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
}

export function _wireBarEndTooltips(host){
  // Idempotent: per-render flag avoids re-binding for every re-render.
  if (host.dataset.barEndTipWired === '1') return;
  host.dataset.barEndTipWired = '1';
  host.addEventListener('pointerover', (ev) => {
    const x = ev.target.closest('.lbtt-bar-end');
    if (x) _showBarEndTip(x);
  });
  host.addEventListener('pointerout', (ev) => {
    if (!host.contains(ev.relatedTarget)) _hideBarEndTip();
  });
  host.addEventListener('click', (ev) => {
    const x = ev.target.closest('.lbtt-bar-end');
    if (!x){ _hideBarEndTip(); return; }
    // Don't bubble to the .lbtt-bar seek handler — × is its own UX.
    ev.preventDefault(); ev.stopPropagation();
    if (_state.barEndTipEl && !_state.barEndTipEl.hidden
        && _state.barEndTipEl.dataset.activeFor === x.dataset.trackIdx){
      _hideBarEndTip();
      return;
    }
    _showBarEndTip(x);
    if (_state.barEndTipEl) _state.barEndTipEl.dataset.activeFor = x.dataset.trackIdx;
  });
}
