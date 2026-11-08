// ClientMap service worker — served from /sw.js so it controls the whole site.
// Bump VERSION whenever the app shell changes, so old caches are cleared.
const VERSION = 'cm-v1';
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/static/img/logo.png',
  '/static/img/icon-192.png',
  '/static/img/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const put = (req, res) => {
  if (res && res.ok && res.type === 'basic') {
    const copy = res.clone();
    caches.open(VERSION).then(c => c.put(req, copy));
  }
  return res;
};

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google Fonts: cache-first (they are versioned by URL).
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  if (url.origin !== location.origin) return;

  // Data, files and share links always go to the network — never served stale.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/s/') || url.pathname === '/sw.js') return;

  // Page loads: network first so a deploy is picked up at once; cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(res => (url.pathname === '/' ? put('/', res) : res))
        .catch(() => caches.match('/').then(hit => hit || new Response(
          '<!doctype html><meta name=viewport content="width=device-width"><title>Offline</title>' +
          '<body style="font-family:system-ui;padding:2rem;text-align:center"><h2>You are offline</h2><p>Reconnect and try again.</p>',
          { headers: { 'Content-Type': 'text/html' } })))
    );
    return;
  }

  // Static files (CSS/JS carry ?v= so a new deploy is a new URL): serve cache, refresh in background.
  if (url.pathname.startsWith('/static/')) {
    e.respondWith(caches.match(req).then(hit => {
      const net = fetch(req).then(res => put(req, res)).catch(() => hit);
      return hit || net;
    }));
  }
});
