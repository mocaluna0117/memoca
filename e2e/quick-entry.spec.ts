import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, signUp } from "./helpers";

/** The quick note's own window, opened by `action`. */
async function quickWindowFrom(
  context: BrowserContext,
  action: () => Promise<unknown>,
): Promise<Page> {
  const opened = context.waitForEvent("page");
  await action();
  const popup = await opened;
  await expect(popup).toHaveURL(/\/quick\?window=1$/);
  return popup;
}

const sidebarButton = (page: Page) =>
  page.locator("aside").getByRole("button", { name: "即席メモ" });

test.describe("opening the quick note on a computer", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "a computer's ways in; a phone has its bottom bar",
    );
  });

  test("from the sidebar, in a window of its own, whose note opens back in the app", async ({
    page,
    context,
  }) => {
    await signUp(page);
    await openApp(page);
    const popup = await quickWindowFrom(context, () => sidebarButton(page).click());
    const field = popup.getByLabel("即席メモ");
    await field.fill("サイドバーから");
    await field.press("Control+Enter");
    for (const window_ of [page, popup]) {
      await window_.evaluate(() => {
        (window as unknown as { stayed: boolean }).stayed = true;
      });
    }
    await popup.getByRole("button", { name: "メモを開く" }).click();

    // In the window it was opened from, rather than in the small one...
    await expect(page).toHaveURL(/\/app\?n=/);
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("サイドバーから");
    await expect(popup).toHaveURL(/\/quick\?window=1$/);
    // ...and without loading it again, which would close its vault; nor was
    // the small one loaded with it, once the app had answered.
    await popup.waitForTimeout(1_000);
    for (const window_ of [page, popup]) {
      expect(await window_.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(
        true,
      );
    }
    await expect(popup).toHaveURL(/\/quick\?window=1$/);
  });

  test("from ⌘K", async ({ page, context }) => {
    await signUp(page);
    await openApp(page);
    await quickWindowFrom(context, async () => {
      await page.keyboard.press("Control+k");
      await page.getByRole("option", { name: "即席メモ" }).click();
    });
  });

  test("with Q; again, the window already open comes forward as it is", async ({
    page,
    context,
  }) => {
    await signUp(page);
    await openApp(page);
    const popup = await quickWindowFrom(context, () => page.keyboard.press("q"));
    const field = popup.getByLabel("即席メモ");
    await field.fill("書きかけ");
    await popup.evaluate(() => {
      (window as unknown as { stayed: boolean }).stayed = true;
    });

    await page.keyboard.press("q");
    await page.waitForTimeout(500);
    expect(context.pages()).toHaveLength(2);
    // Not loaded again: what was being written is there, and so is the page.
    await expect(field).toHaveValue("書きかけ");
    expect(await popup.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(
      true,
    );
  });

  test("not with Q while typing into a note", async ({ page, context }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "キー");
    await editor(page).click();
    await page.keyboard.type("q");
    await expect(editor(page)).toContainText("q");
    await page.waitForTimeout(500);
    expect(context.pages()).toHaveLength(1);
  });

  test("where no window can be opened, as a page instead", async ({ page }) => {
    await page.addInitScript(() => {
      window.open = () => null;
    });
    await signUp(page);
    await openApp(page);
    await sidebarButton(page).click();
    await expect(page).toHaveURL(/\/quick$/);
    await expect(page.getByLabel("即席メモ")).toBeVisible();
  });
});
