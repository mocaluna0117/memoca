import { expect, type Locator, type Page, test } from "@playwright/test";
import { createNote, folderPanel, hideFolders, openApp, showList, signUp } from "./helpers";
import { createVaultInSettings, enterVaultPassword } from "./vault-helpers";

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

async function openFolder(page: Page, name: string) {
  const panel = await folderPanel(page);
  await panel
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .first()
    .click();
  await hideFolders(page);
}

/** A note's row in the list on screen. */
const row = (page: Page, name: string) =>
  page.locator("[data-note-row]").filter({ visible: true }).filter({ hasText: name });

/** The names in the list, top to bottom. */
const names = (page: Page) =>
  page
    .locator("[data-note-row]")
    .filter({ visible: true })
    .evaluateAll((rows) => rows.map((each) => each.querySelector(".truncate")?.textContent));

/** A message in a toast. */
const toast = (page: Page, text: string) =>
  page.locator("[data-sonner-toast]").getByText(text, { exact: true });

const chooser = (page: Page) => page.getByRole("toolbar", { name: "選択したメモ" });

/** Notes made in Inbox, a folder 仕事 beside it, and Inbox's list on screen. */
async function inInbox(page: Page, notes: string[]) {
  await signUp(page);
  await openApp(page);
  await addFolder(page, "仕事");
  await openFolder(page, "Inbox");
  for (const note of notes) await createNote(page, note);
  await showList(page);
  for (const note of notes) await expect(row(page, note)).toBeVisible();
}

/**
 * Drags with the mouse from one thing onto another, `during` while it is
 * held there: the other found once the drag has started, as some targets
 * are shown only then.
 */
async function drag(page: Page, from: Locator, to: Locator, during?: () => Promise<void>) {
  const start = (await from.boundingBox())!;
  await page.mouse.move(start.x + 40, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + 40, start.y + start.height / 2 + 12, { steps: 4 });
  const end = (await to.boundingBox())!;
  await page.mouse.move(end.x + 20, end.y + end.height / 2, { steps: 15 });
  await during?.();
  await page.mouse.up();
  // dnd-kit takes a click for 50 ms after a drag, as the end of it.
  await page.waitForTimeout(100);
}

/** A folder's row in the sidebar. */
const folderRow = (page: Page, name: string) =>
  page.locator("aside").getByRole("button", { name, exact: true });

test.describe("moving notes, on a computer", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "a mouse");
  });

  test("a note dragged from the list onto a folder in the sidebar goes there", async ({ page }) => {
    await inInbox(page, ["一"]);
    await drag(page, row(page, "一"), folderRow(page, "仕事"), async () => {
      // Its name follows the pointer, and the folder shows it is where it goes.
      await expect(page.getByText("一", { exact: true })).toHaveCount(2);
      await expect(page.locator("aside .ring-2")).toHaveCount(1);
    });
    await expect(toast(page, "移動しました")).toBeVisible();
    await expect(row(page, "一")).toHaveCount(0);
    await openFolder(page, "仕事");
    await expect(row(page, "一")).toBeVisible();
  });

  test("notes chosen with ⌘/Ctrl or Shift and a click are dragged together, in their order", async ({
    page,
  }) => {
    await inInbox(page, ["一", "二", "三"]);
    const [first, middle, last] = (await names(page)) as [string, string, string];
    await row(page, first).click({ modifiers: ["ControlOrMeta"] });
    await expect(chooser(page)).toContainText("1 件を選択");
    await row(page, last).click({ modifiers: ["Shift"] });
    await expect(chooser(page)).toContainText("3 件を選択");
    await row(page, middle).click({ modifiers: ["ControlOrMeta"] });
    await expect(chooser(page)).toContainText("2 件を選択");
    await expect(row(page, middle)).toHaveAttribute("aria-pressed", "false");

    await drag(page, row(page, last), folderRow(page, "仕事"), async () => {
      await expect(page.getByText("2 件のメモ", { exact: true })).toBeVisible();
    });
    await expect(toast(page, "2 件のメモを移動しました")).toBeVisible();
    await expect(chooser(page)).toHaveCount(0);
    await expect.poll(() => names(page)).toEqual([middle]);
    await openFolder(page, "仕事");
    // As they were last changed, which moving them does not change.
    await expect.poll(() => names(page)).toEqual([first, last]);
    // First in the folder, placed by hand, in the order they were in.
    await page.getByRole("button", { name: /^並び順/ }).click();
    await page.getByRole("menuitemradio", { name: "手動" }).click();
    await expect.poll(() => names(page)).toEqual([first, last]);
  });

  test("a row's menu, by a right click, moves it, or those chosen with it", async ({ page }) => {
    await inInbox(page, ["一", "二", "三"]);
    await row(page, "一").click({ button: "right" });
    await page.getByRole("menuitem", { name: "移動…" }).click();
    await expect(page.getByRole("dialog", { name: "メモを移動" })).toBeVisible();
    await page.getByRole("dialog").getByRole("option", { name: /仕事/ }).click();
    await expect(toast(page, "移動しました")).toBeVisible();
    await expect(row(page, "一")).toHaveCount(0);

    await row(page, "二").click({ modifiers: ["ControlOrMeta"] });
    await row(page, "三").click({ modifiers: ["ControlOrMeta"] });
    await row(page, "三").click({ button: "right" });
    await page.getByRole("menuitem", { name: "2 件のメモを移動…" }).click();
    await expect(page.getByRole("dialog", { name: "2 件のメモを移動" })).toBeVisible();
    await page.getByRole("dialog").getByRole("option", { name: /仕事/ }).click();
    await expect(toast(page, "2 件のメモを移動しました")).toBeVisible();
    await expect(page.locator("[data-note-row]").filter({ visible: true })).toHaveCount(0);
  });

  test("set to choose: a click chooses, all at once, Escape stops; then moved by its button", async ({
    page,
  }) => {
    await inInbox(page, ["一", "二"]);
    const open = new URL(page.url()).searchParams.get("n");
    await page.getByRole("button", { name: "メモを選択" }).click();
    await expect(chooser(page)).toContainText("0 件を選択");
    await expect(chooser(page).getByRole("button", { name: "移動" })).toBeDisabled();
    await row(page, "一").click();
    await expect(row(page, "一")).toHaveAttribute("aria-pressed", "true");
    // Chosen, not opened.
    expect(new URL(page.url()).searchParams.get("n")).toBe(open);
    await chooser(page).getByRole("button", { name: "すべて選択" }).click();
    await expect(chooser(page)).toContainText("2 件を選択");
    await page.keyboard.press("Escape");
    await expect(chooser(page)).toHaveCount(0);
    await expect(row(page, "一")).not.toHaveAttribute("aria-pressed");

    await page.getByRole("button", { name: "メモを選択" }).click();
    await chooser(page).getByRole("button", { name: "すべて選択" }).click();
    await chooser(page).getByRole("button", { name: "移動" }).click();
    await page.getByRole("dialog").getByRole("option", { name: /仕事/ }).click();
    await expect(toast(page, "2 件のメモを移動しました")).toBeVisible();
    await expect(chooser(page)).toHaveCount(0);
  });

  test("a folder is still dragged into another, and back to the top level", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await addFolder(page, "仕事");
    await addFolder(page, "趣味");
    await drag(page, folderRow(page, "趣味"), folderRow(page, "仕事"), async () => {
      await expect(page.locator("aside .ring-2")).toHaveCount(1);
    });
    // Inside it, shown open.
    await expect(
      page.locator("aside").getByRole("button", { name: "仕事 を閉じる" }),
    ).toBeVisible();
    await drag(
      page,
      folderRow(page, "趣味"),
      page.locator("aside").getByText("いちばん上の階層へ移動"),
    );
    await expect(
      page.locator("aside").getByRole("button", { name: /^仕事 を(開く|閉じる)$/ }),
    ).toHaveCount(0);
  });

  test("into a locked folder, the notes chosen are locked and moved, asked once", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createVaultInSettings(page);
    await openApp(page);
    await addFolder(page, "仕事");
    const panel = await folderPanel(page);
    await panel.getByRole("button", { name: "仕事 の操作" }).click();
    await page.getByRole("menuitem", { name: "ロックする…" }).click();
    await enterVaultPassword(page, "ロックする");
    await expect(page.getByText(/フォルダ「仕事」をロックしました/)).toBeVisible({
      timeout: 30_000,
    });

    await openFolder(page, "Inbox");
    for (const note of ["一", "二"]) await createNote(page, note);
    await row(page, "一").click({ modifiers: ["ControlOrMeta"] });
    await row(page, "二").click({ modifiers: ["ControlOrMeta"] });
    await chooser(page).getByRole("button", { name: "移動" }).click();
    await page.getByRole("dialog").getByRole("option", { name: /仕事/ }).click();
    // The vault's prompt, by its name: the folder picker may still be on
    // its way out.
    const prompt = page.getByRole("dialog", { name: "ロックされたフォルダへ移動しますか？" });
    await expect(prompt).toContainText("移動するメモ 2 件もロックされます");
    await prompt.getByRole("button", { name: "移動する", exact: true }).click();
    await expect(toast(page, "2 件のメモを移動してロックしました")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator("[data-note-row]").filter({ visible: true })).toHaveCount(0);
    await openFolder(page, "仕事");
    await expect(page.locator("[data-note-row]").filter({ visible: true })).toHaveCount(2);
    await expect(row(page, "一")).toContainText("ロック中");
    await expect(row(page, "二")).toContainText("ロック中");
  });

  test("closing the row's menu or the move dialog with Escape keeps the choice; another folder opened, it is gone", async ({
    page,
  }) => {
    await inInbox(page, ["一", "二", "三"]);
    await row(page, "一").click({ modifiers: ["ControlOrMeta"] });
    await row(page, "二").click({ modifiers: ["ControlOrMeta"] });
    await row(page, "二").click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "2 件のメモを移動…" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(chooser(page)).toContainText("2 件を選択");
    await chooser(page).getByRole("button", { name: "移動" }).click();
    await expect(page.getByRole("dialog", { name: "2 件のメモを移動" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(chooser(page)).toContainText("2 件を選択");

    await openFolder(page, "仕事");
    await expect(chooser(page)).toHaveCount(0);
    await openFolder(page, "Inbox");
    await expect(row(page, "一")).toBeVisible();
    await expect(chooser(page)).toHaveCount(0);
    await expect(row(page, "一")).not.toHaveAttribute("aria-pressed");
  });

  test("a Shift and a click again from the same note: that range in place of the first", async ({
    page,
  }) => {
    await inInbox(page, ["一", "二", "三", "四"]);
    const order = (await names(page)) as string[];
    await row(page, order[0]!).click({ modifiers: ["ControlOrMeta"] });
    await row(page, order[3]!).click({ modifiers: ["Shift"] });
    await expect(chooser(page)).toContainText("4 件を選択");
    await row(page, order[1]!).click({ modifiers: ["Shift"] });
    await expect(chooser(page)).toContainText("2 件を選択");
    await expect(row(page, order[1]!)).toHaveAttribute("aria-pressed", "true");
    await expect(row(page, order[2]!)).toHaveAttribute("aria-pressed", "false");
  });

  test("Shift+F10 opens a row's menu from the keys; moved, focus is on the row now in its place", async ({
    page,
  }) => {
    await inInbox(page, ["一", "二", "三"]);
    const order = (await names(page)) as string[];
    await row(page, order[1]!).focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("menuitem", { name: "移動…" })).toBeVisible();
    await page.getByRole("menuitem", { name: "移動…" }).focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type("仕事");
    await page.keyboard.press("Enter");
    await expect(toast(page, "移動しました")).toBeVisible();
    await expect(row(page, order[1]!)).toHaveCount(0);
    await expect(row(page, order[2]!)).toBeFocused();
  });

  test("Escape in the middle of dragging notes chosen: the drag stops, the choice stays", async ({
    page,
  }) => {
    await inInbox(page, ["一", "二"]);
    await row(page, "一").click({ modifiers: ["ControlOrMeta"] });
    await row(page, "二").click({ modifiers: ["ControlOrMeta"] });
    const start = (await row(page, "一").boundingBox())!;
    await page.mouse.move(start.x + 40, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + 40, start.y + start.height / 2 + 40, { steps: 6 });
    await expect(page.getByText("2 件のメモ", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("2 件のメモ", { exact: true })).toHaveCount(0);
    await page.mouse.up();
    await expect(chooser(page)).toContainText("2 件を選択");
  });

  test("a folder dropped on the strip above the first one after Inbox goes there", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await addFolder(page, "甲");
    await addFolder(page, "乙");
    const folders = () =>
      page
        .locator("aside [data-folder-row]")
        .evaluateAll((rows) => rows.map((each) => each.textContent?.trim()));
    await expect.poll(folders).toEqual(["Inbox", "甲", "乙"]);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // The strip is the top few pixels of the row it is above.
    const from = (await folderRow(page, "乙").boundingBox())!;
    await page.mouse.move(from.x + 20, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 20, from.y + from.height / 2 - 12, { steps: 4 });
    const above = (await folderRow(page, "甲").boundingBox())!;
    await page.mouse.move(above.x + 40, above.y + 1, { steps: 10 });
    await page.mouse.up();
    await expect.poll(folders).toEqual(["Inbox", "乙", "甲"]);
    expect(errors).toEqual([]);
  });

  test("moved to the folder they are in: said so, and nothing moved", async ({ page }) => {
    await inInbox(page, ["一"]);
    await row(page, "一").click({ button: "right" });
    await page.getByRole("menuitem", { name: "移動…" }).click();
    await page.getByRole("dialog").getByRole("option", { name: /Inbox/ }).click();
    await expect(toast(page, "すでにそのフォルダにあります")).toBeVisible();
    await expect(row(page, "一")).toBeVisible();
  });
});

/** Holds a finger on something, still, and lets go. */
async function longPress(page: Page, target: Locator) {
  const box = (await target.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const point = { x: box.x + 60, y: box.y + box.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(900);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

test.describe("moving notes, on a phone", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "a finger");
  });

  test("a long press opens a row's menu, the note not opened, and 移動… moves it", async ({
    page,
  }) => {
    await inInbox(page, ["一"]);
    await longPress(page, row(page, "一"));
    await expect(page.getByRole("menuitem", { name: "移動…" })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("n")).toBeNull();
    await page.getByRole("menuitem", { name: "移動…" }).click();
    await page.getByRole("dialog").getByRole("option", { name: /仕事/ }).click();
    await expect(toast(page, "移動しました")).toBeVisible();
    await expect(row(page, "一")).toHaveCount(0);
  });

  test("placed by hand, a note held and let go without moving opens its menu, staying where it is", async ({
    page,
  }) => {
    await inInbox(page, ["一", "二"]);
    await page.getByRole("button", { name: /^並び順/ }).click();
    await page.getByRole("menuitemradio", { name: "手動" }).click();
    await expect(page.getByRole("button", { name: "並び順（手動）" })).toBeVisible();
    const before = await names(page);
    await longPress(page, row(page, "一"));
    await expect(page.getByRole("menuitem", { name: "移動…" })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("n")).toBeNull();
    await page.keyboard.press("Escape");
    expect(await names(page)).toEqual(before);
  });

  test("set to choose by its button, a tap chooses each, and 移動 moves them", async ({ page }) => {
    await inInbox(page, ["一", "二", "三"]);
    await page.getByRole("button", { name: "メモを選択" }).click();
    // Above the tab bar, in reach wherever the list is scrolled to.
    const bar = (await chooser(page).boundingBox())!;
    const tabs = (await page.getByRole("navigation").last().boundingBox())!;
    expect(Math.abs(bar.y + bar.height - tabs.y)).toBeLessThanOrEqual(2);
    await row(page, "一").click();
    await row(page, "三").click();
    await expect(chooser(page)).toContainText("2 件を選択");
    expect(new URL(page.url()).searchParams.get("n")).toBeNull();
    await chooser(page).getByRole("button", { name: "移動" }).click();
    await page.getByRole("dialog").getByRole("option", { name: /仕事/ }).click();
    await expect(toast(page, "2 件のメモを移動しました")).toBeVisible();
    await expect.poll(() => names(page)).toEqual(["二"]);
  });
});
