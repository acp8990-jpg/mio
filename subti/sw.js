// Service worker: la app funciona sin conexión y recibe vídeos compartidos desde la galería.
const CACHE = 'subti-v6';
const ASSETS = [
  './', 'index.html', 'css/subti.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/main.js', 'js/captions.js', 'js/transcribe.js', 'js/worker.js', 'js/render.js', 'js/db.js', 'js/plan.js',
  'fonts/anton-latin-400-normal.woff2', 'fonts/archivo-black-latin-400-normal.woff2', 'fonts/bricolage-grotesque-latin-800-normal.woff2',
  'fonts/caveat-latin-700-normal.woff2', 'fonts/dm-sans-latin-600-normal.woff2', 'fonts/dm-sans-latin-800-normal.woff2',
  'fonts/manrope-latin-600-normal.woff2', 'fonts/manrope-latin-800-normal.woff2', 'fonts/space-grotesk-latin-700-normal.woff2',
  'fonts/jetbrains-mono-latin-700-normal.woff2',
  '../vendor/mediabunny.min.mjs', '../vendor/mediabunny-aac-encoder.min.mjs',
  'js/record.js', 'js/liverec.js', '../js/camera.js', '../js/grade.js', '../js/segment.js', '../js/voice.js', '../js/export.js',
  '../js/render.js', '../js/timeline.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('subti-v') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // «Compartir con Subti» desde la galería del móvil
  if (req.method === 'POST' && url.searchParams.has('share')) {
    e.respondWith((async () => {
      const form = await req.formData();
      const file = form.get('video');
      if (file) {
        const c = await caches.open('subti-share');
        await c.put('shared-video', new Response(file, { headers: { 'Content-Type': file.type, 'X-Name': encodeURIComponent(file.name) } }));
      }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }
  // Motor de IA (Transformers.js y ONNX Runtime) desde jsDelivr: versión fija, se guarda la primera vez.
  if (req.method === 'GET' && url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.open('subti-cdn').then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
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
