
const CACHE_NAME = "ramatech-home-ai-v2";

const APP_FILES = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png"
];

// Install: cache the app interface and icons.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

// Activate: remove old versions of this app's cache.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) =>
              key.startsWith("ramatech-home-ai-") &&
              key !== CACHE_NAME
            )
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Fetch: network-first for pages, cache-first for local app files.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Only handle requests belonging to this website.
  if (url.origin !== self.location.origin) return;

  // Do not intercept WebSocket connections or non-GET requests.
  if (request.method !== "GET") return;

  // Keep API status and other dynamic responses live.
  if (
    url.pathname === "/status" ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }

  // For page navigation, try the network first.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME)
              .then((cache) => cache.put("/index.html", copy));
          }
          return response;
        })
        .catch(async () => {
          return (
            await caches.match(request) ||
            await caches.match("/index.html") ||
            Response.error()
          );
        })
    );
    return;
  }

  // For app files and icons, use cache first.
  event.respondWith(
    caches.match(request).then(async (cached) => {
      if (cached) return cached;

      const response = await fetch(request);

      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME)
          .then((cache) => cache.put(request, copy));
      }

      return response;
    })
  );
});
