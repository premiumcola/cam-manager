// ─── chrome/theme-picker.js ────────────────────────────────────────
// Wires the Allgemein → Erscheinungsbild pills (Auto / Hell / Dunkel)
// to the central theme module (chrome/theme.js). Lives in chrome/
// because this is page-chrome wiring, not a domain module.
//
// Behaviour:
//   - On boot: read current mode from the theme module and reflect
//     it on the pills. The settings partial ships server-side so the
//     pills always exist by the time this module loads.
//   - On click: setTheme(mode) — instant apply + persist.
//   - Helper text:
//       * Auto  → "Folgt dem System (aktuell: Hell|Dunkel)"
//       * Hell  → "Manuell gesetzt"
//       * Dunkel→ "Manuell gesetzt"
//     Re-renders on every `tamspy:theme` event so when Auto resolves
//     across an OS theme switch the parenthetical updates live.

import { getThemeMode, setTheme } from './theme.js';

const MODE_LABEL_DE = { auto: 'Auto', light: 'Hell', dark: 'Dunkel' };

function _renderState(){
  const picker = document.getElementById('themePicker');
  if (!picker) return;
  const mode = getThemeMode();
  picker.querySelectorAll('.theme-pill').forEach(p => {
    const active = p.dataset.themeMode === mode;
    p.classList.toggle('is-active', active);
    p.setAttribute('aria-checked', active ? 'true' : 'false');
  });
  const hint = document.getElementById('themePickerHint');
  if (hint) {
    if (mode === 'auto') {
      const resolved = document.documentElement.getAttribute('data-theme') === 'light'
        ? 'Hell' : 'Dunkel';
      hint.textContent = `Folgt dem System (aktuell: ${resolved})`;
    } else {
      hint.textContent = 'Manuell gesetzt';
    }
  }
}

function _bindPills(){
  const picker = document.getElementById('themePicker');
  if (!picker) return;
  picker.querySelectorAll('.theme-pill').forEach(p => {
    p.addEventListener('click', () => {
      const mode = p.dataset.themeMode;
      if (!mode || mode === getThemeMode()) return;
      setTheme(mode);
      _renderState();
    });
  });
}

_bindPills();
_renderState();

// Stay in sync when the OS toggles (Auto users) or some other
// surface flips the theme. The theme module fires this event whenever
// the resolved theme actually changes; cheap to re-render.
window.addEventListener('tamspy:theme', _renderState);
