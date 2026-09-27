import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "vitest";

/**
 * The service worker's offline page is attached, by `new Serwist({ fallbacks })`,
 * only to the caching strategies that are instances of its own Strategy class.
 * The default rules come from @serwist/turbopack: from another copy of serwist,
 * they would get none, and a page never kept on the device would fail to open
 * offline, with the browser's error in place of the page saying so.
 */
test("the service worker and its default caching rules use the one copy of serwist", () => {
  const here = createRequire(import.meta.url);
  const own = realpathSync(here.resolve("serwist"));
  const rules = createRequire(here.resolve("@serwist/turbopack/worker"));
  expect(realpathSync(rules.resolve("serwist"))).toBe(own);
});
