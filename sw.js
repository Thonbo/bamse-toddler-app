// Vesters App Service Worker
// Caches the app shell so the menu + tap game work fully offline.
// YouTube videos stream live and require network — that's a YouTube limitation.

const CACHE = 'vesters-v3';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable.png',
  'https://fonts.googleapis.com/css2?family=Roboto+Flex:opsz,wght@8..144,400;8..144,500;8..144,700;8..144,900&display=swap',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Use addAll but tolerate failures on cross-origin font CSS
      Promise.all(
        SHELL.map((url) =>
          cache.add(url).catch((err) => console.warn('SW: failed to cache', url, err))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never intercept YouTube requests — let them pass through to network.
  if (url.hostname.includes('youtube.com') || url.hostname.includes('youtu.be') ||
      url.hostname.includes('googlevideo.com') || url.hostname.includes('ytimg.com') ||
      url.hostname.includes('doubleclick.net') || url.hostname.includes('google.com')) {
    return; // browser handles normally
  }

  // Stale-while-revalidate for fonts (Google Fonts woff2 files)
  if (url.hostname.includes('fonts.gstatic.com') || url.hostname.includes('fonts.googleapis.com')) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, clone));
          }
          return res;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // Cache-first for same-origin app shell
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          if (res.ok && req.method === 'GET') {
            const clone = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, clone));
          }
          return res;
        }).catch(() => caches.match('/index.html'));
      })
    );
  }
});
