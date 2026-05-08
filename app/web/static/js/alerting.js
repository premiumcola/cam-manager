// ─── alerting.js ───────────────────────────────────────────────────────────
// Stage 17 of the legacy.js → ES modules refactor — the Alerting tab on
// the cam-edit panel: per-class severity matrix (off / info / alarm),
// per-class notification cooldowns, conflict warning banner, test-push
// button, and the live status strip pulled from /api/system/telegram.
//
// Replaces the legacy 4-valued alarm_profile select. The runtime
// computes an event's effective severity by reading the detected
// labels and picking the highest-rank entry from class_severity[].
import { byId, esc } from './core/dom.js';
import { _fmtRelativeAgeS } from './camedit/detection.js';

const _ALERT_SEV_CLASSES = [
  { key: 'person',   label: 'Person',       em: '👤' },
  { key: 'cat',      label: 'Katze',        em: '🐈' },
  { key: 'bird',     label: 'Vogel',        em: '🐦' },
  { key: 'squirrel', label: 'Eichhörnchen', em: '🐿' },
  { key: 'car',      label: 'Auto',         em: '🚗' },
  { key: 'dog',      label: 'Hund',         em: '🐕' },
  { key: 'motion',   label: 'Bewegung',     em: '〰️' },
];

export function _renderSeverityMatrix(form, cam){
  const wrap = byId('alertSeverityMatrix');
  if (!wrap) return;
  const cs = cam?.class_severity || {};
  // Header row (Klasse | Aus | Info | Alarm).
  let html = `
    <div class="sev-cell sev-header">Klasse</div>
    <div class="sev-cell sev-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
      Aus
    </div>
    <div class="sev-cell sev-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/></svg>
      Info
    </div>
    <div class="sev-cell sev-header">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M2 5l4-3M22 5l-4-3"/></svg>
      Alarm
    </div>
  `;
  for (const c of _ALERT_SEV_CLASSES){
    const cur = cs[c.key] || 'off';
    const cell = (val, mode) => {
      const on = cur === val;
      const cls = `sev-cell sev-radio${on ? ' is-on is-' + mode + '-mode' : ''}`;
      return `<div class="${cls}" data-cls="${c.key}" data-val="${val}" role="radio" aria-checked="${on}" tabindex="0">${on ? '●' : '○'}</div>`;
    };
    html += `
      <div class="sev-cell sev-row-label"><span class="em">${c.em}</span>${esc(c.label)}</div>
      ${cell('off',   'off')}
      ${cell('info',  'info')}
      ${cell('alarm', 'alarm')}
    `;
  }
  wrap.innerHTML = html;
  // Single delegated click handler per render (innerHTML wipes prior
  // listeners). Touch + mouse + pen all share the same path.
  wrap.addEventListener('click', (e) => {
    const cell = e.target.closest('.sev-radio');
    if (!cell) return;
    const cls = cell.dataset.cls;
    const val = cell.dataset.val;
    wrap.querySelectorAll(`.sev-radio[data-cls="${cls}"]`).forEach(r => {
      r.classList.remove('is-on', 'is-off-mode', 'is-info-mode', 'is-alarm-mode');
      r.setAttribute('aria-checked', 'false');
      r.textContent = '○';
    });
    cell.classList.add('is-on', 'is-' + val + '-mode');
    cell.setAttribute('aria-checked', 'true');
    cell.textContent = '●';
    _checkAlertingConflicts(form);
  });
}

// Read the matrix back into the dict shape settings.json expects.
// Drops unset rows silently (every row has exactly one is-on cell after
// render so the .is-on selector is the source of truth).
export function _collectClassSeverity(_form){
  const wrap = byId('alertSeverityMatrix');
  const out = {};
  if (!wrap) return out;
  wrap.querySelectorAll('.sev-radio.is-on').forEach(r => {
    out[r.dataset.cls] = r.dataset.val;
  });
  return out;
}

// Conflict-warning banner — flags Alerting-tab settings that wouldn't
// reach the user. Two checks:
//   1. Any class is set to alarm/info but BOTH channels (Telegram +
//      MQTT) are off → push has nowhere to go.
//   2. Any class is set to alarm/info but the master "Alerting aktiv"
//      switch (armed) is off → push is globally muted.
// Banner is purely informational — never blocks save.
export function _checkAlertingConflicts(form){
  const banner = byId('alertConflictBanner');
  const text   = byId('alertConflictText');
  if (!banner || !text) return;
  const cs = _collectClassSeverity(form);
  const anyAlarming = Object.values(cs).some(v => v === 'alarm' || v === 'info');
  const tg = !!form.querySelector('[name="telegram_enabled"]')?.checked;
  const mq = !!form.querySelector('[name="mqtt_enabled"]')?.checked;
  const armed = !!form.querySelector('[name="armed"]')?.checked;
  const messages = [];
  if (anyAlarming && !tg && !mq){
    messages.push("Klassen sind auf <strong>Alarm</strong> oder <strong>Info</strong> gesetzt, aber <strong>kein Kanal aktiv</strong> — es kommt nichts an. Aktiviere Telegram oder MQTT in Schritt 2.");
  }
  if (anyAlarming && !armed){
    messages.push("Der globale <strong>Stumm-Schalter</strong> in Schritt 5 ist aus — alle Pushes werden blockiert.");
  }
  if (messages.length){
    text.innerHTML = messages.join(' · ');
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

// Per-class notification-cooldown drilldown rendered into
// #alertCooldownGrid when "Cooldown pro Klasse anpassen ▾" is opened.
// Defaults match _NOTIFY_COOLDOWN_DEFAULTS in telegram_bot so the
// surfaced values reflect the actual runtime fallback.
const _ALERT_COOLDOWN_CLASSES = [
  { key: 'person',   label: 'Person',       def: 60  },
  { key: 'cat',      label: 'Katze',        def: 120 },
  { key: 'bird',     label: 'Vogel',        def: 300 },
  { key: 'squirrel', label: 'Eichhörnchen', def: 300 },
  { key: 'dog',      label: 'Hund',         def: 120 },
  { key: 'car',      label: 'Auto',         def: 30  },
  { key: 'motion',   label: 'Bewegung',     def: 30  },
];

function _fmtCooldownVal(s){
  const v = parseInt(s, 10);
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return 'aus';
  if (v < 60)  return v + ' s';
  return Math.round(v / 60) + ' min';
}

export function _renderAlertCooldownGrid(form, cam){
  const wrap = byId('alertCooldownGrid');
  if (!wrap) return;
  const cd = cam?.notification_cooldown || {};
  wrap.innerHTML = _ALERT_COOLDOWN_CLASSES.map(c => {
    const raw = cd[c.key];
    const v = (raw != null && Number.isFinite(parseInt(raw, 10))) ? parseInt(raw, 10) : c.def;
    return `
      <div class="erk-card">
        <div class="row">
          <input type="range" name="cooldown_${c.key}" min="0" max="600" step="15" value="${v}" />
          <span class="val" id="erkCD_${c.key}_val">${esc(_fmtCooldownVal(v))}</span>
        </div>
        <span class="lbl">${esc(c.label)} · min. Abstand zwischen zwei Pushes</span>
      </div>`;
  }).join('');
  _ALERT_COOLDOWN_CLASSES.forEach(c => {
    const inp = wrap.querySelector(`[name="cooldown_${c.key}"]`);
    const lbl = byId(`erkCD_${c.key}_val`);
    if (inp && lbl){
      inp.addEventListener('input', () => { lbl.textContent = _fmtCooldownVal(inp.value); });
    }
  });
}

export function _bindAlertCooldownToggle(){
  const btn = byId('alertCooldownToggle');
  const wrap = byId('alertCooldownGrid');
  const lbl = byId('alertCooldownToggleLbl');
  if (!btn || !wrap || !lbl || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', () => {
    const open = wrap.hidden;
    wrap.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    lbl.textContent = open ? 'Weniger anzeigen' : 'Cooldown pro Klasse anpassen';
  });
}

// Read every cooldown_<class> slider from the form into the dict
// shape settings.json expects. Empty grid (drilldown never opened)
// yields {}, which the runtime treats as "use _NOTIFY_COOLDOWN_DEFAULTS".
export function _collectAlertCooldown(form){
  const out = {};
  form.querySelectorAll('[name^="cooldown_"]').forEach(inp => {
    const key = inp.name.replace('cooldown_', '');
    const v = parseInt(inp.value, 10);
    if (key && Number.isFinite(v)) out[key] = v;
  });
  return out;
}

// Test-Push button on the Alerting tab — fires
// /api/cameras/<id>/test-alert, animates the play-icon while in
// flight, then renders a per-channel result panel below: ✓ Telegram
// angekommen / ✗ MQTT: Kanal aus. Idempotent wiring via dataset.wired.
export function _bindAlertTestButton(){
  const btn = byId('alertTestBtn');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.addEventListener('click', _onAlertTestClick);
}

const _ALERT_CHAN_LABELS = { telegram: 'Telegram', mqtt: 'MQTT' };

async function _onAlertTestClick(ev){
  const btn = ev.currentTarget;
  const camId = byId('cameraForm')?.elements?.['id']?.value;
  const result = byId('alertTestResult');
  if (!camId || !result) return;
  const lblEl = btn.querySelector('.alert-test-btn-lbl');
  const original = lblEl?.textContent || '';
  btn.disabled = true;
  btn.classList.add('is-busy');
  if (lblEl) lblEl.textContent = ' sende…';
  result.hidden = true;
  let data = null;
  try {
    const r = await fetch(`/api/cameras/${encodeURIComponent(camId)}/test-alert`, { method: 'POST' });
    try { data = await r.json(); } catch {}
  } catch {
    data = null;
  }
  btn.disabled = false;
  btn.classList.remove('is-busy');
  if (lblEl) lblEl.textContent = original;
  if (!data){
    result.className = 'alert-test-result is-err';
    result.innerHTML = `<strong>Fehler:</strong> Netzwerk · keine Antwort vom Server`;
    result.hidden = false;
    return;
  }
  const lines = [];
  for (const [chan, res] of Object.entries(data.channels || {})){
    const label = _ALERT_CHAN_LABELS[chan] || chan;
    if (res?.ok)  lines.push(`✓ ${label} angekommen`);
    else          lines.push(`✗ ${label}: ${res?.error || 'Fehler'}`);
  }
  result.className = 'alert-test-result ' + (data.ok ? 'is-ok' : 'is-err');
  const head = data.ok ? 'Erfolg' : 'Fehler';
  result.innerHTML = `<strong>${head}</strong><ul>${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`;
  result.hidden = false;
}

// Hydrate the Alerting-tab status strip from /api/system/telegram.
// Mutates the existing static markup rather than re-rendering so the
// dot's CSS animation isn't restarted on every poll. Three pieces:
//   - Dot variant: is-ok / is-cpu / is-off
//   - alertStatusBot: "verbunden" / "getrennt" / "deaktiviert"
//   - alertStatusLast: relative "vor X Min." since last push
// Errors during fetch leave the strip showing whatever it had — a
// transient flake shouldn't blank the UI.
export async function _renderAlertStatusStrip(){
  const host = byId('alertStatusStrip');
  if (!host) return;
  let data = null;
  try {
    const r = await fetch('/api/system/telegram');
    if (r.ok) data = await r.json();
  } catch {}
  const dot = byId('alertStatusDot');
  const txt = byId('alertStatusBot');
  const last = byId('alertStatusLast');
  if (!data){
    if (dot){ dot.classList.remove('is-ok', 'is-cpu', 'is-off'); dot.classList.add('is-off'); }
    if (txt) txt.textContent = '—';
    if (last) last.textContent = '—';
    return;
  }
  let variant, label;
  if (!data.enabled){
    variant = 'is-off'; label = 'deaktiviert';
  } else if (data.connected){
    variant = 'is-ok'; label = 'verbunden';
  } else {
    variant = 'is-cpu'; label = 'getrennt';
  }
  if (dot){
    dot.classList.remove('is-ok', 'is-cpu', 'is-off');
    dot.classList.add(variant);
  }
  if (txt) txt.textContent = label;
  if (last) last.textContent = _fmtRelativeAgeS(data.last_send_age_s);
}

// Wire the conflict banner to react to channel/master switches in the
// Alerting tab. Idempotent via dataset.wired so re-opening cam-edit
// doesn't double-bind. The matrix click handler in
// _renderSeverityMatrix already calls _checkAlertingConflicts on every
// cell click.
export function _bindAlertingConflictWatch(form){
  if (!form || form.dataset.alertingConflictWired) return;
  form.dataset.alertingConflictWired = '1';
  ['telegram_enabled', 'mqtt_enabled', 'armed', 'recording_enabled'].forEach(name => {
    const inp = form.querySelector(`[name="${name}"]`);
    if (inp) inp.addEventListener('change', () => _checkAlertingConflicts(form));
  });
}

// Legacy 4-valued alarm_profile select hint — kept for templates that
// still surface the old dropdown. The matrix above is the source of
// truth on save; this dropdown survives only for the rare flow where
// the user wants to bulk-set a profile and let the matrix fill in.
const _ALARM_PROFILE_HINTS = {
  hard:   'Telegram nur bei Person/Auto. Tiere & reine Bewegung werden ignoriert.',
  medium: 'Telegram bei Person/Auto (Alarm) und bei Tieren (Info-Meldung). Reine Bewegung still.',
  soft:   'Telegram bei jedem Event — Person, Tier oder reine Bewegung.',
  info:   'Telegram nur bei Tieren (Katze, Vogel, Fuchs …). Personen & Bewegung still.',
};
window._updateAlarmProfileHint = function(){
  const sel  = byId('camAlarmProfileSelect');
  const hint = byId('camAlarmProfileHint');
  if (!sel || !hint) return;
  hint.textContent = _ALARM_PROFILE_HINTS[sel.value] || '';
};

// live-update.js polls _renderAlertStatusStrip every 3 s through this
// bridge — kept as window.X so live-update can stay agnostic about the
// alerting module's layout. (Direct named import is also possible but
// the bridge means live-update doesn't need a re-edit when alerting
// itself changes shape.)
window._renderAlertStatusStrip = _renderAlertStatusStrip;
