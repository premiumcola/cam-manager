// ─── dashboard/snapshot-poll.js ────────────────────────────────────────────
// N15 · snapshot-polling helpers carved out of dashboard.js. Three
// units, all related to keeping the camera-tile snapshots fresh:
//
//   1. Dead-camera-id suppression — after a rename the old <img>
//      tags 404 in the preview-refresh loop until the next
//      renderDashboard replaces them. _failedSnapshotIds tracks
//      consecutive 404s so the loop stops bumping ids that aren't
//      ever going to respond.
//
//   2. _camImgRetry — onerror handler that does an exponential-
//      backoff retry on a 503 (most often during initial-boot
//      stream warm-up). Both 404 dead-id + 503 retry paths land
//      here.
//
//   3. _cvImgLoaded — once a snapshot decodes successfully, fade in
//      the image, hide the placeholder, and pin the parent .cv-frame's
//      aspect ratio to the camera's actual sensor ratio.
//
// All exports are re-exported from dashboard.js so existing imports
// keep working.

// `_failedSnapshotIds` is module-scoped so loadAll() in
// live-update.js can reach it via the import below (via
// dashboard.js' re-export) — fresh ids on every renderDashboard
// post-rename invalidate the map.
export const _failedSnapshotIds = new Map();

export function _resetFailedSnapshotIds(){ _failedSnapshotIds.clear(); }

export function _isSnapshotIdDead(camId){
  return camId ? (_failedSnapshotIds.get(camId) || 0) >= 2 : false;
}

export function _camIdFromImg(img){
  return img?.closest?.('[data-camid]')?.dataset?.camid || null;
}

export function _camImgRetry(img){
  const camId = _camIdFromImg(img);
  // Two consecutive failures is the threshold for marking the id dead —
  // catches a real rename (the new img element will carry the fresh id)
  // while tolerating one transient 503 during cam restart.
  if (camId) {
    const n = (_failedSnapshotIds.get(camId) || 0) + 1;
    _failedSnapshotIds.set(camId, n);
    if (n >= 2) {
      img.style.display = 'none';
      return;
    }
  }
  const retries = parseInt(img.dataset.snapRetry || '0');
  if (retries >= 12) { img.style.display = 'none'; return; }
  img.dataset.snapRetry = retries + 1;
  // Exponential backoff: 500ms, 1s, 1.5s … capped at 3s
  const delay = Math.min(500 * (retries + 1), 3000);
  setTimeout(() => {
    if (!img.isConnected) return; // card removed from DOM
    const base = img.src.split('?')[0];
    img.src = base + '?t=' + Date.now();
  }, delay);
}

// Snapshot loaded — fade in, hide the placeholder, and apply the
// stream's actual aspect ratio to the parent .cv-frame so the
// container matches the camera (4:3, 16:9, 16:10 …) instead of
// being locked to a single 16:9 default. Combined with the
// `object-fit:contain` rule on .cv-img this means the full sensor
// frame is always visible — no cropping, no squashing.
export function _cvImgLoaded(img){
  img.classList.add('loaded');
  const placeholder = img.previousElementSibling;
  if (placeholder) placeholder.style.display = 'none';
  const w = img.naturalWidth, h = img.naturalHeight;
  if (w > 0 && h > 0) {
    const frame = img.closest('.cv-frame');
    if (frame) frame.style.setProperty('--cv-aspect', `${w} / ${h}`);
  }
}
