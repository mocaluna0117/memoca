import { expect, type Page, test } from "@playwright/test";
import { openApp, signUp } from "./helpers";

const WINDOW = "popup,width=380,height=460";

const field = (page: Page) => page.getByLabel("即席メモ", { exact: true });
const tabs = (page: Page) => page.getByRole("tab");
const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });

/** Opens a tab with + and writes in it. */
async function newTab(page: Page, text: string) {
  await page.getByRole("button", { name: "新しいタブ" }).click();
  await expect(field(page)).toHaveValue("");
  await field(page).fill(text);
}

test.describe("the quick note's tabs, in a window of its own", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "a window of its own, on a computer");
  });

  test("each its own draft, named by its first line, kept as they are switched and when the window opens again", async ({
    page,
    context,
  }) => {
    await signUp(page);
    await openApp(page);
    const opened = context.waitForEvent("page");
    await page.evaluate((features) => window.open("/quick?window=1", "memoca-quick", features), WINDOW);
    const quick = await opened;
    await field(quick).fill("買い物\n牛乳");
    await expect(tab(quick, "買い物")).toHaveAttribute("aria-selected", "true");
    await newTab(quick, "電話する");
    await newTab(quick, "アイデア");
    await expect(tabs(quick)).toHaveText(["買い物", "電話する", "アイデア"]);

    await tab(quick, "買い物").click();
    await expect(field(quick)).toHaveValue("買い物\n牛乳");

    // Put away and opened again: every tab back.
    const closed = quick.waitForEvent("close");
    await field(quick).press("Escape");
    await closed;
    const again = context.waitForEvent("page");
    await page.evaluate((features) => window.open("/quick?window=1", "memoca-quick", features), WINDOW);
    const reopened = await again;
    await expect(tabs(reopened)).toHaveText(["買い物", "電話する", "アイデア"]);
    await tab(reopened, "アイデア").click();
    await expect(field(reopened)).toHaveValue("アイデア");

    // Fits the window: the tabs scroll, the page does not.
    expect(
      await reopened.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

  test("a tab saved is closed, the next shown saying so; the last stays, emptied", async ({ page }) => {
    await signUp(page);
    await page.goto("/quick?window=1");
    await field(page).fill("一つ目");
    await newTab(page, "二つ目");
    await field(page).press("ControlOrMeta+Enter");
    await expect(tabs(page)).toHaveText(["一つ目"]);
    await expect(field(page)).toHaveValue("一つ目");
    await expect(page.getByRole("status")).toContainText("保存しました");

    await field(page).press("ControlOrMeta+Enter");
    await expect(tabs(page)).toHaveText(["新しいメモ"]);
    await expect(field(page)).toHaveValue("");
    await expect(page.getByRole("status")).toContainText("保存しました");

    // Both in Inbox.
    await page.goto("/app");
    await expect(page.locator("[data-note-row]").filter({ hasText: "一つ目" }).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator("[data-note-row]").filter({ hasText: "二つ目" }).first()).toBeVisible();
  });

  test("closed with something in it, asked first: kept, let go of, or saved", async ({ page }) => {
    await signUp(page);
    await page.goto("/quick?window=1");
    await field(page).fill("一つ目");
    await newTab(page, "二つ目");
    const dialog = page.getByRole("alertdialog");

    await page.getByRole("button", { name: "二つ目 のタブを閉じる" }).click();
    await expect(dialog).toContainText("「二つ目」は、まだ保存していません");
    // Esc closes the question, not the window.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(tabs(page)).toHaveText(["一つ目", "二つ目"]);

    await page.getByRole("button", { name: "二つ目 のタブを閉じる" }).click();
    await dialog.getByRole("button", { name: "保存せずに閉じる" }).click();
    await expect(tabs(page)).toHaveText(["一つ目"]);

    await newTab(page, "三つ目");
    await page.getByRole("button", { name: "三つ目 のタブを閉じる" }).click();
    await dialog.getByRole("button", { name: "保存して閉じる" }).click();
    await expect(tabs(page)).toHaveText(["一つ目"]);
    await expect(page.getByRole("status")).toContainText("保存しました");

    await page.goto("/app");
    await expect(page.locator("[data-note-row]").filter({ hasText: "三つ目" }).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator("[data-note-row]").filter({ hasText: "二つ目" })).toHaveCount(0);
  });
});

test.describe("the quick note's tabs, on a phone", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the page of a phone");
  });

  test("tabs as on a computer; saved, the note opens, the tab gone", async ({ page }) => {
    await signUp(page);
    await page.goto("/quick");
    await field(page).fill("一つ目");
    await newTab(page, "二つ目");
    await expect(tabs(page)).toHaveText(["一つ目", "二つ目"]);
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page).toHaveURL(/\/app\?n=/);

    await page.goto("/quick");
    await expect(tabs(page)).toHaveText(["一つ目"]);
    await expect(field(page)).toHaveValue("一つ目");
  });

  test("what is shared goes into a tab of its own, the draft left as it is", async ({ page }) => {
    await signUp(page);
    await page.goto("/quick");
    await field(page).fill("書きかけ");
    // Written before the share arrives.
    await page.waitForTimeout(800);
    await page.goto(`/quick?${new URLSearchParams({ text: "共有された文" })}`);
    await expect(field(page)).toHaveValue("共有された文");
    await expect(tabs(page)).toHaveText(["書きかけ", "共有された文"]);
  });
});
