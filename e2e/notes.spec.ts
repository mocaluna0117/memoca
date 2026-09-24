import { expect, test } from "@playwright/test";
import {
  createNote,
  editor,
  folderPanel,
  hideFolders,
  openApp,
  showList,
  signUp,
  waitForSynced,
} from "./helpers";

test.describe("notes", () => {
  test("a note survives a reload", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "買い物リスト", "牛乳とパンを買う");
    await waitForSynced(page);

    await page.reload();
    await showList(page);
    await expect(page.getByText("買い物リスト").filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
    await page.getByText("買い物リスト").filter({ visible: true }).first().click();
    await expect(editor(page)).toContainText("牛乳とパンを買う");
  });

  test("Enter on a focused note in the list renames it in place", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "旧タイトル", "本文はそのまま");
    await waitForSynced(page);
    await showList(page);

    const row = page
      .getByRole("button", { name: /^旧タイトル/ })
      .filter({ visible: true })
      .first();
    await row.focus();
    await page.keyboard.press("Enter");

    const field = page.getByRole("textbox", { name: "メモ名" });
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("旧タイトル");
    await page.keyboard.type("新タイトル");
    await page.keyboard.press("Enter");

    const renamed = page
      .getByRole("button", { name: /^新タイトル/ })
      .filter({ visible: true })
      .first();
    await expect(renamed).toBeVisible();
    await expect(renamed).toBeFocused();

    // The rename is a real one: it survives a reload and the body is intact.
    await waitForSynced(page);
    await page.reload();
    await showList(page);
    const reloaded = page.getByText("新タイトル").filter({ visible: true }).first();
    await expect(reloaded).toBeVisible({ timeout: 20_000 });
    await reloaded.click();
    await expect(editor(page)).toContainText("本文はそのまま");
  });

  test("arrow keys move between notes in the list", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "ひとつ目");
    await createNote(page, "ふたつ目");
    await createNote(page, "みっつ目");
    await showList(page);

    const rows = page.locator("[data-note-row]").filter({ visible: true });
    await expect(rows).toHaveCount(3);
    await rows.nth(0).focus();
    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(2)).toBeFocused();
    // The last row stays put rather than wrapping around.
    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(2)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press("Home");
    await expect(rows.nth(0)).toBeFocused();
    await page.keyboard.press("End");
    await expect(rows.nth(2)).toBeFocused();

    // Newest first, so focus is on the oldest note now. Moving focus does not
    // open anything; Space does.
    await expect(rows.nth(2)).toContainText("ひとつ目");
    const title = page.getByLabel("メモのタイトル");
    if (await title.isVisible()) await expect(title).toHaveValue("みっつ目");
    await page.keyboard.press("Space");
    await expect(title).toHaveValue("ひとつ目");
  });

  test("the list row shows the first line of the body", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "議事録", "来週までに見積もりを出す");
    await showList(page);
    await expect(page.getByText("来週までに見積もりを出す").filter({ visible: true }).first()).toBeVisible();
  });

  test("markdown shortcuts produce real blocks", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "見出しのテスト");
    await editor(page).click();
    await page.keyboard.type("# 大きな見出し");
    await page.keyboard.press("Enter");
    await page.keyboard.type("- 箇条書き");
    await page.waitForTimeout(600);
    await expect(page.getByRole("heading", { name: "大きな見出し" })).toBeVisible();
    // BlockNote renders a bullet as a block with a content-type attribute
    // rather than a real <li>.
    await expect(
      page.locator('[data-content-type="bulletListItem"]').filter({ hasText: "箇条書き" }),
    ).toBeVisible();
  });

  test("deleting a note moves it to the trash and it can come back", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "消すメモ");
    await waitForSynced(page);

    await page.getByRole("button", { name: "メモの操作" }).click();
    await page.getByRole("menuitem", { name: "削除" }).click();
    await showList(page);
    await expect(page.getByText("消すメモ").filter({ visible: true })).toHaveCount(0);

    const panel = await folderPanel(page);
    await panel.getByRole("link", { name: "ゴミ箱" }).click();
    await expect(page.getByText("消すメモ").filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "復元" }).first().click();
    await expect(page.getByText("消すメモ").filter({ visible: true })).toHaveCount(0);

    await page.goto("/app");
    await showList(page);
    await expect(page.getByText("消すメモ").filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
  });
});

test.describe("folders", () => {
  test("a folder can be created, renamed and nested", async ({ page }) => {
    await signUp(page);
    await openApp(page);

    // The panel stays put while folders are created, so one reference is
    // enough for the whole flow.
    const panel = await folderPanel(page);
    await panel.getByRole("button", { name: "フォルダを追加" }).click();
    await expect(panel.getByText("新しいフォルダ").first()).toBeVisible();

    await panel.getByRole("button", { name: "新しいフォルダ の操作" }).click();
    await page.getByRole("menuitem", { name: "名前を変更" }).click();
    await page.getByRole("textbox").fill("仕事");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(panel.getByText("仕事").first()).toBeVisible();

    await panel.getByRole("button", { name: "仕事 の操作" }).click();
    await page.getByRole("menuitem", { name: "サブフォルダを追加" }).click();
    await expect(panel.getByText("新しいフォルダ").first()).toBeVisible();
  });

  test("a folder can be renamed by typing and pressing Enter", async ({ page }) => {
    await signUp(page);
    await openApp(page);

    const panel = await folderPanel(page);
    await panel.getByRole("button", { name: "フォルダを追加" }).click();
    await panel.getByRole("button", { name: "新しいフォルダ の操作" }).click();
    await page.getByRole("menuitem", { name: "名前を変更" }).click();

    // No click into the field and no select-all: the dialog has to start in
    // the field with the old name selected, or the keystrokes go nowhere.
    const field = page.getByRole("textbox");
    await expect(field).toBeFocused();
    await page.keyboard.type("買い物");
    await page.keyboard.press("Enter");

    await expect(page.getByRole("heading", { name: "フォルダ名を変更" })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "買い物 の操作" })).toBeVisible();
  });

  test("Enter on a focused folder renames it in place, as in VS Code", async ({ page }) => {
    await signUp(page);
    await openApp(page);

    const panel = await folderPanel(page);
    await panel.getByRole("button", { name: "フォルダを追加" }).click();
    const row = panel.getByRole("button", { name: "新しいフォルダ", exact: true });
    await row.focus();
    await page.keyboard.press("Enter");

    // The name becomes a field, already selected, so typing replaces it.
    const field = panel.getByRole("textbox", { name: "フォルダ名" });
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("新しいフォルダ");
    await page.keyboard.type("仕事");
    await page.keyboard.press("Enter");

    const renamed = panel.getByRole("button", { name: "仕事", exact: true });
    await expect(renamed).toBeVisible();
    // Focus comes back to the row, so the next key acts on it again.
    await expect(renamed).toBeFocused();

    // Escape leaves the name as it was.
    await page.keyboard.press("Enter");
    await page.keyboard.type("やめる");
    await page.keyboard.press("Escape");
    await expect(renamed).toBeFocused();
    await expect(panel.getByRole("button", { name: "やめる", exact: true })).toHaveCount(0);

    // Space opens the folder, since Enter no longer does.
    await page.keyboard.press("Space");
    await hideFolders(page);
    await expect(
      page.getByRole("heading", { name: "仕事" }).filter({ visible: true }).first(),
    ).toBeVisible();
  });

  test("Option with an arrow key moves a folder among its siblings", async ({ page }) => {
    await signUp(page);
    await openApp(page);

    const panel = await folderPanel(page);
    for (const name of ["いち", "に"]) {
      await panel.getByRole("button", { name: "フォルダを追加" }).click();
      await panel.getByRole("button", { name: "新しいフォルダ", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.keyboard.type(name);
      await page.keyboard.press("Enter");
      await expect(panel.getByRole("button", { name, exact: true })).toBeVisible();
    }

    const order = () =>
      panel
        .locator("[data-folder-row]")
        .evaluateAll((rows) => rows.map((row) => row.textContent?.trim()));
    await expect.poll(order).toEqual(["Inbox", "いち", "に"]);

    await panel.getByRole("button", { name: "いち", exact: true }).focus();
    await page.keyboard.press("Alt+ArrowDown");
    await expect.poll(order).toEqual(["Inbox", "に", "いち"]);
    await expect(panel.getByRole("button", { name: "いち", exact: true })).toBeFocused();

    await page.keyboard.press("Alt+ArrowUp");
    await expect.poll(order).toEqual(["Inbox", "いち", "に"]);
  });

  test("arrow keys walk the folder tree, as in VS Code", async ({ page }) => {
    await signUp(page);
    await openApp(page);

    const panel = await folderPanel(page);
    const row = (name: string) => panel.getByRole("button", { name, exact: true });
    const renameNew = async (name: string) => {
      await row("新しいフォルダ").focus();
      await page.keyboard.press("Enter");
      await page.keyboard.type(name);
      await page.keyboard.press("Enter");
      await expect(row(name)).toBeVisible();
    };

    // Inbox, いち (with 子 inside), に.
    for (const name of ["いち", "に"]) {
      await panel.getByRole("button", { name: "フォルダを追加" }).click();
      await renameNew(name);
    }
    await panel.getByRole("button", { name: "いち の操作" }).click();
    await page.getByRole("menuitem", { name: "サブフォルダを追加" }).click();
    await renameNew("子");

    await row("Inbox").focus();
    await page.keyboard.press("ArrowDown");
    await expect(row("いち")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(row("子")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(row("に")).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(row("子")).toBeFocused();

    // Left steps out to the parent, then closes it; right opens, then steps in.
    await page.keyboard.press("ArrowLeft");
    await expect(row("いち")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(row("子")).toHaveCount(0);
    await expect(row("いち")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(row("子")).toBeVisible();
    await expect(row("いち")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(row("子")).toBeFocused();

    await page.keyboard.press("End");
    await expect(row("に")).toBeFocused();
    await page.keyboard.press("Home");
    await expect(row("Inbox")).toBeFocused();
  });

  test("a note created inside a folder stays there", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    const panel = await folderPanel(page);
    await panel.getByRole("button", { name: "フォルダを追加" }).click();
    await hideFolders(page);
    await page.waitForTimeout(700);
    await createNote(page, "フォルダの中のメモ");
    await waitForSynced(page);

    await page.reload();
    await showList(page);
    await expect(page.getByText("フォルダの中のメモ").filter({ visible: true }).first()).toBeVisible({
      timeout: 20_000,
    });
  });
});

test.describe("reading search", () => {
  test("a kanji note is found by typing its reading", async ({ page }) => {
    // Turning this on downloads a 17 MB dictionary, so allow for that.
    test.slow();
    await signUp(page);
    await openApp(page);
    await createNote(page, "薬局のメモ", "金曜に歯医者へ行く");
    await waitForSynced(page);

    await page.goto("/app/search");
    const field = page.getByLabel("検索");
    await expect(field).toBeVisible();
    await field.fill("やっきょく");

    // Reading search is off by default, so the offer appears instead of a hit.
    const enable = page.getByRole("button", { name: "有効にする" });
    await expect(enable).toBeVisible();
    await enable.click();
    await expect(enable).toBeHidden({ timeout: 180_000 });

    await field.fill("");
    await field.fill("やっきょく");
    await expect(
      page.getByText("薬局のメモ").filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 30_000 });

    // The body's reading is searchable too.
    await field.fill("はいしゃ");
    await expect(
      page.getByText("薬局のメモ").filter({ visible: true }).first(),
    ).toBeVisible();
  });

  test("renaming a note is not undone by editing its body", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    // Two notes in a row: creating the second while the first is open is what
    // used to let a body edit resend, and blank, the title.
    await createNote(page, "ひとつ目", "本文A");
    await createNote(page, "ふたつ目", "本文B");
    await waitForSynced(page);

    await page.reload();
    await showList(page);
    await expect(
      page.getByText("ひとつ目").filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText("ふたつ目").filter({ visible: true }).first(),
    ).toBeVisible();
  });
});

test.describe("Inbox", () => {
  test("a note created from all notes is filed in Inbox", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "どこにも入れていないメモ");
    await waitForSynced(page);

    const panel = await folderPanel(page);
    await panel.getByRole("button", { name: "Inbox", exact: true }).click();
    await showList(page);
    await expect(
      page.getByText("どこにも入れていないメモ").filter({ visible: true }).first(),
    ).toBeVisible();
  });

  test("a note cannot be moved to no folder", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "移動の確認");
    await page.getByRole("button", { name: "メモの操作" }).click();
    await page.getByRole("menuitem", { name: "移動" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Inbox")).toBeVisible();
    // The unnamed "no folder" destination is gone; Inbox is where unfiled
    // notes live now.
    await expect(dialog.getByText("フォルダなし")).toHaveCount(0);
  });
});
