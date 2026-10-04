// Minimal service worker - makes the app installable ("Add to Home screen" /
// "Install app") and shows push notifications. It deliberately does NOT
// cache anything or intercept requests: every page and /api call goes straight to
// the network exactly as before, so there's no stale-data or "why isn't my
// change showing" risk. (No offline mode - the app needs the server anyway.)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // Intentionally empty: no respondWith() means the browser handles the
  // request normally.
});

// Push notifications (sent by the server - see server/src/services/push.js).
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Worker Assignment", {
      body: data.body || "",
      icon: "/android-chrome-192.png",
      badge: "/favicon-48.png",
      tag: data.tag || undefined,
      data: { url: data.url || "/" },
    })
  );
});

// Tapping a notification opens (or focuses) the app at the relevant page.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if (new URL(w.url).origin === self.location.origin && "focus" in w) {
          return w.focus().then((c) => (c && "navigate" in c ? c.navigate(url) : c));
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
