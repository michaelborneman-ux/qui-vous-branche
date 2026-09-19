/* Bump CACHE on every shell change, or clients keep the old files. */
const CACHE = 'qvb-v3';

const SHELL = [
  './',
  'index.html',
  'style.css?v=3',
  'i18n.js?v=3',
  'app.js?v=3',
  'manifest.webmanifest',
  'icons/icon.svg',
  'data/meta.json',
  'data/providers.json',
  'data/plans.json',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;   // geocoding stays online-only

  // Coverage shards never change between data refreshes: serve from cache, then fill.
  if (url.pathname.includes('/data/hex/')) {
    event.respondWith(
      caches.match(request).then(hit => hit || fetch(request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(request, copy));
        }
        return res;
      }))
    );
    return;
  }

  // Shell: network first so a deploy lands immediately, cache as the offline floor.
  event.respondWith(
    fetch(request)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request).then(hit => hit || caches.match('index.html')))
  );
});
