import { expect, type Page, test } from "@playwright/test";
import { createNote, editor, folderPanel, hideFolders, openApp, showList, signUp, waitForSynced } from "./helpers";

/** Each block of the open note, by its type and text. */
const outline = (page: Page) =>
  editor(page)
    .locator("[data-content-type]")
    .evaluateAll((blocks) =>
      blocks.map((block) => `${block.getAttribute("data-content-type")}:${block.textContent ?? ""}`),
    );

/** Opens the template picker from the list's header. */
async function pick(page: Page, name: string) {
  await showList(page);
  await page.getByRole("button", { name: "テンプレートから作成" }).filter({ visible: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "テンプレートから作成" });
  await dialog.getByRole("option", { name }).click();
  await expect(dialog).toBeHidden();
}

test.describe("templates", () => {
  test("a note is made from one, its title and body, from the list's header; the folder made with a few", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await pick(page, "議事録");
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("議事録");
    await expect
      .poll(() => outline(page))
      .toEqual(expect.arrayContaining(["heading:日時・場所", "heading:参加者", "heading:やること", "checkListItem:"]));

    // The folder of them, below Inbox; not among every note's.
    const panel = await folderPanel(page);
    await expect(panel.getByRole("button", { name: "テンプレート", exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "すべてのメモ" }).click();
    await hideFolders(page);
    await showList(page);
    const rows = page.locator("[data-note-row]").filter({ visible: true });
    await expect(rows).toHaveCount(1);
  });

  test("a note kept as one, then used: from the list, and put into a note from the / menu", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "週報", "今週やったこと");
    await waitForSynced(page);
    await page.getByRole("button", { name: "メモの操作" }).filter({ visible: true }).click();
    await page.getByRole("menuitem", { name: "テンプレートとして保存" }).click();
    await expect(page.getByText("テンプレートとして保存しました")).toBeVisible();

    await pick(page, "週報");
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("週報");
    await expect(editor(page)).toContainText("今週やったこと");

    // Into another note, where the caret is.
    await createNote(page, "別のメモ");
    await editor(page).click();
    await page.keyboard.type("最初の行");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/週報");
    await expect(page.getByRole("option", { name: /週報/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect.poll(() => outline(page)).toEqual(["paragraph:最初の行", "paragraph:今週やったこと"]);
  });

  test("the folder of them cannot be locked, moved or trashed, and its notes are not locked", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await pick(page, "日記");
    const panel = await folderPanel(page);
    await panel.getByRole("button", { name: "テンプレート の操作" }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "名前を変更" })).toBeVisible();
    for (const item of ["ロックする…", "別のフォルダへ移動", "ゴミ箱に移動", "サブフォルダを追加"]) {
      await expect(menu.getByRole("menuitem", { name: item })).toHaveCount(0);
    }
    await page.keyboard.press("Escape");

    await panel.getByRole("button", { name: "テンプレート", exact: true }).click();
    await hideFolders(page);
    await page.locator("[data-note-row]").filter({ visible: true }).filter({ hasText: "日記" }).first().click();
    await page.getByRole("button", { name: "メモの操作" }).filter({ visible: true }).click();
    await expect(page.getByRole("menuitem", { name: "ロックする" })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "テンプレートとして保存" })).toBeDisabled();
  });
});
