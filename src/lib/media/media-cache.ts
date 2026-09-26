/**
 * The service worker's cache of stored files (see `src/app/sw.ts`). It keeps
 * whatever it fetched, for good: a file fetched while it was plain stays
 * readable there after the note it belongs to is locked.
 */
export const MEDIA_CACHE = "memoca-media";

/**
 * Empties that cache. Everything in it is an immutable stored file, so the
 * cost is one download each the next time it is shown.
 */
export async function purgeMediaCache(): Promise<void> {
  if (typeof caches === "undefined") return;
  await caches.delete(MEDIA_CACHE).catch(() => false);
}
