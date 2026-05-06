/**
 * Minimal service worker — provides offline cache so the PWA shell loads
 * without network. Bumping CACHE_VERSION forces a refresh of cached files
 * after a deploy.
 */
const CACHE_VERSION = 'trimix-pwa-v2';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './transport-ble.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then((c) => c.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req))
  );
});
