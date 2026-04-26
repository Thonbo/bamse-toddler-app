// Vesters App Service Worker
// Strategy:
//   - HTML: NETWORK-FIRST (fall back to cache if offline)
//   - Everything else (icons, fonts, manifest): CACHE-FIRST
//   - Refuse to cache tiny/empty responses (defends against bad CDN responses)
//   - YouTube traffic: always pass through, never intercept

const CACHE = 'vesters-v13';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable.png',
];
const MIN_HTML_BYTES = 1000; // anything smaller than this is treated as a bad response

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(SHELL.map((url) => cache.add(url).catch((err) => console.warn('SW cache miss', url, err))))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Helper: clone the response and check if it looks valid (non-empty, status 2xx)
async function isValidResponse(response) {
  if (!response || !response.ok) return false;
  // Some Netlify error responses come as 200 but tiny — check size if available
  const cl = response.headers.get('content-length');
  if (cl !== null && parseInt(cl, 10) < MIN_HTML_BYTES && response.headers.get('content-type')?.includes('html')) {
    return false;
  }
  return true;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never intercept YouTube
  if (url.hostname.includes('youtube.com') || url.hostname.includes('youtu.be') ||
      url.hostname.includes('googlevideo.com') || url.hostname.includes('ytimg.com') ||
      url.hostname.includes('doubleclick.net') || url.hostname.includes('google.com') ||
      url.hostname.includes('googleapis.com') && !url.hostname.includes('fonts')) {
    return;
  }

  // HTML: network-first, fallback to cache
  const isHTML = req.mode === 'navigate' ||
                 req.headers.get('accept')?.includes('text/html') ||
                 url.pathname === '/' ||
                 url.pathname.endsWith('.html');

  if (isHTML && url.origin === location.origin) {
    event.respondWith((async () => {
      try {
        const networkRes = await fetch(req, { cache: 'no-store' });
        if (await isValidResponse(networkRes.clone())) {
          // Cache the good response for offline fallback
          const cache = await caches.open(CACHE);
          cache.put(req, networkRes.clone());
          return networkRes;
        }
        // Bad response — fall back to cache
        const cached = await caches.match(req) || await caches.match('/index.html') || await caches.match('/');
        if (cached) return cached;
        return networkRes; // last resort: return the bad response
      } catch (err) {
        // Offline — serve from cache
        const cached = await caches.match(req) || await caches.match('/index.html') || await caches.match('/');
        if (cached) return cached;
        throw err;
      }
    })());
    return;
  }

  // Fonts: stale-while-revalidate
  if (url.hostname.includes('fonts.gstatic.com') || url.hostname.includes('fonts.googleapis.com')) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req).then((res) => {
          if (res.ok) caches.open(CACHE).then((cache) => cache.put(req, res.clone()));
          return res;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Other same-origin assets: cache-first
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok && req.method === 'GET') {
            caches.open(CACHE).then((cache) => cache.put(req, res.clone()));
          }
          return res;
        });
      })
    );
  }
});
