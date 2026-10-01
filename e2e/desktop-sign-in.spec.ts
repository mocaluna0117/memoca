import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { offlineReady, openApp, signUp } from "./helpers";

const SHELL_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) MemocaShell/0.1.0 (macos)";
const STATE = "s".repeat(40) + "_-7";
const CHALLENGE = "c".repeat(40) + "-_0";
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3100";

/** Shell windows a test opened: closed after it, whether it passed or not. */
const opened: BrowserContext[] = [];

/**
 * A window of the desktop shell: its user agent, and a stand-in for what it
 * gives the page, which does as desktop/src-tauri/src/sign_in.rs does: a
 * sign-in started keeps its state and its verifier, sends the browser only
 * the challenge, and says the few letters the browser will show; a code
 * pasted in is taken with that verifier (which stays, for another try) by
 * sending the window to /desktop/complete, which is handed them once.
 */
async function shellWindow(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL,
    userAgent: SHELL_AGENT,
    viewport: { width: 420, height: 360 },
  });
  await context.addInitScript(() => {
    const calls: string[] = [];
    (window as unknown as { shellCalls: string[] }).shellCalls = calls;
    const base64url = (bytes: Uint8Array) =>
      btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
    const sha256 = async (text: string) =>
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    window.memocaShell = {
      hide: () => calls.push("hide"),
      openExternal: (url: string) => calls.push(`openExternal ${url}`),
      beginSignIn: async () => {
        const state = random();
        const verifier = random();
        const challenge = base64url(await sha256(verifier));
        localStorage.setItem("fake-shell", JSON.stringify({ state, verifier }));
        calls.push(`beginSignIn /desktop/sign-in?${new URLSearchParams({ state, challenge })}`);
        const hex = Array.from((await sha256(challenge)).slice(0, 4), (byte) =>
          byte.toString(16).padStart(2, "0"),
        )
          .join("")
          .toUpperCase();
        return `${hex.slice(0, 4)}-${hex.slice(4)}`;
      },
      completeSignIn: async (code: string) => {
        const started = JSON.parse(localStorage.getItem("fake-shell") ?? "null") as {
          verifier: string;
        } | null;
        if (!started) return "not-started";
        localStorage.setItem("fake-ready", JSON.stringify({ code, verifier: started.verifier }));
        // Where the shell sends its window: a whole address, as it is.
        location.assign(new URL("/desktop/complete", location.origin).href);
        return "ok";
      },
      takeSignIn: async () => {
        const ready = JSON.parse(localStorage.getItem("fake-ready") ?? "null") as {
          code: string;
          verifier: string;
        } | null;
        localStorage.removeItem("fake-ready");
        return ready;
      },
      platform: "macos",
    };
  });
  opened.push(context);
  return { context, page: await context.newPage() };
}

const shellCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { shellCalls: string[] }).shellCalls);

/** Starts signing in from the shell's window: the address it opens the browser at. */
async function beginInShell(page: Page): Promise<string> {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "ブラウザでログイン" }).click();
  let asked = "";
  await expect
    .poll(async () => {
      asked = (await shellCalls(page)).find((call) => call.startsWith("beginSignIn")) ?? "";
      return asked;
    })
    .not.toBe("");
  return asked.replace("beginSignIn ", "");
}

/** In the browser, signed in: has a code made for the shell, and reads it off the page. */
async function codeFor(page: Page, signIn: string): Promise<{ code: string; link: URL }> {
  await page.goto(signIn);
  await expect(page).toHaveURL(/\/desktop\/handoff\?/);
  await page.getByRole("button", { name: "デスクトップ版にログインする" }).click();
  const link = new URL(
    (await page
      .getByRole("link", { name: "デスクトップ版の Memoca を開く" })
      .getAttribute("href"))!,
  );
  // Shown only when asked for.
  await expect(page.locator("code")).toHaveCount(0);
  await page.getByRole("button", { name: "開かないときは、コードを表示" }).click();
  const code = (await page.locator("code").textContent())!.trim();
  return { code, link };
}

/** Pastes a code into the shell's sign-in screen. */
async function paste(page: Page, code: string) {
  await page.getByLabel(/コードを貼り付け/).fill(` ${code}\n`);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
}

test.describe("signing the desktop shell in", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the shell is a computer's");
  });

  test.afterEach(async () => {
    await Promise.all(opened.splice(0).map((context) => context.close()));
  });

  test("in the shell, sign-in is offered in the browser instead of with Google, in a window it fits", async ({
    browser,
  }) => {
    const { page } = await shellWindow(browser);
    await page.goto("/sign-in");
    await expect(page.getByRole("button", { name: "Google でログイン" })).toHaveCount(0);
    const fits = () =>
      page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight);
    expect(await fits()).toBe(true);
    const signIn = new URL(await beginInShell(page), baseURL);
    expect(signIn.pathname).toBe("/desktop/sign-in");
    expect(signIn.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signIn.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The browser is given the verifier's hash, never the verifier.
    expect(signIn.search).not.toContain("verifier");
    // The few letters the browser will show.
    await expect(page.getByRole("status")).toContainText(/[0-9A-F]{4}-[0-9A-F]{4}/);
    expect(await fits()).toBe(true);
    // And with a code turned away, still all in the window.
    await page.reload();
    await paste(page, "A".repeat(32));
    await expect(page.getByRole("alert")).toBeVisible();
    await expect.poll(fits).toBe(true);
  });

  test("the browser hands the shell a code for a session of its own, good once", async ({
    page,
    browser,
  }) => {
    const shell = await shellWindow(browser);
    const signIn = await beginInShell(shell.page);
    const check = (await shell.page.getByRole("status").textContent())!.match(
      /[0-9A-F]{4}-[0-9A-F]{4}/,
    )![0];
    await signUp(page);
    // The browser says which account, and shows the letters the shell does.
    await page.goto(signIn);
    await expect(page.getByText(/のアカウントで、デスクトップ版にログインします/)).toBeVisible();
    await expect(page.getByLabel(`確認用の文字 ${check}`)).toBeVisible();
    const { code, link } = await codeFor(page, signIn);
    expect(code).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(link.protocol).toBe("memoca:");
    expect(link.searchParams.get("code")).toBe(code);
    expect(link.searchParams.get("state")).toBe(new URL(signIn, baseURL).searchParams.get("state"));

    // Pasted into the shell that asked, it signs its window in, to the quick note.
    await paste(shell.page, code);
    await expect(shell.page).toHaveURL(/\/quick\?window=1$/, { timeout: 20_000 });
    await expect(shell.page.getByLabel("即席メモ")).toBeVisible();

    // Its own session: signing out in the browser leaves the shell signed in.
    await page.goto("/app/settings");
    await page.getByRole("button", { name: "ログアウト", exact: true }).click();
    await expect(page).toHaveURL(`${baseURL}/`, { timeout: 20_000 });
    await page.goto("/app");
    await expect(page).toHaveURL(/\/sign-in/, { timeout: 20_000 });
    await shell.page.reload();
    await expect(shell.page.getByLabel("即席メモ")).toBeVisible({ timeout: 20_000 });

    // Once only, even with its own verifier.
    const { verifier } = JSON.parse(
      (await shell.page.evaluate(() => localStorage.getItem("fake-shell")))!,
    ) as { verifier: string };
    const again = await shellWindow(browser);
    await again.page.goto("/sign-in");
    await again.page.evaluate(
      (ready) => localStorage.setItem("fake-ready", JSON.stringify(ready)),
      { code, verifier },
    );
    await again.page.goto("/desktop/complete");
    await expect(again.page.getByText("ログインできませんでした")).toBeVisible({ timeout: 20_000 });

    // Signed out from its menu: the window's own session goes, back to signing in.
    await shell.page.goto("/desktop/sign-out");
    await expect(shell.page).toHaveURL(/\/sign-in$/, { timeout: 20_000 });
    await shell.page.goto("/quick?window=1");
    await expect(shell.page).toHaveURL(/\/sign-in\?/, { timeout: 20_000 });
  });

  test("a code made for another shell's sign-in signs nothing in", async ({ page, browser }) => {
    const theirs = await shellWindow(browser);
    const mine = await shellWindow(browser);
    const signIn = await beginInShell(theirs.page);
    await beginInShell(mine.page);
    await signUp(page);
    const { code } = await codeFor(page, signIn);

    // Pasted into a shell that started a sign-in of its own: its verifier is not the code's.
    await mine.page.goto("/sign-in");
    await paste(mine.page, code);
    await expect(mine.page.getByText("ログインできませんでした")).toBeVisible({ timeout: 20_000 });
    // And the code is gone for the shell it was made for too.
    await theirs.page.goto("/sign-in");
    await paste(theirs.page, code);
    await expect(theirs.page.getByText("ログインできませんでした")).toBeVisible({
      timeout: 20_000,
    });
  });

  test("a code pasted into a shell that started no sign-in is turned away there", async ({
    browser,
  }) => {
    const { page } = await shellWindow(browser);
    await page.goto("/sign-in");
    await paste(page, "A".repeat(32));
    await expect(page.getByText("先に「ブラウザでログイン」を押して")).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test("nothing of it is kept on the device, not even by the service worker", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await offlineReady(page);
    await page.goto(
      `/desktop/handoff?${new URLSearchParams({ state: STATE, challenge: CHALLENGE })}`,
    );
    await page.getByRole("button", { name: "デスクトップ版にログインする" }).click();
    await page.getByRole("button", { name: "開かないときは、コードを表示" }).click();
    await expect(page.locator("code")).toBeVisible();
    const kept = await page.evaluate(async () => {
      const found: string[] = [];
      for (const name of await caches.keys()) {
        for (const request of await (await caches.open(name)).keys()) {
          if (new URL(request.url).pathname.startsWith("/desktop/"))
            found.push(`${name} ${request.url}`);
        }
      }
      return found;
    });
    expect(kept).toEqual([]);
  });

  test("in the shell, the page that takes a code, opened by anything but the shell, takes nothing", async ({
    browser,
  }) => {
    const { page } = await shellWindow(browser);
    await page.goto(`/desktop/complete#code=${"a".repeat(32)}&verifier=${"v".repeat(43)}`);
    await expect(page.getByText("続けるログインがありません")).toBeVisible();
  });

  test("outside the shell, the page that takes a code is not there", async ({ page }) => {
    await page.goto("/desktop/complete");
    await expect(page.getByText("デスクトップ版の Memoca の中でだけ使えます")).toBeVisible();
    await page.goto("/desktop/sign-out");
    await expect(page.getByText("デスクトップ版の Memoca の中でだけ使えます")).toBeVisible();
  });

  test("the browser signs in first when it has to, and only for a state and challenge of the shell's", async ({
    page,
  }) => {
    const request = new URLSearchParams({ state: STATE, challenge: CHALLENGE });
    await page.goto(`/desktop/handoff?${request}`);
    await expect(page).toHaveURL(/\/desktop\/sign-in\?/);
    const asked = page.waitForRequest("**/api/auth/sign-in/social");
    await page.route("**/api/auth/sign-in/social", (route) => route.abort());
    await page.getByRole("button", { name: "Google でログイン" }).click();
    expect((await asked).postDataJSON()).toMatchObject({
      callbackURL: `/desktop/handoff?${request}`,
    });

    for (const search of [
      `state=not-the-shells&challenge=${CHALLENGE}`,
      `state=${STATE}`,
      `state=${STATE}&challenge=short`,
    ]) {
      await page.goto(`/desktop/sign-in?${search}`);
      await expect(page.getByText("このリンクは使えません"), search).toBeVisible();
    }
  });
});
