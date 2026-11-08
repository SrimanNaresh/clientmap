// PWA: register the service worker and offer an "Install app" item in the user menu.
(() => {
  const btn = document.getElementById('installBtn');
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const say = (msg, bad) => (typeof toast === 'function' ? toast(msg, bad) : alert(msg));
  let deferred = null;

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').then(reg => {
        // When a new version is installed while the page is open, tell the user once.
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          nw && nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) say('App updated — reload to get the latest version');
          });
        });
      }).catch(() => { /* app still works without offline support */ });
    });
  }

  if (!btn || standalone) return;

  // Chrome / Edge / Android: keep the browser's install prompt and show it from our button.
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; btn.hidden = false; });
  addEventListener('appinstalled', () => { deferred = null; btn.hidden = true; say('ClientMap installed'); });

  // iPhone / iPad Safari has no install prompt — show how to add it instead.
  if (isIOS) btn.hidden = false;

  btn.addEventListener('click', async () => {
    document.getElementById('userPop').hidden = true;
    if (deferred) {
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      deferred = null;
      if (outcome === 'accepted') btn.hidden = true;
    } else if (isIOS) {
      say('Tap the Share button, then “Add to Home Screen”');
    }
  });
})();
