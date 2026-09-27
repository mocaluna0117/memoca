import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { offlineReady, openApp, signUp } from "./helpers";

const SHELL_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) MemocaShell/0.1.0 (macos)";
const STATE = "s".repeat(40) + "_-7";
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

/** Shell windows a test opened: closed after it, whether it passed or not. */
const opened: BrowserContext[] = [];

/** A window of the desktop shell: its user agent, and a stand-in for what it gives the page. */
async function shellWindow(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL,
    userAgent: SHELL_AGENT,
    viewport: { width: 420, height: 560 },
  });
  await context.addInitScript(() => {
    const calls: string[] = [];
    (window as unknown as { shellCalls: string[] }).shellCalls = calls;
    window.memocaShell = {
      hide: () => calls.push("hide"),
      openExternal: (url: string) => calls.push(`openExternal ${url}`),
      beginSignIn: () => calls.push("beginSignIn"),
      platform: "macos",
    };
  });
  opened.push(context);
  return { context, page: await context.newPage() };
}

test.describe("signing the desktop shell in", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the shell is a computer's");
  });

  test.afterEach(async () => {
    await Promise.all(opened.splice(0).map((context) => context.close()));
  });

  test("in the shell, sign-in is offered in the browser instead of with Google", async ({
    browser,
  }) => {
    const { page } = await shellWindow(browser);
    await page.goto("/sign-in");
    await expect(page.getByRole("button", { name: "Google でログイン" })).toHaveCount(0);
    await page.getByRole("button", { name: "ブラウザでログイン" }).click();
    expect(
      await page.evaluate(() => (window as unknown as { shellCalls: string[] }).shellCalls),
    ).toEqual(["beginSignIn"]);
  });

  test("the browser, signed in, hands the shell a code good for one sign-in", async ({
    page,
    browser,
  }) => {
    await signUp(page);
    await page.goto(`/desktop/handoff?${new URLSearchParams({ state: STATE })}`);
    await page.getByRole("button", { name: "Memoca に戻る" }).click();
    const code = (await page.locator("code").textContent())!.trim();
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);

    // Pasted into the shell, it signs the shell's window in, to the quick note.
    const shell = await shellWindow(browser);
    await shell.page.goto("/sign-in");
    await shell.page.getByLabel(/コードを貼り付け/).fill(` ${code}\n`);
    await shell.page.getByRole("button", { name: "ログイン", exact: true }).click();
    await expect(shell.page).toHaveURL(/\/quick\?window=1$/, { timeout: 20_000 });
    await expect(shell.page.getByLabel("即席メモ")).toBeVisible();

    // Once only.
    const again = await shellWindow(browser);
    await again.page.goto(`/desktop/complete#${new URLSearchParams({ token: code })}`);
    await expect(again.page.getByText("ログインできませんでした")).toBeVisible({ timeout: 20_000 });
  });

  test("nothing of it is kept on the device, not even by the service worker", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await offlineReady(page);
    await page.goto(`/desktop/handoff?${new URLSearchParams({ state: STATE })}`);
    await page.getByRole("button", { name: "Memoca に戻る" }).click();
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

  test("in the shell, a code of the wrong shape is turned away", async ({ browser }) => {
    const { page } = await shellWindow(browser);
    await page.goto("/desktop/complete#token=not-a-code");
    await expect(page.getByText("コードが正しくありません")).toBeVisible();
  });

  test("outside the shell, a code signs nothing in", async ({ page }) => {
    await page.goto(`/desktop/complete#${new URLSearchParams({ token: "a".repeat(32) })}`);
    await expect(page.getByText("デスクトップ版の Memoca の中でだけ使えます")).toBeVisible();
  });

  test("the browser signs in first when it has to, and only for a state of the shell's", async ({
    page,
  }) => {
    await page.goto(`/desktop/handoff?${new URLSearchParams({ state: STATE })}`);
    await expect(page).toHaveURL(/\/desktop\/sign-in\?/);
    const asked = page.waitForRequest("**/api/auth/sign-in/social");
    await page.route("**/api/auth/sign-in/social", (route) => route.abort());
    await page.getByRole("button", { name: "Google でログイン" }).click();
    expect((await asked).postDataJSON()).toMatchObject({
      callbackURL: `/desktop/handoff?${new URLSearchParams({ state: STATE })}`,
    });

    await page.goto("/desktop/sign-in?state=not-the-shells");
    await expect(page.getByText("このリンクは使えません")).toBeVisible();
  });
});
