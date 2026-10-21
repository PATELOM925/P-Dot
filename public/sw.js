// P-Dot service worker. It makes the app installable, shows an offline page
// when the network is down, and displays notifications.
//
// Privacy: it caches only the offline page and the app icons. Workspace pages
// and API responses hold personal data and are never cached here.
//
// Push: the server does not send push messages yet (no subscriptions are
// stored and no VAPID key is configured). The handlers below are ready for it.

const CACHE = "pdot-shell-v1";
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png", "/icons/badge-96.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Page navigations go to the network; only a network failure shows the cached offline page.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.mode !== "navigate" || request.method !== "GET") return;
  event.respondWith(
    fetch(request).catch(() => caches.match(OFFLINE_URL).then((cached) => cached || Response.error())),
  );
});

/** Only paths on this site may be opened from a notification. */
function safeUrl(value) {
  try {
    const url = new URL(typeof value === "string" ? value : "/today", self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search : "/today";
  } catch {
    return "/today";
  }
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title.slice(0, 100) : "P-Dot";
  const body = typeof data.body === "string" ? data.body.slice(0, 300) : "";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      data: { url: safeUrl(data.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin && "focus" in client);
      if (!open) return self.clients.openWindow(target);
      // Focus first, while the click still allows it. navigate() works only for
      // pages this worker controls; otherwise the page stays where it is.
      return open.focus().then((focused) => focused.navigate(target).catch(() => focused));
    }),
  );
});
