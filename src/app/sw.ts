/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { defaultCache } from "@serwist/turbopack/worker";
import { type PrecacheEntry, Serwist, type SerwistGlobalConfig } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

/**
 * The service worker is what makes the app usable with no network at all.
 *
 * Without it the interface could still read its own IndexedDB, but a reload or
 * an in-app navigation would fail, because Next fetches the route payload from
 * the server. Caching the shell means the app opens from the home screen on a
 * plane and behaves normally.
 */
const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      // The whole workspace lives at /app and keeps its state in the query
      // string, so a reload of /app?n=... must be served by the cached /app
      // document. Caching per full URL would miss every note the device has
      // not reloaded on before, which is exactly the offline case.
      matcher: ({ url, request }) =>
        request.destination === "document" && url.pathname === "/app",
      handler: {
        handle: async ({ request, event }) => {
          const cache = await caches.open("memoca-shell");
          try {
            const response = await fetch(request);
            if (response.ok) event.waitUntil(cache.put("/app", response.clone()));
            return response;
          } catch (cause) {
            const cached = await cache.match("/app");
            if (cached) return cached;
            throw cause;
          }
        },
      },
    },
    {
      // Uploaded images and videos are immutable once stored, so the first
      // view is the only one that needs the network.
      matcher: ({ url }) => /\.convex\.(cloud|site)$/.test(url.hostname),
      handler: {
        handle: async ({ request, event }) => {
          const cache = await caches.open("memoca-media");
          const cached = await cache.match(request);
          if (cached) return cached;
          const response = await fetch(request);
          if (response.ok && request.method === "GET") {
            event.waitUntil(cache.put(request, response.clone()));
          }
          return response;
        },
      },
    },
    ...defaultCache,
  ],
  fallbacks: {
    entries: [
      {
        url: "/offline",
        matcher: ({ request }) => request.destination === "document",
      },
    ],
  },
});

serwist.addEventListeners();
