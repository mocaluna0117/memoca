import { expect, type Page, test } from "@playwright/test";
import { folderPanel, hideFolders, openApp, setExplorerMode, signUp, waitForSynced } from "./helpers";

/** A folder's row in the sidebar on screen, by its name. */
const folderRow = (page: Page, name: string) =>
  page.locator("[data-folder-row]").filter({ visible: true }).filter({ hasText: name });
/** A note's row in the sidebar's tree on screen, by its name. */
const treeNote = (page: Page, name: string) =>
  page.locator("[data-tree-note]").filter({ visible: true }).filter({ hasText: name });

/** A new folder at the top level, named. */
async function newFolder(page: Page, name: string) {
  const panel = await folderPanel(page);
  await panel.getByRole("button", { name: "フォルダを追加" }).click();
  await panel.getByRole("button", { name: "新しいフォルダ の操作" }).click();
  await page.getByRole("menuitem", { name: "名前を変更" }).click();
  const field = page.getByRole("dialog", { name: "フォルダ名を変更" }).getByRole("textbox");
  await field.fill(name);
  await field.press("Enter");
  await expect(folderRow(page, name)).toBeVisible();
}

/** A new note in a folder, from the sidebar, titled. */
async function newNoteIn(page: Page, folder: string, title: string) {
  const panel = await folderPanel(page);
  await panel.getByRole("button", { name: `${folder} に新しいメモ` }).click();
  const titleField = page.getByLabel("メモのタイトル");
  await expect(titleField).toHaveValue("");
  await titleField.fill(title);
  await page.waitForTimeout(1_500);
}

test.describe("folders' notes in the sidebar", () => {
  test.beforeEach(async ({ page }) => {
    await signUp(page);
    await setExplorerMode(page);
    await openApp(page);
  });

  test("a folder's notes are inside it, opened from there, with no list beside", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "the sidebar beside the note");
    await newFolder(page, "仕事");
    await newNoteIn(page, "仕事", "議事録");

    // Opened, and shown in its folder, opened for it.
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("議事録");
    await expect(treeNote(page, "議事録")).toBeVisible();
    await expect(page.locator("#note-list-pane")).toBeHidden();

    // The folder's row closes it, and opens it again, leaving the note open.
    await folderRow(page, "仕事").click();
    await expect(treeNote(page, "議事録")).toBeHidden();
    await folderRow(page, "仕事").click();
    await expect(treeNote(page, "議事録")).toBeVisible();
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("議事録");

    // Another note of the folder, opened from the tree.
    await newNoteIn(page, "仕事", "予定");
    await treeNote(page, "議事録").click();
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("議事録");
    await waitForSynced(page);
  });

  test("on a phone, in the drawer: a folder opens in place, a note closes it", async ({ page }) => {
    test.skip(test.info().project.name !== "mobile", "the drawer");
    await newFolder(page, "仕事");
    // The new note opened, the drawer closed.
    await newNoteIn(page, "仕事", "議事録");
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);

    // Back in the drawer, the note in its folder; the folder's row closes it
    // there, the drawer staying open.
    await folderPanel(page);
    await expect(treeNote(page, "議事録")).toBeVisible();
    await folderRow(page, "仕事").click();
    await expect(treeNote(page, "議事録")).toBeHidden();
    await folderRow(page, "仕事").click();
    await treeNote(page, "議事録").click();
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("議事録");
    await hideFolders(page);
  });

  test("one folder open at a time: another opened, the one open closes", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "the sidebar beside the note");
    await newFolder(page, "仕事");
    await newNoteIn(page, "仕事", "議事録");
    await newFolder(page, "趣味");
    await newNoteIn(page, "趣味", "釣り");

    // 趣味 opened for its new note, 仕事 closed.
    await expect(treeNote(page, "釣り")).toBeVisible();
    await expect(treeNote(page, "議事録")).toBeHidden();

    await folderRow(page, "仕事").click();
    await expect(treeNote(page, "議事録")).toBeVisible();
    await expect(treeNote(page, "釣り")).toBeHidden();
    // The note open stays open.
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("釣り");
  });

  test("notes chosen in the tree with ⌘/Ctrl, moved together by the bar", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "a click with ⌘/Ctrl");
    await newFolder(page, "趣味");
    await newFolder(page, "仕事");
    await newNoteIn(page, "仕事", "一");
    await newNoteIn(page, "仕事", "二");
    await newNoteIn(page, "仕事", "三");

    await treeNote(page, "一").click({ modifiers: ["ControlOrMeta"] });
    await treeNote(page, "三").click({ modifiers: ["ControlOrMeta"] });
    const bar = page.getByRole("toolbar", { name: "選択したメモ" });
    await expect(bar).toContainText("2 件を選択");
    await bar.getByRole("button", { name: "移動" }).click();
    await expect(page.getByRole("dialog", { name: "2 件のメモを移動" })).toBeVisible();
    await page.getByRole("dialog").getByRole("option", { name: /趣味/ }).click();

    // Moved, none chosen; 趣味, where the note open (三) now is, opened to
    // show it, with 一; 二 left in 仕事, closed.
    await expect(bar).toHaveCount(0);
    await expect(treeNote(page, "一")).toBeVisible();
    await expect(treeNote(page, "三")).toBeVisible();
    await expect(treeNote(page, "二")).toBeHidden();
  });

  test("notes chosen in the tree: Escape with nothing focused stops choosing, as after a click in Safari", async ({
    page,
  }) => {
    test.skip(test.info().project.name !== "desktop", "a click with ⌘/Ctrl");
    await newFolder(page, "仕事");
    await newNoteIn(page, "仕事", "一");
    await newNoteIn(page, "仕事", "二");
    await treeNote(page, "一").click({ modifiers: ["ControlOrMeta"] });
    await treeNote(page, "二").click({ modifiers: ["ControlOrMeta"] });
    const bar = page.getByRole("toolbar", { name: "選択したメモ" });
    await expect(bar).toContainText("2 件を選択");
    // Safari focuses no button it clicks: focus is then nowhere.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);
  });

  test("a folder's menu sets its notes' order, and makes a note from a template", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "the sidebar beside the note");
    await newFolder(page, "仕事");
    await newNoteIn(page, "仕事", "い");
    await newNoteIn(page, "仕事", "あ");
    await newNoteIn(page, "仕事", "う");
    const names = () =>
      page.locator("aside [data-tree-note]").filter({ visible: true }).allTextContents();

    await page.locator("aside").getByRole("button", { name: "仕事 の操作" }).click();
    await page.getByRole("menuitem", { name: "並び順" }).click();
    await page.getByRole("menuitemradio", { name: "タイトル順" }).click();
    await expect.poll(async () => (await names()).map((name) => name.slice(0, 1))).toEqual(["あ", "い", "う"]);
    await expect(page.getByRole("menu")).toHaveCount(0);

    await page.locator("aside").getByRole("button", { name: "仕事 の操作" }).click();
    await page.getByRole("menuitem", { name: "テンプレートから作成" }).click();
    const dialog = page.getByRole("dialog", { name: "テンプレートから作成" });
    await dialog.getByRole("option", { name: "議事録" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("議事録");
    await expect(treeNote(page, "議事録")).toBeVisible();
  });

  test("a folder's notes placed by hand in the tree: dragged, and by Option and the arrows", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "dragged with a mouse");
    await newFolder(page, "仕事");
    for (const title of ["い", "あ", "う"]) await newNoteIn(page, "仕事", title);
    const names = async () =>
      (await page.locator("aside [data-tree-note]").filter({ visible: true }).allTextContents()).map(
        (name) => name.slice(0, 1),
      );
    // By hand until chosen: as made, the newest first.
    await expect.poll(names).toEqual(["う", "あ", "い"]);

    /** Drags a note's row to a point, in steps, as a mouse does. */
    const drag = async (name: string, to: { x: number; y: number }) => {
      const from = (await treeNote(page, name).boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 12 });
      await page.mouse.up();
    };

    // The last, above the first.
    const first = (await treeNote(page, "う").boundingBox())!;
    await drag("い", { x: first.x + first.width / 2, y: first.y });
    await expect.poll(names).toEqual(["い", "う", "あ"]);

    // The second, below the last.
    const last = (await treeNote(page, "あ").boundingBox())!;
    await drag("う", { x: last.x + last.width / 2, y: last.y + last.height + 1 });
    await expect.poll(names).toEqual(["い", "あ", "う"]);

    // By the keys: up one, focus kept on it.
    await treeNote(page, "う").focus();
    await page.keyboard.press("Alt+ArrowUp");
    await expect.poll(names).toEqual(["い", "う", "あ"]);
    await expect(treeNote(page, "う")).toBeFocused();

    // Ordered otherwise, not placed: said why.
    await page.locator("aside").getByRole("button", { name: "仕事 の操作" }).click();
    await page.getByRole("menuitem", { name: "並び順" }).click();
    await page.getByRole("menuitemradio", { name: "タイトル順" }).click();
    await expect.poll(names).toEqual(["あ", "い", "う"]);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await treeNote(page, "う").focus();
    await page.keyboard.press("Alt+ArrowUp");
    await expect(page.getByText("並べ替えは、並び順が「手動」のフォルダでできます", { exact: false })).toBeVisible();
    await expect.poll(names).toEqual(["あ", "い", "う"]);
  });

  test("all notes are still a list beside the sidebar", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "the list beside the sidebar");
    await newFolder(page, "趣味");
    await newNoteIn(page, "趣味", "釣り");
    await expect(page.locator("#note-list-pane")).toBeHidden();

    await page.locator("aside").getByRole("button", { name: "すべてのメモ" }).click();
    const list = page.locator("#note-list-pane");
    await expect(list).toBeVisible();
    await list.locator("[data-note-row]").filter({ hasText: "釣り" }).click();
    // Opened from the list, which stays.
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("釣り");
    await expect(list).toBeVisible();
  });

  test("set back to the list beside the sidebar in the settings", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "the list beside the sidebar");
    await newFolder(page, "旅行");
    await newNoteIn(page, "旅行", "持ち物");

    await page.goto("/app/settings");
    await page.getByRole("combobox", { name: "フォルダのメモ" }).click();
    await page.getByRole("option", { name: "横の一覧に表示" }).click();
    await page.goto("/app");

    // The folder's notes are no longer in the tree: in the list, once it is chosen.
    await expect(folderRow(page, "旅行")).toBeVisible();
    await expect(treeNote(page, "持ち物")).toHaveCount(0);
    await folderRow(page, "旅行").click();
    await expect(
      page.locator("#note-list-pane [data-note-row]").filter({ hasText: "持ち物" }),
    ).toBeVisible();
  });
});
