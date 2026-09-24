// Service worker — force network-first for all requests.
// Prevents stale cached JS modules from breaking the app.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// A rejected respondWith() is Chrome's "This site can't be reached —
// ERR_FAILED", even when the site is up and only one request hiccupped. So a
// failed no-store fetch gets a second, plain try, and a page that still cannot
// load says so in words instead of looking like the site is gone.
self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET') return;
    e.respondWith(
        fetch(e.request, { cache: 'no-store' })
            .catch(() => fetch(e.request))
            .catch(() => e.request.mode === 'navigate'
                ? new Response(
                    '<meta name="viewport" content="width=device-width">' +
                    '<body style="font:16px -apple-system,sans-serif;padding:24px;' +
                    'background:#0f172a;color:#e2e8f0">' +
                    '<p>No connection to the app right now.</p>' +
                    '<p>Check the network and <a style="color:#38bdf8" ' +
                    'href="">reload</a>.</p></body>',
                    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
                : Response.error()),
    );
});
