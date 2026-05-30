// ─── mediaview/canvas/index.js ─────────────────────────────────────────────
// Source-switch helper: mounts an <img>, <video>, or MJPEG element
// inside the canvas frame based on config.source.type. Bbox / trail /
// zone overlay layers paint on top via separate canvas elements that
// the shell wires (added in H/I).
//
// G brings the VIDEO path online — weather is the first real consumer
// and only needs a looping, muted, native-controls clip. The img /
// mjpeg branches are deliberately minimal here; H (recorded still
// frames) and I (live MJPEG + overlay layers) flesh them out.

/**
 * Mount the media element for ``source`` into ``host``.
 *
 * @param {HTMLElement} host
 * @param {Object} source  { type: 'video'|'mp4'|'image'|'mjpeg', url,
 *   loop?, controls?, alt? }
 * @returns {{ el: HTMLElement, teardown(): void } | null}
 */
export function mountCanvasSource(host, source = {}) {
  if (!host) return null;
  host.innerHTML = '';
  const type = source.type || 'video';
  let el;
  if (type === 'image' || type === 'mjpeg') {
    el = document.createElement('img');
    el.className = 'mv-canvas-media';
    el.alt = source.alt || '';
    if (source.url) el.src = source.url;
  } else {
    // video / mp4 — weather clips: muted + loop so iOS inline-plays
    // them without the programmatic-seek issues that force the native
    // fallback for motion clips. Native controls give the scrubber.
    el = document.createElement('video');
    el.className = 'mv-canvas-media';
    el.setAttribute('playsinline', '');
    el.muted = true;
    el.loop = source.loop !== false;
    el.controls = source.controls !== false;
    el.preload = 'metadata';
    if (source.url) {
      el.src = source.url;
      el.load();
      el.play().catch(() => {
        /* autoplay may be blocked — controls let the user start it */
      });
    }
  }
  host.appendChild(el);
  return {
    el,
    teardown: () => {
      try {
        if (el.tagName === 'VIDEO') {
          el.pause();
          el.removeAttribute('src');
          el.load();
        }
      } catch {
        /* ignore */
      }
      el.remove();
    },
  };
}
