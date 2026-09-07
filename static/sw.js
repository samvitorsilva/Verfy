/* Kill-switch service worker.
   Served at /sw.js so any stale registration that updates from this URL
   clears caches and unregisters itself instead of bricking the app. */
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (_) {}
    try {
      await self.registration.unregister();
    } catch (_) {}
  })());
});
self.addEventListener("fetch", (event) => {
  // Never hijack requests — always hit the network.
  event.respondWith(fetch(event.request));
});
