// ─── PWA service-worker registration ───────────────────────────────────
// Best-effort registration of /sw.js. Skipped on file:// (offline file
// previews) and when the SW API isn't available. A new SW activating
// triggers a soft reload after a short grace period so any in-flight
// UI work has time to settle.

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .catch((err) => {
        // SW registration failures are non-fatal; the app keeps working
        // without the shell cache. console.warn is allowed by the
        // project lint config.
        console.warn('[pwa] SW registration failed:', err);
      });
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    setTimeout(() => location.reload(), 800);
  });
}
