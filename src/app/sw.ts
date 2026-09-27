/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { defaultCache } from "@serwist/turbopack/worker";
import {
  CacheExpiration,
  ExpirationPlugin,
  NetworkFirst,
  NetworkOnly,
  type PrecacheEntry,
  Serwist,
  type SerwistGlobalConfig,
  type SerwistPlugin,
} from "serwist";
import { PAGES_CACHE, SHELL_CACHE } from "@/lib/db/caches";
import { MEDIA_CACHE } from "@/lib/media/media-cache";
import webpAsset from "@/lib/media/webp-asset.json";
import { SHARED } from "@/lib/quick/text";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

/** Pages served offline from a copy of their own, whatever their query string. */
const SHELLS = new Set(["/app", "/quick"]);

/**
 * How long a new version, as it starts, waits on the network for the shells
 * it fetches again: the open pages' requests wait for it to start meanwhile.
 */
const REFRESH_TIMEOUT_MS = 5_000;

/**
 * A page itself, not a file it is made of: loaded as one, or asked for by
 * SerwistProvider once the app has moved to it within itself
 * (cacheOnNavigation), which the worker fetches as a request of its own, on
 * a message rather than a fetch. Next asks for a route's payload with an RSC
 * header.
 */
const isPage = (request: Request, event: ExtendableEvent) =>
  request.destination === "document" ||
  (!(event instanceof FetchEvent) && !request.headers.has("RSC"));

/** An address with what a share sheet sent, which Next writes into the page. */
const holdsShare = (url: URL) => SHARED.some((name) => url.searchParams.has(name));

/**
 * The page the browser started fetching along with the navigation
 * (navigationPreload), so that a handler of our own does not have the server
 * render it a second time. Serwist's strategies take it by themselves.
 */
async function preloaded(event: ExtendableEvent): Promise<Response | undefined> {
  if (!(event instanceof FetchEvent)) return undefined;
  // Rejected when that fetch failed, and then fetched again, as Serwist does.
  return event.preloadResponse.catch(() => undefined);
}

/**
 * Keeps a page only as itself: not a redirect, whether handed to the browser
 * to follow (status 0) or followed already. Serwist's own rules keep both,
 * so a page opened signed out would be kept as the way to sign in, and
 * shown so offline.
 */
const pageItself: SerwistPlugin = {
  cacheWillUpdate: async ({ response }) => (response.ok && !response.redirected ? response : null),
};

/**
 * The service worker is what makes the app usable with no network at all.
 *
 * Without it the interface could still read its own IndexedDB, but a reload or
 * an in-app navigation would fail, because Next fetches the route payload from
 * the server. Caching the shell means the app opens from the home screen on a
 * plane and behaves normally.
 */
const serwist: Serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      // Signing the desktop shell in: a page with a token in its address, or
      // on it, is kept nowhere on the device.
      matcher: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/desktop/"),
      handler: new NetworkOnly(),
    },
    {
      // Nor the sign-in page, whose address holds the one to come back to,
      // with what was shared into the quick note (/sign-in?next=/quick?text=...).
      matcher: ({ url, sameOrigin }) => sameOrigin && url.pathname === "/sign-in",
      handler: new NetworkOnly(),
    },
    {
      // The workspace (/app) and the quick note (/quick) keep their state in
      // the query string, so a reload of /app?n=... or /quick?window=1 must be
      // served by the one cached copy of each. Caching per full URL would miss
      // every address the device has not loaded before, which is exactly the
      // offline case. The copy comes from a load, and from the app moving to
      // one within itself: the quick note may only ever have been opened from
      // the bottom bar's ⚡ before a share arrives with no network. A redirect
      // (to sign in) is not a copy worth keeping, whether it comes as one (to
      // a load) or followed already (to the worker's own request); nor is a
      // page loaded with what was shared, which would stay on the device.
      matcher: ({ url, request, event, sameOrigin }) =>
        sameOrigin && SHELLS.has(url.pathname) && isPage(request, event),
      handler: {
        handle: async ({ request, url, event }) => {
          const cache = await caches.open(SHELL_CACHE);
          try {
            const response = (await preloaded(event)) ?? (await fetch(request));
            if (response.ok && !response.redirected && !holdsShare(url)) {
              event.waitUntil(cache.put(url.pathname, response.clone()));
            }
            return response;
          } catch (cause) {
            const cached = await cache.match(url.pathname);
            if (cached) return cached;
            // Never kept: the offline page, as for any other page. Serwist's
            // `fallbacks` reach only its own strategies, which this is not.
            if (request.destination === "document") {
              const offline = await serwist.matchPrecache("/offline");
              if (offline) return offline;
            }
            throw cause;
          }
        },
      },
    },
    {
      // The reading dictionary is 17 MB across a dozen files, deliberately not
      // precached: that would make installing the app a 17 MB download for
      // everyone, including people who never search in kana. It is cached on
      // first fetch instead, after which reading search works offline.
      matcher: ({ url }) =>
        url.origin === self.location.origin && url.pathname.startsWith("/kuromoji/"),
      handler: {
        handle: async ({ request, event }) => {
          const cache = await caches.open("memoca-yomi");
          const cached = await cache.match(request);
          if (cached) return cached;
          const response = await fetch(request);
          if (response.ok) event.waitUntil(cache.put(request, response.clone()));
          return response;
        },
      },
    },
    {
      // The WebP encoder, only for browsers whose canvas cannot write WebP,
      // so not precached for everyone: cached on first use, under a path that
      // changes with each version.
      matcher: ({ url }) =>
        url.origin === self.location.origin && url.pathname.startsWith("/webp/"),
      handler: {
        handle: async ({ request, event }) => {
          const cache = await caches.open("memoca-webp");
          const cached = await cache.match(request);
          if (cached) return cached;
          const response = await fetch(request);
          if (response.ok) event.waitUntil(cache.put(request, response.clone()));
          return response;
        },
      },
    },
    {
      // Uploaded images and videos are immutable once stored, so the first
      // view is the only one that needs the network.
      matcher: ({ url }) => /\.convex\.(cloud|site)$/.test(url.hostname),
      handler: {
        handle: async ({ request, event }) => {
          // Asked not to be kept, such as a note's body: straight through.
          if (request.cache === "no-store") return fetch(request);
          const cache = await caches.open(MEDIA_CACHE);
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
    {
      // Every other page, loaded or moved to within the app: from the network
      // while there is one, as last kept when there is none, and only as
      // itself, like the shells. A strategy of Serwist's, it gets the offline
      // page for one never kept. The default rules would keep it too, in
      // "others", redirects included.
      matcher: ({ url, request, event, sameOrigin }) =>
        sameOrigin && !url.pathname.startsWith("/api/") && isPage(request, event),
      handler: new NetworkFirst({
        cacheName: PAGES_CACHE,
        plugins: [
          pageItself,
          new ExpirationPlugin({ maxEntries: 32, maxAgeSeconds: 24 * 60 * 60 }),
        ],
      }),
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

// A new version drops the previous one's files from the precache, which a
// shell kept before it still loads: offline it would never start. Each shell
// kept is fetched again, as this version's: replaced by the page, let go if
// it is now a redirect to sign in, and left as it was with no network (or
// too slow a one), for the next load to replace.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const slow = new AbortController();
      const timer = setTimeout(() => slow.abort(), REFRESH_TIMEOUT_MS);
      await Promise.all(
        [...SHELLS].map(async (path) => {
          if (!(await cache.match(path))) return;
          try {
            const response = await fetch(path, { redirect: "manual", signal: slow.signal });
            if (response.ok) await cache.put(path, response);
            else if (response.type === "opaqueredirect") await cache.delete(path);
          } catch {
            // Kept as it was.
          }
        }),
      );
      clearTimeout(timer);
    })(),
  );
});

// Pages an earlier version kept in the default rules' "others" cache (the
// sign-in page, with what was shared into the quick note, among them) are no
// longer served from there, now that pages have a cache of their own: let go,
// with the addresses its expiration noted of them. What else lands there is
// little, and fetched again.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.delete("others"),
      new CacheExpiration("others", { maxEntries: 32 }).delete(),
    ]),
  );
});

// A WebP encoder of an earlier version, cached when it was used, is of no use
// to this one: about 300 KB let go.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open("memoca-webp");
      const current = `/webp/${webpAsset.version}/`;
      for (const request of await cache.keys()) {
        if (!new URL(request.url).pathname.startsWith(current)) await cache.delete(request);
      }
    })(),
  );
});
