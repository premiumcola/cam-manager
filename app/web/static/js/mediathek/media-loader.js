// ─── mediathek/media-loader.js ─────────────────────────────────────────────
// R09.1 — extracted from orchestration.js. The async fetch wrapper that
// hits /api/camera/<id>/media for every active camera, normalises the
// response, sorts globally newest-first, slices for the current page,
// and updates state.media + state._allMedia. No DOM mutation directly;
// it does call syncMediaPills when stale labels need clearing, which
// re-renders the pill bar.
import { state } from '../core/state.js';
import { j } from '../core/api.js';
import { calcItemsPerPage } from './orchestration.js';
import { syncMediaPills } from './filters.js';

// ── loadMedia ───────────────────────────────────────────────────────────────
export async function loadMedia(){
  const labels = state.mediaLabels;
  const ps = calcItemsPerPage(); window._cachedPageSize = ps;
  const cams = state.mediaCamera ? [state.mediaCamera] : state.cameras.map(c => c.id);
  // Unified filter — EventStore now holds both motion and timelapse events.
  const allLabels = [...labels];
  const labelParam = allLabels.length === 1 ? `&label=${encodeURIComponent(allLabels[0])}`
    : allLabels.length > 1 ? `&labels=${encodeURIComponent(allLabels.join(','))}` : '';
  // Fetch ALL matching items from every camera in one pass (no server-side offset).
  // Pagination is done client-side on the merged+sorted list so that multi-camera
  // views produce a consistent global order and every page is fully filled.
  // Per-cam try/catch so one cam 5xx-ing (or being temporarily offline) does
  // NOT blank the whole grid. Symptom we're killing: "Lade Medien…" stuck on
  // first open because a single fetch threw and renderMediaGrid never ran.
  const allItems = [];
  for (const camId of cams){
    try {
      const data = await j(`/api/camera/${camId}/media?limit=9999&offset=0${labelParam}`);
      const items = data.items || [];
      for (const item of items) allItems.push({ ...item, camera_id: camId });
    } catch (err){
      console.warn(`[mediathek] failed to load media for cam ${camId}:`, err);
    }
  }
  allItems.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
  state._allMedia = allItems;
  // If the active label filter has no matching items (period change etc.),
  // drop it and reload once with the cleaned filter.
  const availNow = new Set(allItems.flatMap(item => item.labels || []));
  const toClear = [...state.mediaLabels].filter(l => l !== 'timelapse' && !availNow.has(l));
  if (toClear.length){
    toClear.forEach(l => state.mediaLabels.delete(l));
    syncMediaPills();
    return loadMedia();
  }
  state.mediaTotalPages = Math.max(1, Math.ceil(allItems.length / ps));
  state.mediaPage = Math.min(state.mediaPage || 0, state.mediaTotalPages - 1);
  const offset = (state.mediaPage || 0) * ps;
  state.media = allItems.slice(offset, offset + ps);
  state.mediaHasMore = false;
}
