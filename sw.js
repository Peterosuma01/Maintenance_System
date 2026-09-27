// Bump this version string whenever you change any app-shell file
// (index.html, styles.css, app.js, icons, logos) so old caches get replaced.
const CACHE_NAME = 'steelwool-mms-v1';

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './logo-mark.png',
  './logo-full.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never cache calls to the Apps Script API - live data must always
  // come from the network.
  if (url.hostname.includes('script.google.com')) {
    event.respondWith(fetch(event.request).catch(() => new Response(
      JSON.stringify({ success: false, message: 'Offline - could not reach the server.' }),
      { headers: { 'Content-Type': 'application/json' } }
    )));
    return;
  }

  // App shell: cache-first, falling back to network, so the UI itself
  // (not the data) still opens when offline or on a flaky connection.
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
