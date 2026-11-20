// Clip Factory service worker. The build fills in VERSION and PRECACHE (see vite.config.ts).
// - The app shell (HTML, hashed assets, icons) is precached so the app opens instantly and offline.
// - /config.json is network-first: a new deploy's settings win, the cached copy only helps offline.
// - The API, S3, Cognito and anything else cross-origin is never touched, so authorised responses are never cached.
// - /version.json and /downloads/* always come from the network (they change with every deploy).
// - A new worker installs and then WAITS. The page shows the update bar; Reload posts {type: "SKIP_WAITING"}
//   and reloads once the new worker has taken over. The very first install activates at once (nothing to replace).
const VERSION = __CF_VERSION__;
const PRECACHE = __CF_PRECACHE__;
const SHELL = `cf-shell-${VERSION}`;
const RUNTIME = `cf-runtime-${VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" })))),
  );
});

// Only the page decides when to switch, so an open tab never changes under the owner's fingers.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(RUNTIME);
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.headers.has("authorization")) return;
  if (url.pathname === "/version.json" || url.pathname.startsWith("/downloads/")) return;

  if (url.pathname === "/config.json") {
    event.respondWith(networkFirst(request, RUNTIME));
    return;
  }
  // Page loads: the newest index.html when online, the cached shell offline (the router takes it from there).
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match("/index.html")) ?? (await caches.match("/")) ?? Response.error()),
    );
    return;
  }
  if (url.pathname.startsWith("/assets/") || PRECACHE.includes(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

// ---------- Notifications (docs/CONTRACTS.md §32) ----------
// Every push shows a notification (iPhone requires it). One job's notifications share its tag, so the newest
// replaces the last: one card per video on the lock screen. A progress card ("quiet") replaces it without a buzz
// where the device allows. "badge" is how many videos are working: the number on the app icon.
// Only same-origin paths are ever opened, so a message can never send the owner anywhere else.
function safePath(url) {
  // Only plain paths like /jobs/<id>: no "//", no backslash (browsers read "/\\host" as "//host"), no scheme.
  if (typeof url !== "string" || !/^\/[A-Za-z0-9/_-]*$/.test(url) || url.startsWith("//")) return "/";
  return url;
}

function readPush(event) {
  try {
    return event.data ? event.data.json() : {};
  } catch {
    return {};
  }
}

async function showPush(data) {
  const title = typeof data.title === "string" && data.title ? data.title.slice(0, 80) : "Clip Factory";
  const body = typeof data.body === "string" ? data.body.slice(0, 200) : "";
  const tag = typeof data.tag === "string" && data.tag ? data.tag.slice(0, 64) : "clip-factory";
  const quiet = data.quiet === true;
  if (typeof data.badge === "number" && Number.isFinite(data.badge) && self.navigator.setAppBadge) {
    try {
      if (data.badge > 0) await self.navigator.setAppBadge(Math.round(data.badge));
      else await self.navigator.clearAppBadge();
    } catch {
      // No badge on this device: the notification still shows.
    }
  }
  await self.registration.showNotification(title, {
    body,
    tag,
    renotify: !quiet,
    silent: quiet,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: safePath(data.url) },
  });
}

self.addEventListener("push", (event) => {
  event.waitUntil(showPush(readPush(event)));
});

// The push service gave this device a new subscription. The worker has no sign-in, so it cannot tell the server
// itself: it subscribes again with the same key and asks every open page to send the new one (the page also
// re-sends it each time the app opens, so a closed app catches up at its next start).
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const key = event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey;
        if (key) await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      } catch {
        // The page's next start asks again.
      }
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      windows.forEach((w) => w.postMessage({ type: "PUSH_SUBSCRIPTION_CHANGED" }));
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const own = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (own) {
        await own.focus();
        if ("navigate" in own) await own.navigate(path).catch(() => {});
        return;
      }
      await self.clients.openWindow(path);
    })(),
  );
});
