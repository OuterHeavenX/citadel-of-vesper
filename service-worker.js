/**
 * Service worker — PWA app shell (spec §43).
 *
 * Caches the critical game shell (HTML, JS, CSS, icons) so the installed
 * version launches like a standalone game.
 *
 * NEVER caches save data: saves live in IndexedDB, which service workers
 * do not touch. No save-reading or save-writing code belongs here.
 */
const CACHE = 'vesper-shell-v0.1.0';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './favicon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached ?? fetch(event.request))
  );
});
