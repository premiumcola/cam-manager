// ─── chrome/tab-strip.js ───────────────────────────────────────────────
// Toggles `.is-end` on every inline horizontal tab strip whenever the
// user has scrolled it all the way to the right. The CSS in
// 25-mobile.css applies a right-edge mask-image fade by default; when
// the class lands the mask drops, so the last tab isn't cosmetically
// faded when fully visible.
//
// Why MutationObserver:
//   Some strips are server-rendered in the partials (settings.html);
//   others are populated lazily by the JS settings panes (weather
//   sub-tabs render after loadWeatherSettings). A one-shot
//   querySelectorAll at boot would miss the lazy ones, so the
//   observer adopts strips as they appear.

const SELECTOR = '.set-tabs, .coral-tabs, .erk-sim-tabs, .cam-recovery-tabs, .media-filter-bar, .cam-tab-bar, .ws-filter-bar';
const _adopted = new WeakSet();

function _updateEndState(strip){
  // 1 px tolerance because Safari sometimes reports a 0.5 px delta
  // even when scrolled to the literal end. The class is also present
  // when the strip doesn't overflow at all — the mask becomes a
  // no-op visually in that case anyway.
  const max = strip.scrollWidth - strip.clientWidth;
  const atEnd = max <= 1 || strip.scrollLeft >= max - 1;
  strip.classList.toggle('is-end', atEnd);
}

function _adopt(strip){
  if (_adopted.has(strip)) return;
  _adopted.add(strip);
  _updateEndState(strip);
  strip.addEventListener('scroll', () => _updateEndState(strip), { passive: true });
}

function _scan(root){
  const strips = (root || document).querySelectorAll(SELECTOR);
  strips.forEach(_adopt);
}

// Initial sweep + observe future inserts. The observer is a single
// page-level instance; cheap because the callback only fires on
// subtree mutations, and inside it we only touch elements that match
// our selector.
_scan(document);
new MutationObserver((muts) => {
  for (const m of muts){
    for (const node of m.addedNodes){
      if (!(node instanceof Element)) continue;
      if (node.matches?.(SELECTOR)) _adopt(node);
      _scan(node);
    }
  }
}).observe(document.body, { childList: true, subtree: true });

// Window resize can change overflow status (a strip that fit in
// landscape may now overflow in portrait). Re-evaluate every adopted
// strip on resize without re-adopting them.
window.addEventListener('resize', () => {
  document.querySelectorAll(SELECTOR).forEach(_updateEndState);
}, { passive: true });
