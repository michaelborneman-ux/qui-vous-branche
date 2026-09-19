/* Bump CACHE on every shell change, or clients keep the old files. */
const CACHE = 'qvb-v7';

const SHELL = [
  './',
  'index.html',
  'style.css?v=7',
  'i18n.js?v=7',
  'app.js?v=7',
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

  // Everything is network first, with the cache as the offline floor. Coverage
  // shards were cache first once: that let a client keep serving a previous
  // build's data forever with no way to notice, which is far worse than one
  // small request per shard.
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
