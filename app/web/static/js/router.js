// ─── router.js ─────────────────────────────────────────────────────────────
// Stage 18 of the legacy.js → ES modules refactor — Telegram deep-link
// router. URLs from Telegram bubbles look like
//   <public_base_url>/#/event/<event_id>
//   <public_base_url>/#/sighting/<sighting_id>
//   <public_base_url>/#/recap/<recap_id>
// On match, switch to the right section, ensure the relevant data is
// loaded, then open the corresponding lightbox at that item. After
// opening we rewrite the hash to a non-routable anchor (#media /
// #weather) so a page reload doesn't replay the animation.
import { state } from './core/state.js';
import { j } from './core/api.js';

function _showRouterToast(msg){
  let el = document.getElementById('_routerToast');
  if (!el){
    el = document.createElement('div');
    el.id = '_routerToast';
    el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:1500;background:rgba(15,24,37,.96);color:#e2e8f0;padding:10px 16px;border-radius:12px;font-size:13px;font-weight:600;box-shadow:0 10px 30px rgba(0,0,0,.45);opacity:0;transition:opacity .2s ease;pointer-events:none;max-width:88vw;text-align:center';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 3500);
}

async function _openLightboxByEventId(eventId){
  // Try in-memory first — fast path when the user is already on Mediathek.
  const all = state._allMedia || [];
  let item = all.find(x => x.event_id === eventId);
  if (item){
    if (typeof window.openLightbox === 'function') window.openLightbox(item);
    return true;
  }
  // Resolve cam + event metadata via the cross-camera API.
  let meta = null;
  try { meta = await j(`/api/event/${encodeURIComponent(eventId)}`); } catch {}
  if (!meta || !meta.camera_id){
    _showRouterToast('Ereignis nicht gefunden — vielleicht wurde es gelöscht?');
    return false;
  }
  // Switch to the cam's media drilldown, load the events for that cam,
  // then re-search _allMedia and open.
  state.mediaCamera = meta.camera_id;
  if (meta.top_label) state.mediaLabels = new Set([meta.top_label]);
  document.querySelector('#media')?.scrollIntoView({ behavior: 'auto', block: 'start' });
  try {
    if (typeof window.loadMedia === 'function')        await window.loadMedia();
    if (typeof window.renderMediaGrid === 'function')  window.renderMediaGrid();
    if (typeof window.renderMediaPagination === 'function') window.renderMediaPagination();
  } catch {}
  item = (state._allMedia || []).find(x => x.event_id === eventId);
  if (item){
    if (typeof window.openLightbox === 'function') window.openLightbox(item);
    return true;
  }
  _showRouterToast('Ereignis nicht gefunden — vielleicht wurde es gelöscht?');
  return false;
}

async function _openSightingById(sightingId){
  // Make sure the weather section is loaded.
  if (!state.weather || !state.weather.items || state.weather.items.length === 0){
    try {
      if (typeof window.loadWeatherSightings === 'function') await window.loadWeatherSightings();
    } catch {}
  }
  const items = state.weather?.items || [];
  const idx = items.findIndex(s => s.id === sightingId);
  document.querySelector('#weather')?.scrollIntoView({ behavior: 'auto', block: 'start' });
  if (idx >= 0 && typeof window.openWeatherLightbox === 'function'){
    window.openWeatherLightbox(idx);
    return true;
  }
  _showRouterToast('Sichtung nicht gefunden.');
  return false;
}

async function _openRecapById(recapId){
  // Recaps live alongside sightings — load + open via the existing hook.
  if (!state.weather?.recaps || state.weather.recaps.length === 0){
    try {
      if (typeof window.loadWeatherRecaps === 'function') await window.loadWeatherRecaps();
    } catch {}
  }
  const items = state.weather?.recaps || [];
  const idx = items.findIndex(r => r.id === recapId);
  document.querySelector('#weather')?.scrollIntoView({ behavior: 'auto', block: 'start' });
  if (idx >= 0 && typeof window.openWeatherRecap === 'function'){
    window.openWeatherRecap(items[idx], idx);
    return true;
  }
  // Fallback — best effort: scroll to the recaps strip.
  document.querySelector('#weatherRecapsStrip')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return false;
}

async function _routeFromHash(){
  const h = location.hash || '';
  let m;
  if ((m = h.match(/^#\/event\/([^/]+)$/))){
    const eid = decodeURIComponent(m[1]);
    const ok = await _openLightboxByEventId(eid);
    if (ok){ try { history.replaceState(null, '', '#media'); } catch {} }
  } else if ((m = h.match(/^#\/sighting\/([^/]+)$/))){
    const sid = decodeURIComponent(m[1]);
    const ok = await _openSightingById(sid);
    if (ok){ try { history.replaceState(null, '', '#weather'); } catch {} }
  } else if ((m = h.match(/^#\/recap\/([^/]+)$/))){
    const rid = decodeURIComponent(m[1]);
    const ok = await _openRecapById(rid);
    if (ok){ try { history.replaceState(null, '', '#weather'); } catch {} }
  }
}

window.addEventListener('hashchange', _routeFromHash);
window.addEventListener('load', () => { setTimeout(_routeFromHash, 1500); });
