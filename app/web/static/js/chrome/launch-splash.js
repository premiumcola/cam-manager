// ─── chrome/launch-splash.js ───────────────────────────────────────────
// Zoom-out reveal on the very first paint of a session: a giant copy
// of the brand logo sits centred on the page-bg colour, then scales
// down + fades to the position of the hero header logo (#heroBrandLogo)
// while the rest of the UI fades in behind it. After the transition
// the splash overlay is removed and the in-place hero logo carries
// the visual continuity.
//
// Why this lives in chrome/ and not in main.js:
//   - Keeps the boot file slim — main.js stays a thin import shell.
//   - Self-contained: respects sessionStorage so the animation only
//     runs ONCE per visit (not on every soft-nav inside the SPA).
//   - Honours prefers-reduced-motion automatically.
//
// Implementation notes:
//   - Uses Web Animations API (element.animate) — no library, no
//     keyframe @-rules to inject; the lifecycle is bound to the
//     overlay element so a repaint can't strand a half-transitioned
//     state.
//   - The overlay's background colour mirrors the manifest's
//     `background_color` (#111111) so iOS's native splash → web app
//     transition is a single visual continuum.

const SESSION_FLAG = 'tamspy.launchSplashShown';

function _shouldRun(){
  // Soft-nav suppression: once per session.
  try {
    if (sessionStorage.getItem(SESSION_FLAG) === '1') return false;
  } catch {
    // sessionStorage blocked (private mode, restrictive UA) — fall
    // through and let the animation play; one extra play is harmless.
  }
  // Honour user accessibility preference.
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
    return false;
  }
  // The hero logo must exist as the landing target — without it there
  // is nothing to morph into. (Hero loads from a Jinja partial that
  // ships with index.html, so the only real failure mode is a
  // missed-include during a partial refactor.)
  if (!document.getElementById('heroBrandLogo')) return false;
  return true;
}

function _markShown(){
  try { sessionStorage.setItem(SESSION_FLAG, '1'); } catch {}
}

function _runSplash(){
  if (!_shouldRun()) return;
  // Mark up-front so a fast double-load (e.g. nav-back) doesn't
  // re-trigger half-way through the animation.
  _markShown();

  // Build the overlay. position:fixed inset:0 covers the entire
  // visible viewport including the area under the floating dock.
  // The logo starts large (256 px ≈ a quarter of an iPhone Pro Max
  // diagonal — readable but not so big the edges crop), then shrinks
  // to the hero target on transition end.
  const overlay = document.createElement('div');
  overlay.id = 'launchSplash';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:9999',
    // Use the theme token so the splash bg matches the user's
    // resolved mode (light cream vs dark) instead of always-dark.
    'background:var(--bg)',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'pointer-events:none',
    // dvh prevents the iOS address-bar collapse from stretching the
    // overlay mid-animation.
    'height:100dvh',
  ].join(';');

  const img = document.createElement('img');
  img.src = '/static/icons/icon-512.png';
  img.alt = '';
  img.width = 256;
  img.height = 256;
  img.style.cssText = [
    'width:256px',
    'height:256px',
    'border-radius:48px',
    // Drop shadow — same vocabulary as the dock so the splash logo
    // and the eventual hero-logo feel from the same family.
    'box-shadow:0 24px 60px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.04) inset',
    'will-change:transform,opacity',
  ].join(';');

  overlay.appendChild(img);

  // The rest of the UI sits under .shell — fade it in alongside the
  // logo's shrink so the reveal feels like one continuous motion
  // instead of "splash off, UI on".
  const shell = document.querySelector('.shell');
  let prevShellOpacity = '';
  let prevShellTransition = '';
  if (shell) {
    prevShellOpacity = shell.style.opacity;
    prevShellTransition = shell.style.transition;
    shell.style.opacity = '0';
    shell.style.transition = 'opacity 600ms ease-out 100ms';
  }

  document.body.appendChild(overlay);

  // Compute the morph target — the hero logo's bounding rect on the
  // current viewport. We measure in the same frame the overlay
  // mounts so layout is settled.
  requestAnimationFrame(() => {
    const target = document.getElementById('heroBrandLogo');
    const targetRect = target?.getBoundingClientRect();
    const startRect = img.getBoundingClientRect();

    // Trigger UI fade-in.
    if (shell) shell.style.opacity = '1';

    if (!targetRect || targetRect.width === 0) {
      // Hero not laid out yet — fall back to a simple shrink-and-fade
      // that doesn't need a target.
      img.animate(
        [{ transform: 'scale(1)', opacity: 1 },
         { transform: 'scale(0.4)', opacity: 0 }],
        { duration: 700, easing: 'cubic-bezier(.25,.1,.25,1)', fill: 'forwards' }
      ).onfinish = _cleanup;
      return;
    }

    // Compute translate + scale that lands the splash logo exactly
    // on top of the hero logo.
    const dx = (targetRect.left + targetRect.width / 2) - (startRect.left + startRect.width / 2);
    const dy = (targetRect.top + targetRect.height / 2) - (startRect.top + startRect.height / 2);
    const scale = targetRect.width / startRect.width;

    // Hide the hero logo while the splash is mid-flight so we don't
    // see two logos at once near the end of the animation.
    target.style.opacity = '0';

    const anim = img.animate([
      { transform: 'translate(0,0) scale(1)', opacity: 1, borderRadius: '48px' },
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
        opacity: 1,
        borderRadius: '8px' },
    ], {
      duration: 750,
      easing: 'cubic-bezier(.25,.1,.25,1)',
      fill: 'forwards',
    });

    anim.onfinish = () => {
      // Hand off to the in-place hero logo and tidy up.
      target.style.opacity = '';
      _cleanup();
    };
    anim.oncancel = () => {
      target.style.opacity = '';
      _cleanup();
    };
  });

  function _cleanup(){
    overlay.remove();
    if (shell) {
      // Don't leave our inline transition rule lying around.
      shell.style.transition = prevShellTransition;
      shell.style.opacity = prevShellOpacity;
    }
  }
}

// Run on import. main.js loads this before the rest of the chrome,
// so the overlay paints before live-view / dashboard / camedit start
// hydrating. The animation is purely visual — no API calls, no race
// with the data-fetching pipeline.
_runSplash();
