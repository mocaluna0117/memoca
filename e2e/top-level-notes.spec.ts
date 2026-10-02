import { expect, type Locator, type Page, test } from "@playwright/test";
import { readTable } from "./local-db";
import {
  createNote,
  folderPanel,
  hideFolders,
  openApp,
  showList,
  signUp,
  waitForSynced,
} from "./helpers";

/** A note kept in the sidebar, by its row's button. */
const sidebarNote = (panel: Locator, name: string) =>
  panel.locator("[data-tree-note]").filter({ hasText: name });

/** The rows of the sidebar's tree, folders and notes, top to bottom. */
const treeRows = (panel: Locator) =>
  panel
    .locator("[data-folder-row], [data-tree-note]")
    .evaluateAll((rows) => rows.map((row) => row.querySelector(".truncate")?.textContent));

/** Adds a top-level folder and names it, with the keyboard. */
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

/** Makes a note in the sidebar, from its button, and names it. */
async function addSidebarNote(page: Page, title: string) {
  const panel = await folderPanel(page);
  await panel.getByRole("button", { name: "メモを追加" }).click();
  const field = page.getByLabel("メモのタイトル");
  await expect(field).toHaveValue("");
  await field.fill(title);
  await expect(sidebarNote(await folderPanel(page), title)).toBeVisible();
  await hideFolders(page);
}

/** Where a note is, in this device's database. */
const folderOf = async (page: Page, title: string) =>
  (await readTable<{ title: string; folderId: string | null }>(page, "notes")).find(
    (note) => note.title === title,
  )?.folderId;

test.describe("notes kept in the sidebar, in no folder", () => {
  test("one made there is among the folders, opens from there, and stays there", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await addFolder(page, "仕事");
    await addSidebarNote(page, "よく使うメモ");
    expect(await folderOf(page, "よく使うメモ")).toBeNull();
    // After the folders there were when it was made.
    expect(await treeRows(await folderPanel(page))).toEqual(["Inbox", "仕事", "よく使うメモ"]);
    await hideFolders(page);

    // Synced, and read again: still there, not filed in Inbox.
    await waitForSynced(page);
    await page.reload();
    await showList(page);
    const panel = await folderPanel(page);
    await sidebarNote(panel, "よく使うメモ").click();
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("よく使うメモ");
    expect(await folderOf(page, "よく使うメモ")).toBeNull();
    await hideFolders(page);
  });

  test("a note is moved there from its menu, and back into a folder from the sidebar's", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "買い物リスト");
    await page.getByRole("button", { name: "メモの操作" }).filter({ visible: true }).click();
    await page.getByRole("menuitem", { name: "移動" }).click();
    await page.getByRole("option", { name: /いちばん上の階層/ }).click();
    await expect(sidebarNote(await folderPanel(page), "買い物リスト")).toBeVisible();
    expect(await folderOf(page, "買い物リスト")).toBeNull();

    const panel = await folderPanel(page);
    await panel.getByRole("button", { name: "買い物リスト の操作" }).click();
    await page.getByRole("menuitem", { name: "移動" }).click();
    await page.getByRole("option", { name: "Inbox" }).click();
    await expect(sidebarNote(await folderPanel(page), "買い物リスト")).toHaveCount(0);
    expect(await folderOf(page, "買い物リスト")).not.toBeNull();
  });

  test("dragged: into a folder, out of the list to the top level, and placed among the folders by the keys", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "a mouse");
    await signUp(page);
    await openApp(page);
    await addFolder(page, "仕事");
    await addFolder(page, "趣味");
    await addSidebarNote(page, "置いたメモ");
    const panel = page.locator("aside");
    expect(await treeRows(panel)).toEqual(["Inbox", "仕事", "趣味", "置いたメモ"]);

    // Up past 趣味 with Option (Alt) and the arrow, as a folder is.
    await sidebarNote(panel, "置いたメモ").focus();
    await page.keyboard.press("Alt+ArrowUp");
    await expect.poll(() => treeRows(panel)).toEqual(["Inbox", "仕事", "置いたメモ", "趣味"]);

    // Into 仕事, by a drag.
    await drag(page, sidebarNote(panel, "置いたメモ"), panel.getByRole("button", { name: "仕事", exact: true }));
    await expect.poll(() => treeRows(panel)).toEqual(["Inbox", "仕事", "趣味"]);

    // And out again, from 仕事's list, onto the top level.
    await panel.getByRole("button", { name: "仕事", exact: true }).click();
    const listRow = page.locator("[data-note-row]").filter({ hasText: "置いたメモ" });
    await drag(page, listRow, panel.getByText("いちばん上の階層へ移動"));
    await expect.poll(() => treeRows(panel)).toEqual(["Inbox", "仕事", "趣味", "置いたメモ"]);
    await expect(listRow).toHaveCount(0);
  });

  test("on a phone, one is opened from the folders, which close", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "a phone's folder drawer");
    await signUp(page);
    await openApp(page);
    await addSidebarNote(page, "電話のメモ");
    await showList(page);
    const panel = await folderPanel(page);
    await sidebarNote(panel, "電話のメモ").click();
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("電話のメモ");
  });
});

/**
 * Drags with the mouse from one thing onto another: the other found once
 * the drag has started, as some targets are shown only then.
 */
async function drag(page: Page, from: Locator, to: Locator) {
  const start = (await from.boundingBox())!;
  await page.mouse.move(start.x + 20, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 20, start.y + start.height / 2 + 12, { steps: 4 });
  const end = (await to.boundingBox())!;
  await page.mouse.move(end.x + 20, end.y + end.height / 2, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(100);
}
