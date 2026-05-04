// ─── camedit/detection-perclass.js ─────────────────────────────────────────
// Per-class confidence + per-class confirmation-window grids on the
// Erkennung tab. Both share the same data model (per-camera per-label
// config) and the same DOM patterns (table grid with per-row toggle).
// Plus the legacy hidden #camConfirmGrid retained for older templates.
import { byId, esc } from '../core/dom.js';
import { OBJ_LABEL } from '../core/icons.js';


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
