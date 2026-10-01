/* Drive2Social Publisher — service worker (PWA app shell).
 *
 * Strategy:
 *  - Navigations: network-first, fall back to the cached app shell
 *    (offline-friendly UI shell; publishing still needs a connection).
 *  - Static assets (JS/CSS/images): cache-first, then network.
 *  - API calls (/api/*): network-only — never serve stale job state.
 */
const CACHE = "drive2social-shell-v3";
const SHELL = ["/", "/index.html", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // API + Drive preview streams: always network, never cached.
  if (url.pathname.startsWith("/api/")) return;

  // Navigations: network-first with offline shell fallback.
  // Only successful responses are cached — never cache error pages.
  // `cache: "reload"` bypasses the browser HTTP cache so a stale
  // cached error page can never be served for a navigation.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request.url, { cache: "reload" })
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("/index.html", copy));
          }
          return res;
        })
        .catch(() => caches.match("/index.html")),
    );
    return;
  }

  // Static assets: cache-first.
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((res) => {
          if (res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        }),
    ),
  );
});
