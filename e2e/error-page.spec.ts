import { expect, test } from "@playwright/test";
import { openApp, signUp } from "./helpers";

test("a part of the app that cannot be loaded (a new version out meanwhile): said in Japanese, with a way to load the page again", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "once is enough");
  await signUp(page);
  await openApp(page);
  // The page's parts gone from the server, as after a new version went out.
  await page.route("**/_next/static/chunks/**", (route) => route.abort());
  // To a page not linked to anywhere, so not fetched ahead.
  await page.evaluate(() =>
    (window as unknown as { next: { router: { push: (url: string) => void } } }).next.router.push(
      "/app/admin",
    ),
  );
  // The page's own (Next's announcer of the page's title is another alert).
  const alert = page.locator("main[role=alert]");
  await expect(alert).toContainText("画面を表示できませんでした", { timeout: 15_000 });
  // What fails first may be the part itself or what needed it: either way
  // the page can be loaded again from here.
  await expect(alert.getByRole("button", { name: "読み込み直す" })).toBeVisible();
});
