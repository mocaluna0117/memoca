import { expect, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, signUp } from "./helpers";

const SITE = "https://example.com/opened";

/** A note with a link in it, to a site that answers here without the network. */
async function noteWithLink(page: Page) {
  await page
    .context()
    .route(`${SITE}**`, (route) =>
      route.fulfill({ contentType: "text/html", body: "<title>opened</title>ok" }),
    );
  await signUp(page);
  await openApp(page);
  await createNote(page, "リンク");
  await editor(page).click();
  // Written out, and made a link as the space follows it.
  await page.keyboard.type(`${SITE} `);
  const link = editor(page).locator('a[data-inline-content-type="link"]');
  await expect(link).toHaveAttribute("href", SITE);
  return link;
}

test.describe("a link in a note", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "a click and a toolbar to hover: a computer's");
  });

  test("clicked, opens in a window that has no hold on the app's", async ({ page }) => {
    const link = await noteWithLink(page);
    const opened = page.context().waitForEvent("page");
    await link.click();
    const other = await opened;
    await expect(other).toHaveURL(SITE);
    expect(await other.evaluate(() => window.opener)).toBeNull();
  });

  test("opened from its toolbar, the same", async ({ page }) => {
    const link = await noteWithLink(page);
    await link.hover();
    const opened = page.context().waitForEvent("page");
    await page.getByRole("button", { name: "新しいタブでリンクを開く" }).click();
    const other = await opened;
    await expect(other).toHaveURL(SITE);
    expect(await other.evaluate(() => window.opener)).toBeNull();
  });
});
