"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/** The pages the worker has been asked for in this page's life. */
const asked = new Set<string>();

/** For tests: none asked yet. */
export function resetAskedPages() {
  asked.clear();
}

/** The worker asked to fetch a page and keep its copy (src/app/sw.ts), once. */
function keep(path: string, again = false) {
  const worker = typeof navigator === "undefined" ? null : navigator.serviceWorker?.controller;
  if (!worker || !navigator.onLine) return;
  if (asked.has(path) && !again) return;
  asked.add(path);
  // Serwist's own CACHE_URLS message, with no reply asked for: a channel for
  // one stays open until the worker has fetched the page.
  worker.postMessage({ type: "CACHE_URLS", payload: { urlsToCache: [path] } });
}

/**
 * A copy of each page moved to within the app, for it to open offline (the
 * quick note, say, only ever reached from the bottom bar's ⚡): once a page,
 * by its path. In place of Serwist's cacheOnNavigation, which asked for the
 * whole address at every change of it: each note opened (its ?n=) had the
 * worker fetch the workspace again from the server, and left a message
 * channel open, waiting for its answer. The page loaded is kept by the
 * worker as it goes by; and as the network comes back, the page shown is
 * fetched again.
 */
export function CachePages() {
  const pathname = usePathname();
  const loaded = useRef(pathname);
  useEffect(() => {
    if (pathname === loaded.current) return;
    loaded.current = "";
    keep(pathname);
  }, [pathname]);
  useEffect(() => {
    const online = () => keep(window.location.pathname, true);
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, []);
  return null;
}
