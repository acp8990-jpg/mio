// Service worker: guarda la app para que funcione sin conexión.
const CACHE = 'teleclip-v8';
const ASSETS = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/storage.js',
  'js/export.js',
  'js/camera.js',
  'js/grade.js',
  'js/voice.js',
  'js/segment.js',
  'js/segment-worker.js',
  'js/timeline.js',
  'js/render.js',
  'js/player.js',
  'js/editor.js',
  'vendor/mediabunny.min.mjs',
  'vendor/mediabunny-aac-encoder.min.mjs',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Respuesta inmediata desde la caché y actualización en segundo plano.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
