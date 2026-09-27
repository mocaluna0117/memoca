import { MEDIA_CACHE } from "@/lib/media/media-cache";

/** The service worker's one copy each of /app and /quick (see `src/app/sw.ts`). */
export const SHELL_CACHE = "memoca-shell";

/** The service worker's copies of the app's other pages. */
export const PAGES_CACHE = "memoca-pages";

/**
 * The service worker's caches that can hold something of an account's own.
 * Every page it keeps carries the Convex token the root layout gives it, and
 * with it the account's name and email; a quick note's page, what was shared
 * into it; and the stored files are the account's files.
 *
 * Besides ours, those of @serwist/turbopack's default rules that can keep a
 * page, a route's payload, an answer of the app's API, or anything from
 * another site. The others hold the app's own files (the precache, the
 * reading dictionary, the WebP encoder, scripts, styles, fonts and icons),
 * the same for anyone, which would only be downloaded again.
 */
export const ACCOUNT_CACHES: readonly string[] = [
  SHELL_CACHE,
  PAGES_CACHE,
  MEDIA_CACHE,
  "pages",
  "pages-rsc",
  "pages-rsc-prefetch",
  "others",
  "apis",
  "cross-origin",
];

/** Deletes those caches, where there are any: not in the unit tests' jsdom. */
export async function forgetAccountCaches(): Promise<void> {
  if (typeof caches === "undefined") return;
  await Promise.all(ACCOUNT_CACHES.map((name) => caches.delete(name).catch(() => false)));
}
