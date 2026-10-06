import { expect, type Page, test } from "@playwright/test";
import { offlineReady, openApp, signUp } from "./helpers";

/** The service worker's one copy each of /app and /quick. */
const SHELL = "memoca-shell";

/** What the sign-in page says, and no other page does. */
const SIGN_IN = "Google でログイン";

/** A text no page of the app holds, to look for on the device. */
const unique = () => `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Waits for the service worker to be in charge of the page, and done with
 * starting: what it does then, on copies put in place since, would be taken
 * for what the test is about. A first visit can finish loading before it has
 * installed, and is not reliably taken over (see offlineReady); the next
 * load is.
 */
async function workerInCharge(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const worker = (await navigator.serviceWorker.ready).active!;
    if (worker.state === "activated") return;
    await new Promise<void>((resolve) =>
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") resolve();
      }),
    );
  });
  const inCharge = () => page.evaluate(() => navigator.serviceWorker.controller !== null);
  if (!(await inCharge())) await page.reload();
  await expect.poll(inCharge).toBe(true);
}

/** What `cache` keeps for `address`, if anything: its status, and the page's title. */
async function kept(page: Page, cache: string, address: string) {
  return page.evaluate(
    async ([name, key]) => {
      if (!(await caches.has(name))) return null;
      const response = await (await caches.open(name)).match(key);
      if (!response) return null;
      const title = /<title>([^<]*)<\/title>/.exec(await response.text())?.[1] ?? null;
      return { status: response.status, title };
    },
    [cache, address],
  );
}

/**
 * Every address the device keeps something for, outside the precache, and
 * whether what it keeps is the way to sign in rather than the page: a
 * redirect left for the browser to follow (status 0), or the sign-in page.
 */
async function keptPages(page: Page) {
  return page.evaluate(async (signIn) => {
    const found: { cache: string; address: string; signIn: boolean }[] = [];
    for (const name of await caches.keys()) {
      if (name.includes("precache")) continue;
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        if (!response) continue;
        const url = new URL(request.url);
        const html = response.headers.get("Content-Type")?.includes("text/html") ?? false;
        found.push({
          cache: name,
          address: url.pathname + url.search,
          signIn: response.status === 0 || (html && (await response.text()).includes(signIn)),
        });
      }
    }
    return found;
  }, SIGN_IN);
}

/** The caches, and the addresses in them, whose address or content holds `text`. */
async function holding(page: Page, text: string): Promise<string[]> {
  return page.evaluate(async (needle) => {
    const found: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const body = (await (await cache.match(request))?.text()) ?? "";
        if (request.url.includes(needle) || body.includes(needle))
          found.push(`${name} ${request.url}`);
      }
    }
    return found;
  }, text);
}

/** Puts stand-ins, saying `text`, where the shells are kept. */
async function standInShells(page: Page, text: string): Promise<void> {
  await page.evaluate(
    async ([name, marker]) => {
      const cache = await caches.open(name);
      for (const address of ["/app", "/quick"]) {
        await cache.put(
          address,
          new Response(`<!DOCTYPE html><title>${marker}</title>`, {
            headers: { "Content-Type": "text/html" },
          }),
        );
      }
    },
    [SHELL, text],
  );
}

/**
 * What SerwistProvider sends the worker once the app has moved to an address
 * within itself, or when the network comes back (cacheOnNavigation): keep
 * these. Resolves once the worker has fetched them.
 */
async function askToKeep(page: Page, urls: string[]): Promise<void> {
  await page.evaluate(
    (urlsToCache) =>
      new Promise<void>((resolve) => {
        const reply = new MessageChannel();
        reply.port1.onmessage = () => resolve();
        navigator.serviceWorker.controller!.postMessage(
          { type: "CACHE_URLS", payload: { urlsToCache } },
          [reply.port2],
        );
      }),
    urls,
  );
}

/**
 * Stands in for the next deploy: the same worker installed again from another
 * address, which the browser takes for a new version, so it installs and
 * starts as one would. Resolves once it has started.
 */
async function newVersion(page: Page, tag: string): Promise<void> {
  await page.evaluate(
    async (script) => {
      const registration = await navigator.serviceWorker.register(script, {
        scope: "/",
        type: "module",
      });
      const worker = registration.installing ?? registration.waiting ?? registration.active!;
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          if (worker.state === "activated") resolve();
          if (worker.state === "redundant") reject(new Error("the new worker did not install"));
        };
        worker.addEventListener("statechange", check);
        check();
      });
    },
    `/serwist/sw.js?${new URLSearchParams({ version: tag })}`,
  );
}

test.describe("what the device keeps for offline use", () => {
  test("the quick note, only ever opened from the bottom bar, takes a share with no network", async ({
    page,
    context,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the bottom bar is the phone's");
    await signUp(page);
    await openApp(page);
    await offlineReady(page);

    // Within the app, not a page load: kept only because the app asks for it.
    const bar = page.getByRole("navigation").filter({ visible: true }).last();
    await bar.getByRole("link", { name: "即席メモ" }).click();
    await expect(page.getByLabel("即席メモ")).toBeVisible();
    await expect.poll(async () => (await kept(page, SHELL, "/quick"))?.status).toBe(200);

    // Android's share sheet with no network: the quick note loaded with the text.
    await context.setOffline(true);
    const text = "圏外で共有した文章";
    await page.goto(`/quick?${new URLSearchParams({ text })}`);
    await expect(page.getByLabel("即席メモ")).toHaveValue(text);
  });

  test("a text shared into the quick note is kept nowhere on the device", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await offlineReady(page);

    const secret = unique();
    const text = `あとで読む ${secret}`;
    await page.goto(`/quick?${new URLSearchParams({ text })}`);
    await expect(page.getByLabel("即席メモ")).toHaveValue(text);
    // Whatever the worker would have kept of the load, it has by now.
    await page.waitForTimeout(1_000);
    expect(await holding(page, secret)).toEqual([]);
  });

  test("signing out forgets the account's pages and files, and keeps the app's own", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await offlineReady(page);
    await page.goto("/app/settings");
    await expect
      .poll(async () => (await kept(page, "memoca-pages", "/app/settings"))?.status)
      .toBe(200);
    // A file once shown: a stand-in will do. (The reading dictionary is
    // kept nowhere, so there is none to keep.)
    await page.evaluate(async () => {
      await (
        await caches.open("memoca-media")
      ).put("https://e2e.convex.cloud/api/storage/e2e", new Response("an image"));
    });

    await page.getByRole("button", { name: "ログアウト", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/");

    const left = await keptPages(page);
    expect(left.filter(({ address }) => /^\/(app|quick)\b/.test(address))).toEqual([]);
    expect(await page.evaluate(() => caches.has("memoca-media"))).toBe(false);
    const offlinePageKept = await page.evaluate(async () => {
      for (const name of await caches.keys()) {
        if (!name.includes("precache")) continue;
        for (const request of await (await caches.open(name)).keys()) {
          if (new URL(request.url).pathname === "/offline") return true;
        }
      }
      return false;
    });
    expect(offlinePageKept).toBe(true);
  });

  test("a new version fetches the shells kept again, as its own", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await offlineReady(page);
    await page.goto("/quick");
    await expect.poll(async () => (await kept(page, SHELL, "/quick"))?.status).toBe(200);
    // As an earlier version kept them, pointing to files the new one has not.
    await standInShells(page, "an earlier version's");

    await newVersion(page, "signed-in");
    expect(await kept(page, SHELL, "/app")).toEqual({ status: 200, title: "メモ · Memoca" });
    expect(await kept(page, SHELL, "/quick")).toEqual({ status: 200, title: "即席メモ · Memoca" });
  });

  test("opened signed out, a page is not kept as the way to sign in, nor does it replace a shell", async ({
    page,
  }) => {
    await page.goto("/");
    await workerInCharge(page);
    // What was kept while signed in: stand-ins, as signing in is not the point.
    await standInShells(page, "kept while signed in");

    for (const address of ["/app", "/quick", "/app/settings"]) {
      await page.goto(address);
      await expect(page).toHaveURL(/\/sign-in\?/);
    }
    // And asked to keep them, as after moving to them within the app.
    await askToKeep(page, ["/app", "/quick", "/app/settings"]);
    await page.waitForTimeout(1_000);

    for (const address of ["/app", "/quick"]) {
      expect((await kept(page, SHELL, address))?.title, address).toBe("kept while signed in");
    }
    expect((await keptPages(page)).filter(({ signIn }) => signIn)).toEqual([]);
  });

  test("nor is what was shared kept with the sign-in page it waits on", async ({ page }) => {
    await page.goto("/");
    await workerInCharge(page);

    const secret = unique();
    await page.goto(`/quick?${new URLSearchParams({ text: `あとで読む ${secret}` })}`);
    await expect(page).toHaveURL(/\/sign-in\?/);
    await expect(page.getByRole("button", { name: SIGN_IN })).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(await holding(page, secret)).toEqual([]);
  });

  test("with no network, a shell never kept opens the offline page", async ({ page, context }) => {
    await page.goto("/");
    await workerInCharge(page);

    await context.setOffline(true);
    await page.goto(`/quick?${new URLSearchParams({ text: "圏外で共有した文章" })}`);
    await expect(page.getByText("この画面はまだ端末に保存されていません")).toBeVisible();
  });

  test("a new version lets go of a shell that now sends to sign in, and of pages an earlier one kept", async ({
    page,
  }) => {
    await page.goto("/");
    await workerInCharge(page);
    await standInShells(page, "kept while signed in");
    // Where the default rules kept pages before: the sign-in page, with a share.
    await page.evaluate(async () => {
      await (
        await caches.open("others")
      ).put(
        "/sign-in?next=%2Fquick%3Ftext%3Dold",
        new Response("an earlier version's", { headers: { "Content-Type": "text/html" } }),
      );
    });

    await newVersion(page, "signed-out");
    expect(await kept(page, SHELL, "/app")).toBeNull();
    expect(await kept(page, SHELL, "/quick")).toBeNull();
    expect(await page.evaluate(() => caches.has("others"))).toBe(false);
  });

  test("a shell loaded is rendered by the server once", async ({ page, context }) => {
    await page.goto("/");
    await workerInCharge(page);

    // Beyond the navigation itself: the browser's preload of it, and anything
    // the worker would fetch again.
    const asked: string[] = [];
    context.on("request", (request) => {
      if (request.serviceWorker() && new URL(request.url()).pathname === "/app") {
        asked.push(request.headers()["service-worker-navigation-preload"] ? "preload" : "again");
      }
    });
    await page.goto("/app");
    await expect(page).toHaveURL(/\/sign-in\?/);
    expect(asked).toEqual(["preload"]);
  });
});
