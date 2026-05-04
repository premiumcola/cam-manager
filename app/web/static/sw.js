// ─── tam-spy service worker ────────────────────────────────────────────
// App-shell strategy. Caches the HTML/CSS/icons that paint the chrome so
// a brief WLAN drop doesn't blank the screen, but never caches API,
// /media, or MJPEG streams — those are live data and a stale response
// would be worse than no response. Runtime requests fall through
// stale-while-revalidate so subsequent hits warm the cache automatically.

const CACHE_NAME = 'tam-spy-shell-v1';
const SHELL_ASSETS = [
  '/',
  '/static/app.css',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
  '/static/manifest.json',
];

self.addEventListener('install', (evt) => {
  evt.waitUntil(
    caches.open(CACHE_NAME).then((c) => c.addAll(SHELL_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (evt) => {
  evt.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
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
            caches.open(CACHE_NAME).then((c) => c.put(evt.request, copy));
          }
          return net;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    }),
  );
});
