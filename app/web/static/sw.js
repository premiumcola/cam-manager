// ─── tam-spy service worker ────────────────────────────────────────────
// App-shell strategy. Caches the HTML/CSS/icons that paint the chrome so
// a brief WLAN drop doesn't blank the screen, but never caches API,
// /media, or MJPEG streams — those are live data and a stale response
// would be worse than no response. Runtime requests fall through
// stale-while-revalidate so subsequent hits warm the cache automatically.
//
// Cache versioning: the install handler fetches /version.json (served
// by the bootstrap blueprint), pulls out the current shell hash, and
// uses it as the cache suffix. When a CSS partial changes the hash
// flips, the install handler creates a fresh cache, and the activate
// handler deletes the old one. iOS-home-screen PWAs pick up the new
// shell on next cold open — no need to re-add the app.

const CACHE_PREFIX = 'tam-spy-shell-';
const SHELL_ASSETS = [
  '/',
  '/static/app.css',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
  '/static/manifest.json',
];

let _activeCache = CACHE_PREFIX + 'init';

async function _resolveCacheName(){
  try {
    const r = await fetch('/version.json', { cache: 'no-store' });
    if (r.ok){
      const data = await r.json();
      if (data && data.shell_hash) return CACHE_PREFIX + data.shell_hash;
    }
  } catch { /* offline → keep the init name */ }
  return _activeCache;
}

self.addEventListener('install', (evt) => {
  evt.waitUntil((async () => {
    _activeCache = await _resolveCacheName();
    const c = await caches.open(_activeCache);
    await c.addAll(SHELL_ASSETS);
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (evt) => {
  evt.waitUntil((async () => {
    if (_activeCache === CACHE_PREFIX + 'init'){
      _activeCache = await _resolveCacheName();
    }
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith(CACHE_PREFIX) && k !== _activeCache)
        .map((k) => caches.delete(k)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (evt) => {
  const url = new URL(evt.request.url);

  // Live data — never cache. The browser handles offline failure on the
  // app side (toast + per-widget error states); a stale cached response
  // would lie about the camera state.
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/media/')) return;
  if (url.pathname.includes('.mjpg')) return;
  if (url.pathname.includes('snapshot.jpg')) return;
  if (url.pathname === '/sw.js') return;

  // Stale-while-revalidate for everything else (HTML / CSS / JS / icons).
  evt.respondWith(
    caches.match(evt.request).then((cached) => {
      const fetchPromise = fetch(evt.request)
        .then((net) => {
          if (net && net.ok) {
            const copy = net.clone();
            caches.open(_activeCache).then((c) => c.put(evt.request, copy));
          }
          return net;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    }),
  );
});
