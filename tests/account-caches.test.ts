import "fake-indexeddb/auto";
import { NetworkOnly, Strategy } from "serwist";
import { afterEach, describe, expect, test, vi } from "vitest";
import { db, resetLocalData, setMeta } from "@/lib/db";
import { ACCOUNT_CACHES } from "@/lib/db/caches";

/** Caches that hold something of the account's: its pages, their payloads, its files. */
const THE_ACCOUNTS = [
  "memoca-shell",
  "memoca-pages",
  "memoca-media",
  "pages",
  "pages-rsc",
  "pages-rsc-prefetch",
  "others",
  "apis",
  "cross-origin",
];

/** Caches of the app's own files, the same for anyone. */
const THE_APPS = [
  "serwist-precache-v2-https://memoca.test/",
  "memoca-yomi",
  "memoca-webp",
  "next-static-js-assets",
  "static-style-assets",
  "static-font-assets",
  "static-image-assets",
];

/**
 * What @serwist/turbopack's default rules keep that is the app's own: files
 * of the build, fonts, and the like, fetched again at no cost to anyone.
 */
const DEFAULT_RULES_APP_FILES = new Set([
  "google-fonts-webfonts",
  "google-fonts-stylesheets",
  "static-font-assets",
  "static-image-assets",
  "next-static-js-assets",
  "next-image",
  "static-audio-assets",
  "static-video-assets",
  "static-js-assets",
  "static-style-assets",
  "next-data",
  "static-data-assets",
]);

/** The device's Cache Storage, as far as deleting whole caches goes. */
function deviceCaches(names: string[], refuses: string[] = []) {
  const present = new Set(names);
  vi.stubGlobal("caches", {
    delete: async (name: string) => {
      if (refuses.includes(name)) throw new DOMException("refused", "UnknownError");
      return present.delete(name);
    },
  });
  return present;
}

afterEach(() => vi.unstubAllGlobals());

describe("forgetting an account on this device", () => {
  test("deletes the caches of its pages and files, and keeps the app's own", async () => {
    const present = deviceCaches([...THE_ACCOUNTS, ...THE_APPS]);
    await setMeta("userKey", "user-a");

    await resetLocalData();
    expect([...present].sort()).toEqual([...THE_APPS].sort());
    expect(await db().meta.count()).toBe(0);
  });

  test("a cache that will not go keeps neither the others nor the database", async () => {
    const present = deviceCaches([...THE_ACCOUNTS, ...THE_APPS], ["memoca-shell"]);
    await setMeta("userKey", "user-a");

    await resetLocalData();
    expect([...present].sort()).toEqual(["memoca-shell", ...THE_APPS].sort());
    expect(await db().meta.count()).toBe(0);
  });

  test("with no Cache Storage at all, the database is emptied all the same", async () => {
    vi.stubGlobal("caches", undefined);
    await setMeta("userKey", "user-a");

    await resetLocalData();
    expect(await db().meta.count()).toBe(0);
  });

  test("covers every cache the default caching rules keep that is not the app's own", async () => {
    // In development the default rules keep nothing; these are production's.
    vi.stubEnv("NODE_ENV", "production");
    const { defaultCache } = await import("@serwist/turbopack/worker");
    vi.unstubAllEnvs();
    expect(defaultCache.length).toBeGreaterThan(1);

    const kept = defaultCache
      .map((rule) => rule.handler)
      .filter((handler) => handler instanceof Strategy && !(handler instanceof NetworkOnly))
      .map((handler) => (handler as Strategy).cacheName);
    expect(kept.length).toBeGreaterThan(0);
    // A new one, or one renamed, has to be sorted: the account's to forget,
    // or the app's own to keep.
    expect(
      kept.filter((name) => !ACCOUNT_CACHES.includes(name) && !DEFAULT_RULES_APP_FILES.has(name)),
    ).toEqual([]);
  });
});
