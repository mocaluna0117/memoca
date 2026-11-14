import { expect, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, setExplorerMode, signUp, waitForSynced } from "./helpers";

/** Each block of the open note, by its type and text. */
const outline = (page: Page) =>
  editor(page)
    .locator("[data-content-type]")
    .evaluateAll((blocks) =>
      blocks.map((block) => `${block.getAttribute("data-content-type")}:${block.textContent ?? ""}`),
    );

/** Applies a template to the open note from its menu. */
async function apply(page: Page, name: string) {
  await page.getByRole("button", { name: "メモの操作" }).click();
  await page.getByRole("menuitem", { name: "テンプレートを適用" }).click();
  const dialog = page.getByRole("dialog", { name: "テンプレートから作成" });
  await dialog.getByRole("option", { name }).click();
  await expect(dialog).toBeHidden();
}

test.describe("in a note", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the note's menu and keys, on a computer");
    await signUp(page);
    await openApp(page);
  });

  test("a template applied: after what is written, the title kept; to an empty note, its title too", async ({
    page,
  }) => {
    await createNote(page, "定例会", "メモ書き");
    await apply(page, "議事録");
    await expect
      .poll(() => outline(page))
      .toEqual(expect.arrayContaining(["paragraph:メモ書き", "heading:日時・場所", "checkListItem:"]));
    expect((await outline(page))[0]).toBe("paragraph:メモ書き");
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("定例会");

    // Twice: there twice, no two blocks sharing an id.
    await apply(page, "議事録");
    await expect
      .poll(async () => (await outline(page)).filter((block) => block === "heading:日時・場所").length)
      .toBe(2);
    const ids = await editor(page)
      .locator(".bn-block-outer")
      .evaluateAll((blocks) => blocks.map((block) => block.getAttribute("data-id")));
    expect(new Set(ids).size).toBe(ids.length);

    // A note with nothing in it: the template's title, and no empty line before it.
    await createNote(page, "");
    await editor(page).click();
    await apply(page, "日記");
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("日記");
    await expect.poll(async () => (await outline(page))[0]).toBe("heading:今日のできごと");
    await waitForSynced(page);
  });

  test("pinned: a pin beside its title and on its row, taken off from the title's", async ({ page }) => {
    await setExplorerMode(page);
    await page.reload();
    await createNote(page, "大事なメモ");
    const pinned = page.getByRole("button", { name: "ピン留め中（押すと外します）" });
    await expect(pinned).toHaveCount(0);

    await page.getByRole("button", { name: "メモの操作" }).click();
    await page.getByRole("menuitem", { name: "ピン留め", exact: true }).click();
    await expect(pinned).toBeVisible();
    // On its row in the sidebar (Inbox, opened for it).
    await expect(page.locator("aside [data-tree-note]").filter({ hasText: "大事なメモ" })).toContainText(
      "ピン留め中",
    );

    await pinned.click();
    await expect(pinned).toHaveCount(0);
    await expect(page.locator("aside [data-tree-note]").filter({ hasText: "大事なメモ" })).not.toContainText(
      "ピン留め中",
    );
  });

  test("⌘F / Ctrl+F finds in the note: kana alike, Enter to the next, Escape leaves it selected", async ({
    page,
  }) => {
    await createNote(page, "果物", "りんごとみかん。それからリンゴ。");
    await editor(page).click();
    await page.keyboard.press("ControlOrMeta+f");
    const field = page.getByRole("textbox", { name: "メモ内を検索" });
    await expect(field).toBeFocused();
    await field.fill("りんご");
    await expect(page.locator(".memoca-find-match")).toHaveCount(2);
    await expect(page.getByRole("search", { name: "メモ内を検索" })).toContainText("1 / 2");
    await field.press("Enter");
    await expect(page.getByRole("search", { name: "メモ内を検索" })).toContainText("2 / 2");
    await field.press("Escape");
    await expect(page.getByRole("search", { name: "メモ内を検索" })).toHaveCount(0);
    await expect(page.locator(".memoca-find-match")).toHaveCount(0);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("リンゴ");
  });

  test("a match inside a closed toggle: the toggle opened, the match to be seen", async ({ page }) => {
    await createNote(page, "箱のメモ", "前置き");
    await editor(page).locator(".bn-block-content").last().click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/折りたたみリスト");
    await page.getByRole("option", { name: /^折りたたみリスト/ }).click();
    await expect(editor(page).locator('[data-content-type="toggleListItem"]')).toHaveCount(1);
    await page.keyboard.type("箱");
    const toggle = editor(page).locator('[data-content-type="toggleListItem"]');
    await toggle.locator(".bn-toggle-button").click();
    await toggle.locator(".bn-toggle-add-block-button").click();
    await page.keyboard.type("隠れた宝物");
    await toggle.locator(".bn-toggle-button").click();
    const wrapper = toggle.locator(".bn-toggle-wrapper");
    await expect(wrapper).toHaveAttribute("data-show-children", "false");

    await page.keyboard.press("ControlOrMeta+f");
    await page.getByRole("textbox", { name: "メモ内を検索" }).fill("宝物");
    await expect(wrapper).toHaveAttribute("data-show-children", "true");
    await expect(page.locator(".memoca-find-current")).toBeVisible();
  });
});
