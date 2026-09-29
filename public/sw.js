/* Synapse Core service worker — PWA offline app-shell support.
 *
 * Strategy:
 *  - Precache the app shell (root document + core static assets) on install.
 *  - Stale-while-revalidate for same-origin GET static assets and navigations:
 *    serve the cached copy immediately, refresh it in the background.
 *  - Network-first for API/RPC calls so live data is never masked by a stale
 *    cache; on failure fall back to the last-known cached response if present.
 *
 * Wallet-signing / write flows are intentionally NOT cached: only GET requests
 * are handled, and any non-GET (POST/PUT/DELETE) request bypasses the cache
 * entirely so a stale transaction preview can never be shown as live.
 */

const CACHE_VERSION = "v1";
const SHELL_CACHE = `synapse-shell-${CACHE_VERSION}`;
const DATA_CACHE = `synapse-data-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  "/",
  "/manifest.json",
  "/icon.png",
  "/apple-icon.png",
  "/favicon.ico",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== DATA_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/rpc") ||
    url.hostname !== self.location.hostname
  );
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.status === 200 && response.type === "basic") {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached);
  return cached || network;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Never intercept non-GET (write/signing) requests.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Navigations: serve the cached app shell, refresh in background.
  if (request.mode === "navigate") {
    event.respondWith(
      staleWhileRevalidate(request, SHELL_CACHE).catch(() =>
        caches.match("/")
      )
    );
    return;
  }

  // Live data (API/RPC/cross-origin): network-first, fall back to cache.
  if (isApiRequest(url)) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  // Same-origin static assets: stale-while-revalidate.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
  }
});
