const CACHE = 'gzg-v9';
const FILES = [
  './',
  './index.html',
  './admin.html',
  './game.html',
  './style.css',
  './script.js',
  './1.png',
];
const SKIP_PATHS = ['/api', '/ws'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // never intercept API or WebSocket traffic
  if (url.origin === location.origin && SKIP_PATHS.some(p => url.pathname.startsWith(p))) {
    return;
  }

  // always serve game.html for navigation when offline
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('./game.html'))
    );
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});