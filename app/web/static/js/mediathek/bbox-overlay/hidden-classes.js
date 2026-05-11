// ─── mediathek/bbox-overlay/hidden-classes.js ──────────────────────────────
// Per-class hidden-set persistence. localStorage keyed per camera.
// JSON-encoded array of label strings. Reads parse into a Set for O(1)
// membership lookup; writes serialise back to an array (additive —
// only the per-cam key is touched, the rest of localStorage is
// untouched).

function _hiddenStorageKey(camId){
  return `tamspy.lb.bboxClasses.hidden.${camId || ''}`;
}

export function _getHiddenClassesForCam(camId){
  if (!camId) return new Set();
  try {
    const raw = localStorage.getItem(_hiddenStorageKey(camId));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}

export function _setHiddenClassesForCam(camId, hiddenSet){
  if (!camId) return;
  try {
    const arr = [...hiddenSet];
    if (arr.length === 0) localStorage.removeItem(_hiddenStorageKey(camId));
    else localStorage.setItem(_hiddenStorageKey(camId), JSON.stringify(arr));
  } catch { /* quota / private mode — fall through silently */ }
}
