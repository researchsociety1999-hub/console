// Console service worker.
// Caches only same-origin static app files. It never caches POST requests,
// cross-origin requests, model runtimes (node_modules/vendor) or any user data.

const CACHE_NAME = "console-cache-v4";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/style.css",
  "./assets/icon.svg",
  "./js/app.js",
  "./js/async-pipeline.js",
  "./js/data-firewall.js",
  "./js/joker-adapter.js",
  "./js/local-llm-controller.js",
  "./js/pwa-init.js",
  "./js/security-audit-suite.js",
  "./js/service-worker-register.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)));
});

// A waiting worker activates only when the page asks for it (user accepted the update prompt).
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.headers.has("range")) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes("/node_modules/") || url.pathname.includes("/vendor/")) return;

  // Network first so the UI is never older than the server; cache is the offline fallback.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          if (request.mode === "navigate") return caches.match("./index.html");
          return Response.error();
        })
      )
  );
});
