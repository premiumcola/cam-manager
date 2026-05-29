// ─── camedit/detection.js ──────────────────────────────────────────────────
// Form-field initializers + Erkennung-tab status strip + thin re-exports
// of the per-class grids, the object-filter pills, and the simulation
// sheet. R14 lifted those pieces into their own files so this surface
// stays focused on form + status concerns; existing camedit/index.js
// imports stay valid via the named re-exports at the bottom.
import { byId } from '../core/dom.js';
import { state } from '../core/state.js';

// Re-exports — preserve the existing API used by camedit/index.js so
// the consumer sees no rename. See each sub-module for the actual
// implementation.
export {
  _renderErkPerClassConfidence,
  _bindErkPerClassToggle,
  _collectLabelThresholds,
  _renderErkPerClassConfirm,
  _bindErkConfirmPerClassToggle,
  _collectConfirmationWindow,
  _renderCamConfirmGrid,
} from './detection-perclass.js';
export {
  getCamObjectFilterState,
  setCamObjectFilterState,
  _renderCamObjectPills,
} from './detection-objectfilter.js';

let _camFormInited = false;
export function _initCameraFormListeners() {
  if (_camFormInited) return;
  _camFormInited = true;
  const f = byId('cameraForm').elements;
  // Auto-generate ID from name (only for new cameras)
  f['name']?.addEventListener('input', () => {
    if (f['id'].dataset.autoGen === '1') {
      f['id'].value =
        'cam-' +
        f['name'].value
          .toLowerCase()
          .normalize('NFD')
          .replaceAll(/[̀-ͯ]/g, '')
          .replaceAll(/[^a-z0-9]+/g, '-')
          .replaceAll(/(^-|-$)/g, '');
    }
  });
  // Motion sensitivity slider — historical wiring for cards that still
  // use the old ID. The 5-step workflow's slider has its own wiring in
  // _initErkSliders; this row keeps motionSensLabel in sync if it
  // happens to be present in the template.
  f['motion_sensitivity']?.addEventListener('input', () => {
    const v = parseFloat(f['motion_sensitivity'].value || 0);
    const lbl = byId('motionSensLabel');
    if (lbl) lbl.textContent = Math.round(v * 100) + '%';
  });
  _initErkSliders(byId('cameraForm'));
}

// Erkennung-tab slider value labels. Single delegated handler over a
// (name, valueId, formatter) map so adding a new slider in Phase 2 is
// one extra row — not a new addEventListener block. Compound labels
// (frame-interval → fps, confirm_n + confirm_seconds → "N Treffer in S
// Sekunden") run after the per-slider loop.
export function _initErkSliders(form) {
  if (!form) return;
  const map = [
    ['detection_min_score', 'erkMinScoreVal', (v) => Math.round(v * 100) + ' %'],
    ['label_threshold_person', 'erkPersonVal', (v) => Math.round(v * 100) + ' %'],
    ['motion_sensitivity', 'erkMotionVal', (v) => Math.round(v * 100) + ' %'],
    ['frame_interval_ms', 'erkFrameIntervalVal', (v) => v + ' ms'],
    ['confirm_n', 'erkConfirmN', (v) => v + ' ×'],
    ['confirm_seconds', 'erkConfirmS', (v) => v + ' s'],
  ];
  for (const [name, valId, fmt] of map) {
    const inp = form.querySelector(`[name="${name}"]`);
    const lbl = document.querySelector('#' + valId);
    if (!inp || !lbl) continue;
    const upd = () => {
      lbl.textContent = fmt(parseFloat(inp.value));
    };
    inp.addEventListener('input', upd);
    upd();
  }
  // Compound: confirmation filter — "N Treffer in S Sekunden bestätigen".
  const cn = form.querySelector('[name="confirm_n"]');
  const cs = form.querySelector('[name="confirm_seconds"]');
  const cl = document.querySelector('#erkConfirmLbl');
  if (cn && cs && cl) {
    const upd = () => {
      cl.textContent = `${cn.value} Treffer in ${cs.value} Sekunden bestätigen`;
    };
    cn.addEventListener('input', upd);
    cs.addEventListener('input', upd);
    upd();
  }
  // Compound: frame_interval_ms → fps line. 1000 / interval rounded to
  // nearest integer; the slider's 100 ms low end is 10 fps, the 2000 ms
  // high end is 0.5 fps (rounds to 1).
  const fi = form.querySelector('[name="frame_interval_ms"]');
  const fl = document.querySelector('#erkFrameIntervalLbl');
  if (fi && fl) {
    const upd = () => {
      const fps = Math.max(1, Math.round(1000 / parseFloat(fi.value)));
      fl.textContent = `≈ ${fps} fps · niedriger = mehr Coral-Last`;
    };
    fi.addEventListener('input', upd);
    upd();
  }
}

// D3 · render + wire the small-animal ROI/tiling controls — the roi-mode
// segmented control (writes the hidden #roi_mode input the save collector
// reads) and the two D1 tuning sliders — from the camera config. Idempotent:
// re-opening cam-edit re-seeds without stacking handlers. (roi_mode is
// distinct from the runtime status field detection_mode.)
export function _bindDetectionRoiControls(form, cam) {
  const seg = byId('erkDetModeSeg');
  const hidden = byId('erkDetModeInput');
  if (seg && hidden) {
    const mode = (cam?.roi_mode || 'off').toLowerCase();
    hidden.value = ['off', 'roi', '2x2', '3x3'].includes(mode) ? mode : 'off';
    const paint = () => {
      seg.querySelectorAll('.erk-seg-btn').forEach((b) => {
        const on = b.dataset.mode === hidden.value;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    };
    paint();
    if (!seg.dataset.wired) {
      seg.dataset.wired = '1';
      seg.addEventListener('click', (e) => {
        const btn = e.target.closest('.erk-seg-btn');
        if (!btn) return;
        hidden.value = btn.dataset.mode;
        paint();
      });
    }
  }
  // Wildlife-low sensitivity (0 = auto).
  const wl = byId('erkWlSens');
  const wlv = byId('erkWlSensVal');
  if (wl && wlv) {
    wl.value = Number(cam?.wildlife_motion_sensitivity || 0);
    const upd = () => {
      const v = parseFloat(wl.value || 0);
      wlv.textContent = v <= 0 ? 'auto' : v.toFixed(1) + '×';
    };
    wl.oninput = upd;
    upd();
  }
  // Min net displacement to escalate (0 = module default 4 %).
  const net = byId('erkRoiNet');
  const netv = byId('erkRoiNetVal');
  if (net && netv) {
    net.value = Number(cam?.roi_min_net_disp_frac || 0);
    const upd = () => {
      const v = parseFloat(net.value || 0);
      netv.textContent = v <= 0 ? 'auto (4 %)' : Math.round(v * 100) + ' %';
    };
    net.oninput = upd;
    upd();
  }
}

// Erkennung-tab status strip — slim row with a coloured dot, an inline
// Coral state label, the per-frame inference latency, and the seconds-
// since-last-good-frame as a relative time. Mutates the static markup
// rather than re-rendering full HTML so the dot pulse animation isn't
// restarted on every state recompute. Called from editCamera() after
// the camera has been resolved AND every 3 s by live-update.js.
export function _renderGlobalStatusRows() {
  const host = byId('camGlobalStatus');
  if (!host) return;
  const camId = byId('cameraForm')?.elements?.['id']?.value;
  const cam = (state.cameras || []).find((x) => x.id === camId) || state.cameras?.[0];
  const proc = state.config?.processing || {};
  // Prefer the backend's explicit coral_mode (one of 'tpu' /
  // 'cpu_fallback' / 'off' — see camera_runtime.status). Fall back to
  // deriving from detection_mode + coral_available for older builds /
  // tests that don't surface coral_mode yet.
  let mode = cam?.coral_mode;
  if (!mode) {
    const coralOn = !!(proc.coral_enabled ?? cam?.detection_mode !== 'motion_only');
    const coralAvail = !!cam?.coral_available;
    if (!coralOn) mode = 'off';
    else if (cam?.detection_mode === 'coral' && coralAvail) mode = 'tpu';
    else if (cam?.detection_mode === 'cpu') mode = 'cpu_fallback';
    else mode = 'off';
  }
  const variant = mode === 'tpu' ? 'is-ok' : mode === 'cpu_fallback' ? 'is-cpu' : 'is-off';
  const text =
    mode === 'tpu' ? 'Coral läuft' : mode === 'cpu_fallback' ? 'CPU-Notfall' : 'Coral aus';
  const dot = host.querySelector('.dot');
  if (dot) {
    dot.classList.remove('is-ok', 'is-cpu', 'is-off');
    dot.classList.add(variant);
  }
  const txt = host.querySelector('#erkStatusText');
  if (txt) txt.textContent = text;
  const ms = Number(cam?.inference_avg_ms);
  const msEl = byId('erkStatusMs');
  if (msEl) {
    msEl.textContent =
      Number.isFinite(ms) && ms > 0 ? `${Math.round(ms)} ms / Frame` : '— ms / Frame';
  }
  const age = Number(cam?.frame_age_s);
  const upEl = byId('erkStatusUpdated');
  if (upEl) upEl.textContent = _fmtRelativeAgeS(age);
}

export function _fmtRelativeAgeS(s) {
  if (s == null || !Number.isFinite(s)) return '—';
  if (s < 5) return 'gerade eben';
  if (s < 60) return `vor ${Math.round(s)} s`;
  if (s < 3600) return `vor ${Math.round(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} Std.`;
  if (s < 7 * 86400) return `vor ${Math.round(s / 86400)} Tagen`;
  return 'vor >1 Woche';
}

// Inline onclick="_scrollToCoralSettings(event)" used by the Erkennung
// status-strip "Coral-Einstellungen öffnen" hyperlink.
window._scrollToCoralSettings = function (ev) {
  ev?.preventDefault();
  document.querySelector('a[href="#settings"]')?.click();
  setTimeout(() => {
    const section = byId('set-coral');
    if (!section) return;
    if (!section.classList.contains('open') && typeof window.toggleSetSection === 'function') {
      window.toggleSetSection('set-coral');
    }
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 120);
};
