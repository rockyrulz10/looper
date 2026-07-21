// Bump this to the APP_VERSION in app.js on every release (semver:
// patch = fixes, minor = features, major = reworks). A changed cache name
// is what makes the service worker discard the old assets on activate.
const CACHE_NAME = 'looper-v1.0.0';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './storage.js',
  './recorder-worklet.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// NETWORK-FIRST: always serve fresh code when the dev server is reachable,
// and only fall back to the cache when offline. (The previous cache-first
// strategy meant an installed PWA could stay pinned to an old version
// forever if it was ever opened while the server was down.)
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        if (resp && resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});
