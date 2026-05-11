// ─── chrome/password-toggle.js ─────────────────────────────────────────────
// Stage 10 of the legacy.js → ES modules refactor — single source of
// truth for the eye-glyph variants and the password-field reveal
// helpers used across the cam-edit form, the Telegram tab, and the
// global Settings panel. Inline onclicks (togglePwField,
// togglePwFieldById) keep their window bridges; camedit/rtsp.js
// imports _setEyeState directly.
import { byId } from '../core/dom.js';

// SVG (not emoji) so size + centring stay pixel-stable across browsers.
export const EYE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
export const EYE_OFF_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.66 18.66 0 0 1 4.16-4.93"/><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a18.66 18.66 0 0 1-1.66 2.66"/><path d="M14.12 14.12a3 3 0 0 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

export function _setEyeState(btn, revealed){
  if (!btn) return;
  btn.innerHTML = revealed ? EYE_OFF_SVG : EYE_SVG;
  btn.classList.toggle('revealed', revealed);
  btn.setAttribute('aria-label', revealed ? 'Passwort verbergen' : 'Passwort anzeigen');
}

// Inline onclick="togglePwField(this, 'fieldName')" — toggles the
// password input nearest to the eye button via form-element lookup.
window.togglePwField = function(btn, fieldName){
  const f = btn.closest('form');
  const input = f?.elements[fieldName];
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
  _setEyeState(btn, input.type === 'text');
};

window.togglePwFieldById = function(id){
  const input = byId(id);
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
  const btn = input.parentElement?.querySelector('.pw-eye');
  _setEyeState(btn, input.type === 'text');
};

// Window bridge was kept while rtsp.js used the global lookup; now
// rtsp.js imports _setEyeState directly via ES modules so the bridge
// is no longer reached from any callsite — dropped at stage 32.
