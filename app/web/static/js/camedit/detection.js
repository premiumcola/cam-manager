// ─── camedit/detection.js ──────────────────────────────────────────────────
// Stage 8 of the legacy.js → ES modules refactor — every Erkennung-tab
// UI bit that drives the per-camera detection settings:
//   • Camera form one-time listeners (auto-id, motion-sens, Erk-tab sliders)
//   • Erkennung 5-step workflow sliders + per-class confidence drilldown
//     + per-class confirmation-window drilldown
//   • _collectLabelThresholds / _collectConfirmationWindow — read sliders
//     into the dict shape settings.json expects
//   • Erkennung-tab "jetzt simulieren" button + result panel + bbox SVG
//   • Per-camera object-filter pills (Person/Cat/Bird/Car/Dog/Squirrel)
//   • Erkennung-tab status strip (_renderGlobalStatusRows + age formatter)
//   • Hidden legacy confirmation-grid (_CW_DEFAULTS + _renderCamConfirmGrid)
import { byId, esc } from '../core/dom.js';
import { state } from '../core/state.js';
import { OBJ_LABEL, objIconSvg } from '../core/icons.js';
import { showToast } from '../core/toast.js';

let _camFormInited = false;
export function _initCameraFormListeners(){
  if (_camFormInited) return;
  _camFormInited = true;
  const f = byId('cameraForm').elements;
  // Auto-generate ID from name (only for new cameras)
  f['name']?.addEventListener('input', () => {
    if (f['id'].dataset.autoGen === '1'){
      f['id'].value = 'cam-' + f['name'].value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
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
export function _initErkSliders(form){
  if (!form) return;
  const map = [
    ['detection_min_score',    'erkMinScoreVal',      v => Math.round(v * 100) + '%'],
    ['label_threshold_person', 'erkPersonVal',        v => Math.round(v * 100) + '%'],
    ['motion_sensitivity',     'erkMotionVal',        v => Math.round(v * 100) + '%'],
    ['frame_interval_ms',      'erkFrameIntervalVal', v => v + ' ms'],
    ['confirm_n',              'erkConfirmN',         v => v + ' ×'],
    ['confirm_seconds',        'erkConfirmS',         v => v + ' s'],
  ];
  for (const [name, valId, fmt] of map){
    const inp = form.querySelector(`[name="${name}"]`);
    const lbl = document.getElementById(valId);
    if (!inp || !lbl) continue;
    const upd = () => { lbl.textContent = fmt(parseFloat(inp.value)); };
    inp.addEventListener('input', upd);
    upd();
  }
  // Compound: confirmation filter — "N Treffer in S Sekunden bestätigen".
  const cn = form.querySelector('[name="confirm_n"]');
  const cs = form.querySelector('[name="confirm_seconds"]');
  const cl = document.getElementById('erkConfirmLbl');
  if (cn && cs && cl){
    const upd = () => { cl.textContent = `${cn.value} Treffer in ${cs.value} Sekunden bestätigen`; };
    cn.addEventListener('input', upd);
    cs.addEventListener('input', upd);
    upd();
  }
  // Compound: frame_interval_ms → fps line. 1000 / interval rounded to
  // nearest integer; the slider's 100 ms low end is 10 fps, the 2000 ms
  // high end is 0.5 fps (rounds to 1).
  const fi = form.querySelector('[name="frame_interval_ms"]');
  const fl = document.getElementById('erkFrameIntervalLbl');
  if (fi && fl){
    const upd = () => {
      const fps = Math.max(1, Math.round(1000 / parseFloat(fi.value)));
      fl.textContent = `≈ ${fps} fps · niedriger = mehr Coral-Last`;
    };
    fi.addEventListener('input', upd);
    upd();
  }
}

// Per-class confidence drilldown rendered into #erkPerClassAdvanced when
// the user opens "Pro Klasse anpassen" under step 2. Defaults mirror the
// settings_store fallbacks (cat 0.55 / bird 0.45 / squirrel 0.45 / car
// 0.65 / dog 0.55) so a fresh camera with no per-class entries doesn't
// look misconfigured. Sliders are name="label_threshold_<key>" so the
// save handler's _collectLabelThresholds() picks them up automatically.
const _ERK_PERCLASS_CONFIDENCE = [
  { key: 'cat',      label: 'Katze',        defaultV: 0.55 },
  { key: 'bird',     label: 'Vogel',        defaultV: 0.45 },
  { key: 'squirrel', label: 'Eichhörnchen', defaultV: 0.45 },
  { key: 'car',      label: 'Auto',         defaultV: 0.65 },
  { key: 'dog',      label: 'Hund',         defaultV: 0.55 },
];
export function _renderErkPerClassConfidence(form, cam){
  const wrap = byId('erkPerClassAdvanced');
  if (!wrap) return;
  const thresholds = cam?.label_thresholds || {};
  wrap.innerHTML = _ERK_PERCLASS_CONFIDENCE.map(c => {
    const raw = thresholds[c.key];
    const v = (raw != null && Number.isFinite(parseFloat(raw))) ? parseFloat(raw) : c.defaultV;
    return `
      <div class="erk-card">
        <div class="row">
          <input type="range" name="label_threshold_${c.key}" min="0.50" max="0.95" step="0.01" value="${v.toFixed(2)}" />
          <span class="val" id="erkLT_${c.key}_val">${Math.round(v * 100)}%</span>
        </div>
        <span class="lbl">${esc(c.label)} · überschreibt allgemein</span>
      </div>`;
  }).join('');
  _ERK_PERCLASS_CONFIDENCE.forEach(c => {
    const inp = wrap.querySelector(`[name="label_threshold_${c.key}"]`);
    const lbl = byId(`erkLT_${c.key}_val`);
    if (inp && lbl){
      inp.addEventListener('input', () => {
        lbl.textContent = Math.round(parseFloat(inp.value) * 100) + '%';
      });
    }
  });
}

// One-time wiring for the "Pro Klasse anpassen ▾" disclosure toggle in
// step 2. Idempotent via dataset.wired so re-opening cam-edit doesn't
// double-bind.
export function _bindErkPerClassToggle(){
  const btn = byId('erkPerClassToggle');
  const wrap = byId('erkPerClassAdvanced');
  const lbl = byId('erkPerClassToggleLbl');
  if (!btn || !wrap || !lbl || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => {
    const open = wrap.hidden;
    wrap.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    lbl.textContent = open ? 'Weniger anzeigen' : 'Pro Klasse anpassen';
  });
}

// Read every label_threshold_<class> slider from the form into the
// dict shape settings.json expects. Includes the step-2 person
// slider AND any per-class drilldown sliders rendered into
// #erkPerClassAdvanced. Drops NaN values silently — no slider, no
// entry, schema falls back to the global detection_min_score.
export function _collectLabelThresholds(form){
  const out = {};
  form.querySelectorAll('[name^="label_threshold_"]').forEach(inp => {
    const key = inp.name.replace('label_threshold_', '');
    const v = parseFloat(inp.value);
    if (key && Number.isFinite(v)) out[key] = v;
  });
  return out;
}

// Per-class confirmation-window drilldown rendered into
// #erkConfirmPerClass when "Pro Klasse anpassen" under step 3 is
// opened. Defaults track settings_store fallbacks (per-class N-of-M
// vary by how noisy each class typically is).
const _ERK_PERCLASS_CONFIRM = [
  { key: 'person',   label: 'Person',       defN: 3, defS: 5 },
  { key: 'cat',      label: 'Katze',        defN: 3, defS: 5 },
  { key: 'bird',     label: 'Vogel',        defN: 2, defS: 4 },
  { key: 'squirrel', label: 'Eichhörnchen', defN: 2, defS: 3 },
];
export function _renderErkPerClassConfirm(form, cam){
  const wrap = byId('erkConfirmPerClass');
  if (!wrap) return;
  const cw = cam?.confirmation_window || {};
  wrap.innerHTML = _ERK_PERCLASS_CONFIRM.map(c => {
    const cur = cw[c.key] || {};
    const n = parseInt(cur.n, 10);
    const s = parseFloat(cur.seconds);
    const nVal = Number.isFinite(n) ? n : c.defN;
    const sVal = Number.isFinite(s) ? Math.round(s) : c.defS;
    return `
      <div class="erk-card">
        <div class="two-col">
          <div class="row">
            <input type="range" name="confirm_${c.key}_n" min="1" max="10" step="1" value="${nVal}" />
            <span class="val" id="erkCWN_${c.key}">${nVal} ×</span>
          </div>
          <div class="row">
            <input type="range" name="confirm_${c.key}_s" min="2" max="20" step="1" value="${sVal}" />
            <span class="val" id="erkCWS_${c.key}">${sVal} s</span>
          </div>
        </div>
        <span class="lbl" id="erkCWL_${c.key}">${esc(c.label)} · ${nVal} in ${sVal} s</span>
      </div>`;
  }).join('');
  _ERK_PERCLASS_CONFIRM.forEach(c => {
    const nInp = wrap.querySelector(`[name="confirm_${c.key}_n"]`);
    const sInp = wrap.querySelector(`[name="confirm_${c.key}_s"]`);
    const nLbl = byId(`erkCWN_${c.key}`);
    const sLbl = byId(`erkCWS_${c.key}`);
    const cLbl = byId(`erkCWL_${c.key}`);
    if (!nInp || !sInp) return;
    const upd = () => {
      if (nLbl) nLbl.textContent = nInp.value + ' ×';
      if (sLbl) sLbl.textContent = sInp.value + ' s';
      if (cLbl) cLbl.textContent = `${c.label} · ${nInp.value} in ${sInp.value} s`;
    };
    nInp.addEventListener('input', upd);
    sInp.addEventListener('input', upd);
  });
}

export function _bindErkConfirmPerClassToggle(){
  const btn = byId('erkConfirmPerClassToggle');
  const wrap = byId('erkConfirmPerClass');
  const lbl = byId('erkConfirmPerClassToggleLbl');
  if (!btn || !wrap || !lbl || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => {
    const open = wrap.hidden;
    wrap.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    lbl.textContent = open ? 'Weniger anzeigen' : 'Pro Klasse anpassen';
  });
}

// Read every confirm_<class>_n + confirm_<class>_s slider pair from
// the form into the dict shape settings.json expects:
//   { global: {n,seconds}, person: {n,seconds}, cat: {n,seconds}, … }
// Existing entries with no UI slider in scope are merged from
// existingCam — Phase 1's preservation pattern is unchanged here.
export function _collectConfirmationWindow(form, existingCam){
  const out = { ...(existingCam?.confirmation_window || {}) };
  // Legacy hidden grid (compat — see #camConfirmGrid).
  const grid = byId('camConfirmGrid');
  grid?.querySelectorAll('[data-cw-cls]').forEach(row => {
    const cls = row.dataset.cwCls;
    const nIn = row.querySelector('[data-cw-n]');
    const sIn = row.querySelector('[data-cw-s]');
    const n = parseInt(nIn?.value, 10);
    const s = parseFloat(sIn?.value);
    if (cls && Number.isFinite(n) && Number.isFinite(s)){
      out[cls] = { n: Math.max(1, n), seconds: Math.max(0.5, s) };
    }
  });
  // Step-3 global slider.
  const gn = parseInt(form.querySelector('[name="confirm_n"]')?.value, 10);
  const gs = parseFloat(form.querySelector('[name="confirm_seconds"]')?.value);
  if (Number.isFinite(gn) && Number.isFinite(gs)){
    out.global = { n: Math.max(1, gn), seconds: Math.max(2, gs) };
  }
  // Per-class drilldown sliders — confirm_<key>_n / confirm_<key>_s.
  // Only emit an entry when both inputs exist and parse as finite.
  form.querySelectorAll('[name^="confirm_"][name$="_n"]').forEach(nInp => {
    const m = nInp.name.match(/^confirm_(.+)_n$/);
    if (!m) return;
    const key = m[1];
    if (!key || key === 'seconds' || key === 'global') return;
    const sInp = form.querySelector(`[name="confirm_${key}_s"]`);
    const n = parseInt(nInp.value, 10);
    const s = parseFloat(sInp?.value);
    if (Number.isFinite(n) && Number.isFinite(s)){
      out[key] = { n: Math.max(1, n), seconds: Math.max(2, s) };
    }
  });
  return out;
}

// "Erkennung jetzt simulieren" — the button below the 5 steps in the
// Erkennung tab. Posts to /api/cameras/<id>/test-detection, animates
// the icon while the request is in flight, then renders the snapshot
// + bounding boxes inline. Click again to re-run; click × to dismiss.
export function _bindErkSimulate(){
  const btn = byId('erkSimulateBtn');
  const close = byId('erkSimClose');
  if (btn && !btn.dataset.wired){
    btn.dataset.wired = '1';
    btn.addEventListener('click', _onErkSimulateClick);
  }
  if (close && !close.dataset.wired){
    close.dataset.wired = '1';
    close.addEventListener('click', () => {
      const wrap = byId('erkSimResult');
      if (wrap) wrap.hidden = true;
    });
  }
}

async function _onErkSimulateClick(ev){
  const btn = ev.currentTarget;
  const camId = byId('cameraForm')?.elements?.['id']?.value;
  if (!camId) return;
  const lblEl = btn.querySelector('.erk-test-btn-lbl');
  const originalLabel = lblEl?.textContent || '';
  btn.disabled = true;
  btn.classList.add('is-busy');
  if (lblEl) lblEl.textContent = ' simuliere…';
  try {
    const r = await fetch(`/api/cameras/${encodeURIComponent(camId)}/test-detection`, { method: 'POST' });
    let data = null;
    try { data = await r.json(); } catch {}
    if (!r.ok || !data?.ok){
      const msg = (data && data.error) ? data.error : 'Fehler';
      showToast('Test fehlgeschlagen · ' + msg, 'error');
      return;
    }
    _renderErkSimResult(data);
  } catch {
    showToast('Test fehlgeschlagen · Netzwerk', 'error');
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-busy');
    if (lblEl) lblEl.textContent = originalLabel;
  }
}

const _ERK_VERDICT_TXT = {
  'pass':         'würde Alarm auslösen',
  'belowthresh':  '',
  'filtered':     '',
};

function _renderErkSimResult(data){
  const wrap = byId('erkSimResult');
  if (!wrap) return;
  const img  = byId('erkSimImg');
  const ovl  = byId('erkSimOverlay');
  const list = byId('erkSimList');
  const ttl  = byId('erkSimTitle');
  if (img) img.src = data.snapshot || '';
  // viewBox in absolute frame pixel coordinates so backend bbox values
  // (which are pixel-space) drop in unchanged. preserveAspectRatio in
  // the inline element default is xMidYMid meet — but since the wrapper
  // .erk-test-result-imgwrap forces a 16:9 aspect ratio and the <img>
  // uses object-fit:contain, the SVG and the image scale identically.
  const fs = data.frame_size || { w: 1920, h: 1080 };
  if (ovl) ovl.setAttribute('viewBox', `0 0 ${Math.max(1, fs.w)} ${Math.max(1, fs.h)}`);

  const dets = data.detections || [];
  const passCount = dets.filter(d => d.verdict === 'pass').length;
  if (ttl){
    ttl.textContent = passCount > 0
      ? `${passCount} Treffer würden Alarm auslösen`
      : (dets.length === 0 ? 'Keine Erkennung' : 'Kein Treffer würde Alarm auslösen');
  }
  // Boxes — paint-order=stroke on the label so the dark halo stays
  // readable above bright snapshot regions. font-size scales with the
  // viewBox; an absolute "10 px" on a 1920-wide viewBox shows up as
  // ~10 px in screen pixels regardless of how the wrapper scales.
  if (ovl){
    ovl.innerHTML = dets.map(d => {
      const cls = `erk-det-box is-${d.verdict}`;
      const labelText = `${d.label} ${Math.round(d.score * 100)}%`;
      const fontSize = Math.max(10, Math.round(fs.w / 100));
      const boxR = Math.max(2, Math.round(fs.w / 480));
      return `
        <rect class="${cls}" x="${d.bbox[0]}" y="${d.bbox[1]}" width="${d.bbox[2]}" height="${d.bbox[3]}" rx="${boxR}" vector-effect="non-scaling-stroke" />
        <text class="erk-det-label" x="${d.bbox[0] + 4}" y="${d.bbox[1] + fontSize + 2}" font-size="${fontSize}">${esc(labelText)}</text>
      `;
    }).join('');
  }
  if (list){
    if (dets.length === 0){
      list.innerHTML = `<div class="erk-det-empty">Coral hat in diesem Frame nichts erkannt.</div>`;
    } else {
      list.innerHTML = dets.map(d => {
        const verdictText = d.reason || _ERK_VERDICT_TXT[d.verdict] || '';
        return `
          <div class="erk-det-row is-${esc(d.verdict)}">
            <span class="det-dot"></span>
            <span class="det-name">${esc(d.label)}</span>
            <span class="det-score">${Math.round(d.score * 100)}%</span>
            <span class="det-verdict">${esc(verdictText)}</span>
          </div>`;
      }).join('');
    }
  }
  wrap.hidden = false;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  wrap.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' });
}

// Per-camera object-filter pills (Person/Cat/Bird/Car/Dog/Squirrel).
// Same visual recipe as the Mediathek filter bar — active pill fills
// with the object colour via --cb. _camObjectFilterState mirrors the
// hidden #object_filter input so the existing save flow doesn't
// change.
const _CAM_OBJ_OPTIONS = [
  { k: 'person',   label: 'Person',       cb: '#a855f7' },
  { k: 'cat',      label: 'Katze',        cb: '#ec4899' },
  { k: 'bird',     label: 'Vogel',        cb: '#06b6d4' },
  { k: 'car',      label: 'Auto',         cb: '#f59e0b' },
  { k: 'dog',      label: 'Hund',         cb: '#7c2d12' },
  { k: 'squirrel', label: 'Eichhörnchen', cb: '#7c4a1f' },
];
let _camObjectFilterState = [];
export function getCamObjectFilterState(){ return _camObjectFilterState.slice(); }
export function setCamObjectFilterState(arr){
  _camObjectFilterState = [...(arr || [])];
}
export function _renderCamObjectPills(){
  const host = byId('camObjectFilter');
  if (!host) return;
  const active = new Set(_camObjectFilterState);
  host.innerHTML = _CAM_OBJ_OPTIONS.map(o => {
    const on = active.has(o.k);
    return `<button type="button" class="cam-obj-pill${on ? ' active' : ''}" data-obj="${o.k}" style="--cb:${o.cb}"><span class="cop-ico">${objIconSvg(o.k, 16) || ''}</span><span>${o.label}</span></button>`;
  }).join('');
  host.querySelectorAll('.cam-obj-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.obj;
      if (active.has(k)){ active.delete(k); btn.classList.remove('active'); }
      else { active.add(k); btn.classList.add('active'); }
      _camObjectFilterState = [..._CAM_OBJ_OPTIONS.map(o => o.k).filter(x => active.has(x))];
      const hidden = byId('cameraForm').elements['object_filter'];
      if (hidden) hidden.value = _camObjectFilterState.join(',');
    });
  });
}

// Erkennung-tab status strip — slim row with a coloured dot, an inline
// Coral state label, the per-frame inference latency, and the seconds-
// since-last-good-frame as a relative time. Mutates the static markup
// rather than re-rendering full HTML so the dot pulse animation isn't
// restarted on every state recompute. Called from editCamera() after
// the camera has been resolved AND every 3 s by live-update.js.
export function _renderGlobalStatusRows(){
  const host = byId('camGlobalStatus');
  if (!host) return;
  const camId = byId('cameraForm')?.elements?.['id']?.value;
  const cam = (state.cameras || []).find(x => x.id === camId) || state.cameras?.[0];
  const proc = state.config?.processing || {};
  // Prefer the backend's explicit coral_mode (one of 'tpu' /
  // 'cpu_fallback' / 'off' — see camera_runtime.status). Fall back to
  // deriving from detection_mode + coral_available for older builds /
  // tests that don't surface coral_mode yet.
  let mode = cam?.coral_mode;
  if (!mode){
    const coralOn = !!(proc.coral_enabled ?? (cam?.detection_mode !== 'motion_only'));
    const coralAvail = !!cam?.coral_available;
    if (!coralOn) mode = 'off';
    else if (cam?.detection_mode === 'coral' && coralAvail) mode = 'tpu';
    else if (cam?.detection_mode === 'cpu') mode = 'cpu_fallback';
    else mode = 'off';
  }
  const variant = mode === 'tpu' ? 'is-ok'
                : mode === 'cpu_fallback' ? 'is-cpu'
                : 'is-off';
  const text = mode === 'tpu' ? 'Coral läuft'
             : mode === 'cpu_fallback' ? 'CPU-Notfall'
             : 'Coral aus';
  const dot = host.querySelector('.dot');
  if (dot){
    dot.classList.remove('is-ok', 'is-cpu', 'is-off');
    dot.classList.add(variant);
  }
  const txt = host.querySelector('#erkStatusText');
  if (txt) txt.textContent = text;
  const ms = Number(cam?.inference_avg_ms);
  const msEl = byId('erkStatusMs');
  if (msEl){
    msEl.textContent = (Number.isFinite(ms) && ms > 0)
      ? `${Math.round(ms)} ms / Frame`
      : '— ms / Frame';
  }
  const age = Number(cam?.frame_age_s);
  const upEl = byId('erkStatusUpdated');
  if (upEl) upEl.textContent = _fmtRelativeAgeS(age);
}

export function _fmtRelativeAgeS(s){
  if (s == null || !Number.isFinite(s)) return '—';
  if (s < 5)        return 'gerade eben';
  if (s < 60)       return `vor ${Math.round(s)} s`;
  if (s < 3600)     return `vor ${Math.round(s / 60)} Min.`;
  if (s < 86400)    return `vor ${Math.round(s / 3600)} Std.`;
  if (s < 7 * 86400) return `vor ${Math.round(s / 86400)} Tagen`;
  return 'vor >1 Woche';
}

// Inline onclick="_scrollToCoralSettings(event)" used by the Erkennung
// status-strip "Coral-Einstellungen öffnen" hyperlink.
window._scrollToCoralSettings = function(ev){
  ev?.preventDefault();
  document.querySelector('a[href="#settings"]')?.click();
  setTimeout(() => {
    const section = byId('set-coral');
    if (!section) return;
    if (!section.classList.contains('open') && typeof window.toggleSetSection === 'function'){
      window.toggleSetSection('set-coral');
    }
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 120);
};

// Per-class fallbacks for the legacy hidden confirmation-window UI grid
// (#camConfirmGrid). Mirrors settings_store._CONFIRMATION_WINDOW_DEFAULTS
// so the UI shows the same defaults the backend would apply. The Erk-
// tab 5-step workflow uses a different, sliders-based UI (_renderErkPer
// ClassConfirm above); this grid is kept for older templates that still
// reference the data-cw-cls rows.
const _CW_DEFAULTS = {
  person:   { n: 3, seconds: 5.0 },
  cat:      { n: 3, seconds: 5.0 },
  bird:     { n: 2, seconds: 4.0 },
  squirrel: { n: 2, seconds: 3.0 },
  dog:      { n: 3, seconds: 5.0 },
  car:      { n: 3, seconds: 5.0 },
  motion:   { n: 2, seconds: 4.0 },
};
export function _renderCamConfirmGrid(c){
  const grid = byId('camConfirmGrid');
  if (!grid) return;
  const filter = (c.object_filter || []).filter(Boolean);
  const cw = c.confirmation_window || {};
  if (!filter.length){
    grid.innerHTML = `<div class="field-help" style="margin:0">Wähle oben Objekte aus, um Bestätigungs-Filter pro Klasse zu konfigurieren.</div>`;
    return;
  }
  grid.innerHTML = filter.map(cls => {
    const fb = _CW_DEFAULTS[cls] || { n: 3, seconds: 5.0 };
    const cur = cw[cls] || {};
    const n = parseInt(cur.n, 10);
    const s = parseFloat(cur.seconds);
    const nVal = Number.isFinite(n) ? n : fb.n;
    const sVal = Number.isFinite(s) ? s : fb.seconds;
    const lbl = (typeof OBJ_LABEL === 'object' && OBJ_LABEL[cls]) ? OBJ_LABEL[cls] : cls;
    return `
      <div class="cam-confirm-row" data-cw-cls="${esc(cls)}">
        <span class="cam-confirm-cls">${esc(lbl)} bestätigen nach</span>
        <input type="number" class="cam-confirm-n" data-cw-n min="1" max="10" step="1" value="${nVal}" inputmode="numeric"/>
        <span class="cam-confirm-sep">Treffer in</span>
        <input type="number" class="cam-confirm-s" data-cw-s min="0.5" max="30" step="0.5" value="${sVal}" inputmode="decimal"/>
        <span class="cam-confirm-unit">Sek</span>
      </div>`;
  }).join('');
}
