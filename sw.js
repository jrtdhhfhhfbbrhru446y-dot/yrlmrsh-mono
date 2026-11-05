// Build-time template. No user data, no remote resources, no automatic forced update.
const PREFIX = 'mono-task-shell-';
const CACHE = PREFIX + '408fb13d6a723948';
const ASSETS = ["/domain/backup.js","/domain/dates.js","/domain/ids.js","/domain/intervals.js","/domain/layout.js","/domain/records.js","/domain/storage-protection.js","/domain/time.js","/fonts/LICENSE.txt","/fonts/fonts.css","/fonts/ibm-plex-mono-01d285447409c8a5.woff2","/fonts/ibm-plex-mono-08949f728dc52d52.woff2","/fonts/ibm-plex-mono-0d1f0b8d0722224e.woff2","/fonts/ibm-plex-mono-1d89462e86cb8e87.woff2","/fonts/ibm-plex-mono-2b05a8695c7f9f4a.woff2","/fonts/ibm-plex-mono-32057cf50dd14bdb.woff2","/fonts/ibm-plex-mono-3febe5c7f22e4b07.woff2","/fonts/ibm-plex-mono-51b74d53e106ba8a.woff2","/fonts/ibm-plex-mono-62632b6375305e70.woff2","/fonts/ibm-plex-mono-6bb06407c97584b0.woff2","/fonts/ibm-plex-mono-6bc0f226a5b7884a.woff2","/fonts/ibm-plex-mono-7635422bd10ddbbc.woff2","/fonts/ibm-plex-mono-781633d95de88040.woff2","/fonts/ibm-plex-mono-83109cdd4f8665b4.woff2","/fonts/ibm-plex-mono-f8c22ec1804bd696.woff2","/icons/apple-touch-icon.png","/icons/icon-192.png","/icons/icon-512.png","/icons/icon.svg","/icons/maskable-512.png","/index.html","/main.js","/manifest-dark.webmanifest","/manifest.webmanifest","/runtime.js","/storage/db.js","/styles/app.css","/styles/tokens.css","/theme-boot.js","/ui/data.js","/ui/dom.js","/ui/pwa.js","/ui/scale.js","/ui/swipe.js","/ui/tasks.js","/ui/viewport.js"];
async function cacheReady() {
  if (!await caches.has(CACHE)) return false;
  const cache = await caches.open(CACHE);
  const results = await Promise.all(ASSETS.map(asset => cache.match(asset)));
  return ASSETS.length > 0 && results.every(Boolean);
}
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting();
  if (event.data?.type === 'GET_CACHE_STATUS' && event.ports[0]) {
    event.waitUntil((async () => {
      let ready = false;
      try { ready = await cacheReady(); }
      catch { /* Cache access failure must not be reported as offline readiness. */ }
      event.ports[0].postMessage({ type: 'CACHE_STATUS', ready });
    })());
  }
  if (event.data?.type === 'PREPARE_CACHE' && event.ports[0]) {
    event.waitUntil((async () => {
      let ready = false;
      let updateRequired = false;
      try {
        // Do not mix a newer hosted shell into the cache of an older active worker.
        const response = await fetch('/sw.js', { cache: 'no-store' });
        const hostedWorker = response.ok ? await response.text() : '';
        const version = CACHE.slice(PREFIX.length);
        updateRequired = !hostedWorker.includes(`const CACHE = PREFIX + '${version}';`);
        if (!updateRequired) {
          const cache = await caches.open(CACHE);
          await cache.addAll(ASSETS.map(asset => new Request(asset, { cache: 'reload' })));
          ready = await cacheReady();
        }
      } catch { /* A failed repair leaves local records and existing cache entries untouched. */ }
      event.ports[0].postMessage({ type: 'CACHE_PREPARED', ready, updateRequired });
    })());
  }
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(PREFIX) && name !== CACHE).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(caches.open(CACHE).then(cache => cache.match('/index.html')).then(cached => {
      if (!cached) return fetch(request);
      if (!cached.redirected) return cached;
      // Navigation requests reject redirect metadata retained by a precached canonical URL.
      return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers: cached.headers });
    }));
    return;
  }
  if (!ASSETS.includes(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(cache => cache.match(url.pathname)).then(cached => cached || fetch(request)));
});
