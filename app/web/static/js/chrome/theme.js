// ─── chrome/theme.js ───────────────────────────────────────────────
// Owns the Auto / Hell / Dunkel theme state.
//
// Pre-paint script in index.html already set `data-theme` on <html>
// before the stylesheet loaded — that handles FOUC. This module
// takes over after main.js boots:
//   - Subscribes to OS-level prefers-color-scheme changes when the
//     user's mode is "auto", and re-applies live.
//   - Exposes setTheme(mode) for the Allgemein settings UI.
//   - Persists the user's pick under `localStorage["tamspy.theme"]`
//     using "auto" | "light" | "dark".
//   - Fires a `tamspy:theme` CustomEvent on every resolved-theme
//     change. Other modules (chrome/brand-logo.js) subscribe to
//     swap their assets without re-rolling random state.
//
// Hard rule: the resolved theme on <html data-theme="..."> is
// always "light" or "dark" — never "auto". "auto" lives only in
// localStorage as the user's *intent*. The render layer reads the
// resolved value via getComputedStyle / data-theme as appropriate.

const STORAGE_KEY = 'tamspy.theme';
const VALID_MODES = ['auto', 'light', 'dark'];

function _getMode(){
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return VALID_MODES.includes(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

function _setStored(mode){
  try {
    if (mode === 'auto') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Quota-blocked storage is non-fatal — runtime mode is still
    // applied, it just won't survive reload.
  }
}

function _osPrefersDark(){
  return !!(window.matchMedia
            && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function _resolve(mode){
  if (mode === 'light' || mode === 'dark') return mode;
  return _osPrefersDark() ? 'dark' : 'light';
}

function _apply(mode){
  const resolved = _resolve(mode);
  const html = document.documentElement;
  if (html.getAttribute('data-theme') !== resolved) {
    html.setAttribute('data-theme', resolved);
  }
  // Always fire — listeners that care about the user's intent
  // (e.g. the Allgemein helper-text) read the stored mode separately.
  window.dispatchEvent(new CustomEvent('tamspy:theme', {
    detail: { mode, resolved },
  }));
}

// Public API. Bridged on window so the (inline-onclick) settings UI
// can reach it without an explicit import.
export function getThemeMode(){
  return _getMode();
}

export function getResolvedTheme(){
  return _resolve(_getMode());
}

export function setTheme(mode){
  if (!VALID_MODES.includes(mode)) return;
  _setStored(mode);
  _apply(mode);
}

window.tamspyTheme = { getMode: getThemeMode, getResolved: getResolvedTheme, set: setTheme };

// On boot: re-apply once so the event fires for any listeners that
// joined the page after the inline pre-paint script ran.
_apply(_getMode());

// OS theme change → re-apply only when the user is in auto mode.
const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
if (mq && typeof mq.addEventListener === 'function') {
  mq.addEventListener('change', () => {
    if (_getMode() === 'auto') _apply('auto');
  });
}
