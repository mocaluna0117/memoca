import { expect, type Page, test } from "@playwright/test";
import {
  editor,
  expectQuickText,
  folderPanel,
  hideFolders,
  openApp,
  quickField,
  signUp,
  writeQuick,
} from "./helpers";
import { readTable } from "./local-db";

/** Adds a top-level folder and names it, with the keyboard, as in VS Code. */
async function addFolder(page: Page, name: string) {
  const panel = await folderPanel(page);
  await panel.getByRole("button", { name: "フォルダを追加" }).click();
  await panel.getByRole("button", { name: "新しいフォルダ", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("button", { name, exact: true })).toBeVisible();
  await hideFolders(page);
}

const chip = (page: Page) => page.getByRole("button", { name: /^フォルダを選ぶ/ });

test.describe("the quick note, written as a note is", () => {
  test("a list, a check and a heading, as typed, go into the note as they are", async ({ page }) => {
    await signUp(page);
    await page.goto("/quick");
    const field = quickField(page);
    await field.click();
    await page.keyboard.type("- 牛乳");
    await page.keyboard.press("Enter");
    await page.keyboard.type("卵");
    // An empty item's Enter ends the list.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("[] 電話する");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("## 予定");
    await expect(field.locator('[data-content-type="bulletListItem"]')).toHaveCount(2);
    await expect(field.locator('[data-content-type="checkListItem"]')).toHaveCount(1);
    await expect(field.locator('[data-content-type="heading"]')).toHaveText("予定");

    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page).toHaveURL(/\/app\?n=/);
    const note = editor(page);
    await expect(note.locator('[data-content-type="bulletListItem"]')).toHaveText(["牛乳", "卵"]);
    await expect(note.locator('[data-content-type="checkListItem"]')).toHaveText("電話する");
    await expect(note.locator('[data-content-type="heading"]')).toHaveText("予定");
  });

  test("the / menu turns the line, and offers no files: images go in the strip below", async ({
    page,
  }) => {
    await signUp(page);
    await page.goto("/quick?window=1");
    const field = quickField(page);
    await writeQuick(field, "やること");
    await page.keyboard.type("/");
    const menu = page.getByRole("listbox");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("option", { name: /^画像/ })).toHaveCount(0);
    await page.keyboard.type("checklist");
    await page.keyboard.press("Enter");
    await expect(field.locator('[data-content-type="checkListItem"]')).toHaveText("やること");
    // Esc with the menu open closes the menu, not the window.
    await page.keyboard.type("/");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(field).toBeVisible();
  });

  test("written in, then put away and opened again, its list is still a list", async ({ page }) => {
    await signUp(page);
    await page.goto("/quick");
    await quickField(page).click();
    await page.keyboard.type("- 下書きの項目");
    // Written into the draft once typing pauses.
    await page.waitForTimeout(800);
    await page.reload();
    await expectQuickText(quickField(page), "下書きの項目");
    await expect(quickField(page).locator('[data-content-type="bulletListItem"]')).toHaveCount(1);
  });
});

test.describe("the quick note's folder", () => {
  test("chosen, is saved into, said so, and kept for the next time", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the folder panel is set up from a computer's");
    await signUp(page);
    await openApp(page);
    await addFolder(page, "仕事");

    await page.goto("/quick?window=1");
    await expect(chip(page)).toHaveText("Inbox");
    await chip(page).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("即席メモを保存するフォルダ");
    // Neither the templates' folder nor the days' is offered.
    await expect(dialog.getByRole("option", { name: "テンプレート" })).toHaveCount(0);
    await dialog.getByRole("option", { name: "仕事" }).click();
    await expect(chip(page)).toHaveText("仕事");
    // Back to writing, the caret in the editor.
    await expect(quickField(page)).toBeFocused();

    await writeQuick(quickField(page), "仕事のメモ");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(page.getByRole("status")).toContainText("仕事 に保存しました");
    const folders = await readTable<{ folderId: string; name: string | null }>(page, "folders");
    const work = folders.find((folder) => folder.name === "仕事")!;
    const notes = await readTable<{ folderId: string | null; preview?: string }>(page, "notes");
    expect(notes.filter((note) => note.folderId === work.folderId)).toHaveLength(1);

    await page.reload();
    await expect(chip(page)).toHaveText("仕事");
  });
});
