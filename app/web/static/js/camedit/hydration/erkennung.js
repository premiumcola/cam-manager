// ─── camedit/hydration/erkennung.js ────────────────────────────────────────
// N17 · Pure-DOM hydrator for the Erkennung tab's form fields. Carved
// out of editCamera() in camedit/index.js so the orchestration body
// shrinks without changing observable behaviour. Every field set here
// was previously set inline in the same order; the function is called
// in exactly the same slot of editCamera so state-dependent siblings
// (sliders, drilldowns) still see populated values when they run.
//
// No state capture beyond the (formEl, camCfg, state) arguments. The
// `state` arg is `core/state.js` — used only to read the global
// detection.min_score default for the per-cam fallback.
import { byId } from '../../core/dom.js';

export function hydrateErkennungFields(formEl, c, state) {
  const f = formEl.elements;
  if (f['bottom_crop_px']) f['bottom_crop_px'].value = c.bottom_crop_px || 0;
  if (f['motion_sensitivity']) {
    const ms = c.motion_sensitivity != null ? c.motion_sensitivity : 0.5;
    f['motion_sensitivity'].value = ms;
  }
  if (f['wildlife_motion_sensitivity']) {
    const raw = c.wildlife_motion_sensitivity;
    // 0.0 = "auto" → display the derived 1.4× motion_sensitivity preview
    // (capped at 1.0). The actual value persisted on save is whatever
    // the slider shows after the user touches it.
    const ms = parseFloat(c.motion_sensitivity) || 0.5;
    const auto = Math.min(1.0, ms * 1.4);
    const v = (raw != null && parseFloat(raw) > 0) ? parseFloat(raw) : auto;
    f['wildlife_motion_sensitivity'].value = v.toFixed(1);
    const lbl = byId('wildlifeMotionLabel');
    if (lbl) lbl.textContent = Math.round(v * 100) + '%';
  }
  if (f['detection_min_score']) {
    const globalMs = state.config?.processing?.detection?.min_score ?? 0.55;
    const cms = (c.detection_min_score && c.detection_min_score > 0) ? c.detection_min_score : globalMs;
    f['detection_min_score'].value = cms;
  }
  if (f['label_threshold_person']) {
    const lt = (c.label_thresholds || {}).person;
    const v = (lt != null && !Number.isNaN(parseFloat(lt))) ? parseFloat(lt) : 0.72;
    f['label_threshold_person'].value = v;
  }
  // Tracker overrides — restore the per-camera values. 0 (the
  // "use system default" sentinel) shows as 0 in the input; the
  // placeholder text tells the user what default kicks in.
  if (f['track_spawn_min_score']) {
    f['track_spawn_min_score'].value = parseFloat(c.track_spawn_min_score) || 0;
  }
  if (f['track_continue_min_score']) {
    f['track_continue_min_score'].value = parseFloat(c.track_continue_min_score) || 0;
  }
  if (f['track_miss_grace_seconds']) {
    f['track_miss_grace_seconds'].value = parseFloat(c.track_miss_grace_seconds) || 0;
  }
  if (f['track_iou_match_threshold']) {
    f['track_iou_match_threshold'].value = parseFloat(c.track_iou_match_threshold) || 0;
  }
  // L07 · ghost-track filter — default ON; treat explicit-false as
  // off, anything else as on so legacy cams that pre-date the field
  // pick up the default cleanup.
  if (f['track_filter_ghosts']) {
    f['track_filter_ghosts'].checked = (c.track_filter_ghosts !== false);
  }
  // Confirmation-window step 3 sliders — confirm_n/confirm_seconds carry
  // the new global entry. Existing per-class entries (cw[person] etc.)
  // stay in storage untouched.
  if (f['confirm_n']) {
    const g = (c.confirmation_window || {}).global || {};
    const n = parseInt(g.n, 10);
    f['confirm_n'].value = Number.isFinite(n) ? n : 3;
  }
  if (f['confirm_seconds']) {
    const g = (c.confirmation_window || {}).global || {};
    const s = parseFloat(g.seconds);
    f['confirm_seconds'].value = Number.isFinite(s) ? Math.round(s) : 5;
  }
  // detection_trigger lives as a hidden input on the Erkennung tab during
  // this transition; the follow-up commit moves it to a visible select on
  // the Allgemein tab. Either way we set the value so save preserves it.
  if (f['detection_trigger']) f['detection_trigger'].value = c.detection_trigger || 'motion_and_objects';
  if (f['post_motion_tail_s']) {
    // Normalise: 0 or null → "0" (Standard / Global-Wert), otherwise pick
    // closest preset. Save handler stores 0 when "Standard" is selected,
    // preserving the use-global-default sentinel.
    const tail = c.post_motion_tail_s || 0;
    const presets = ['0', '3', '5', '8', '10', '15'];
    f['post_motion_tail_s'].value = presets.includes(String(tail)) ? String(tail) : '0';
  }
  // frame_interval_ms is now the slider in step 4 of the Erkennung flow.
  if (f['frame_interval_ms']) {
    const fi = c.frame_interval_ms || 350;
    f['frame_interval_ms'].value = fi;
  }
}
