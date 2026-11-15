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
