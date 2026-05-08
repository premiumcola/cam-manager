// ─── camedit/erk-sim/index.js ──────────────────────────────────────────────
// Public API for the Erkennung simulation sheet. Owns the tabbed
// wrapper around #erkSimResult (Snapshot ↔ Video), wires the
// "Erkennung jetzt simulieren" button to the snapshot endpoint, and
// dispatches the `erk-sim-tab:video` CustomEvent so video.js can
// lazy-render its picker. Cross-module dependency goes one way:
//   index.js → snapshot.js + video.js
//   snapshot.js, video.js → ../../core/* only
import { byId } from '../../core/dom.js';
import { _onErkSimulateClick } from './snapshot.js';
// Side-effect import: video.js registers a document-level listener for
// the 'erk-sim-tab:video' event at module load. Importing it here from
// the public entry point guarantees the listener is in place before
// the first tab switch fires the event.
import './video.js';


// "Erkennung jetzt simulieren" — the button below the 5 steps in the
// Erkennung tab. Posts to /api/cameras/<id>/test-detection, animates
// the icon while the request is in flight, then renders the snapshot
// + bounding boxes inline. Click again to re-run; click × to dismiss.
export function bindErkSimulate(){
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
  // "leeren" button on the decision-trace log block — clears the
  // text but keeps the block visible so the next simulate writes
  // into an empty pre. Click outside the log doesn't reset it;
  // closing the whole sheet (× button) re-hides everything.
  const logClear = byId('erkSimLogClear');
  if (logClear && !logClear.dataset.wired){
    logClear.dataset.wired = '1';
    logClear.addEventListener('click', () => {
      const body = byId('erkSimLogBody');
      if (body) body.textContent = '';
    });
  }
  bindErkSimTabs();
}


// Tab strip wiring for the simulation sheet (Snapshot / Video). Click
// + arrow-key navigation, ARIA states stay in sync. Idempotent — re-run
// whenever a camera is opened in the editor; the dataset.wired guard
// keeps it cheap.
export function bindErkSimTabs(){
  const strip = document.querySelector('#erkSimResult .erk-sim-tabs');
  if (!strip || strip.dataset.wired) return;
  strip.dataset.wired = '1';
  const tabs = Array.from(strip.querySelectorAll('[role="tab"]'));
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => activateErkSimTab(tab.id.replace('erkSimTabBtn-', '')));
    tab.addEventListener('keydown', (e) => {
      const idx = tabs.indexOf(tab);
      let next = -1;
      if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabs.length - 1;
      if (next < 0) return;
      e.preventDefault();
      tabs[next].focus();
      activateErkSimTab(tabs[next].id.replace('erkSimTabBtn-', ''));
    });
  });
}


// Switch the visible tab. `name` is one of 'snapshot' | 'video'. Caller
// is responsible for ensuring the simulation sheet itself is visible
// (the simulate button does that on a successful response).
export function activateErkSimTab(name){
  const strip = document.querySelector('#erkSimResult .erk-sim-tabs');
  if (!strip) return;
  strip.querySelectorAll('[role="tab"]').forEach(t => {
    const active = t.id === `erkSimTabBtn-${name}`;
    t.classList.toggle('is-active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
    t.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('#erkSimResult .erk-sim-tab-panel').forEach(p => {
    p.hidden = (p.id !== `erkSimTab-${name}`);
  });
  // Notify any listener (e.g. erk-sim/video.js) that the video tab just
  // became visible so it can lazy-render its picker.
  if (name === 'video'){
    document.dispatchEvent(new CustomEvent('erk-sim-tab:video'));
  }
}
