/* Onyx Baseball service worker: network-first for same-origin requests so
   the baked slate is always fresh, cached copy only as an offline fallback.
   Cross-origin (MLB Stats API, Onyx, logos CDN) is never intercepted.
   OneSignal's worker rides along for closed-app push (HRs + finals from
   the notify_watch workflow); harmless no-op until the app id is wired. */
try { importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js'); } catch (e) {}
const CACHE = 'onyx-v3';

self.addEventListener('install', e => { self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
