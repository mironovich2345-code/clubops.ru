/* CLUB-OPS service worker — SAFE cache policy for a FINANCIAL app.
 *
 * RULES (see docs/architecture/pwa-cache-policy.md):
 *  - Cache ONLY immutable static build assets + PWA icons + manifest + an offline page.
 *  - NEVER cache authenticated HTML, API/data, financial records, documents, OFD receipts,
 *    personal data, or auth/session endpoints.
 *  - Navigations: network-first → honest offline page on failure (never stale finance data).
 *  - Everything else (data/API): network-only, untouched by the SW.
 *  - Versioned cache name; old caches purged on activate; skipWaiting only on user action.
 */
const VERSION = "v1";
const STATIC_CACHE = `clubops-static-${VERSION}`;
const OFFLINE_URL = "/offline";
// Precache the honest offline fallback only (no authenticated pages).
const PRECACHE = [OFFLINE_URL];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((c) => c.addAll(PRECACHE)).catch(() => {}));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("clubops-") && k !== STATIC_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

// Controlled update: the page posts SKIP_WAITING when the user taps "Обновить".
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

// Is this an immutable static asset safe to cache-first?
function isCacheableStatic(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/pwa/icon-") ||
    url.pathname === "/icon" ||
    url.pathname === "/apple-icon" ||
    url.pathname === "/manifest.webmanifest"
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never touch POST/PUT/etc.
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // only same-origin

  // 1) Immutable static assets → cache-first (fast repeat loads, safe).
  if (isCacheableStatic(url)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(STATIC_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => hit)),
    );
    return;
  }

  // 2) Navigations → network-first, honest offline fallback. Never cache the HTML
  //    (it may contain authenticated / financial data).
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  // 3) Everything else (API, data, documents, auth) → network-only, untouched.
});
