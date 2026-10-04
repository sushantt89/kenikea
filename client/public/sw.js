// Minimal service worker - exists so browsers treat the app as installable
// ("Add to Home screen" / "Install app"). It deliberately does NOT cache
// anything or intercept requests: every page and /api call goes straight to
// the network exactly as before, so there's no stale-data or "why isn't my
// change showing" risk. (No offline mode - the app needs the server anyway.)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // Intentionally empty: no respondWith() means the browser handles the
  // request normally.
});
