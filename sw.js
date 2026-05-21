// Service worker — force network-first for all requests.
// Prevents stale cached JS modules from breaking the app.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
    e.respondWith(fetch(e.request, { cache: 'no-store' }));
});
