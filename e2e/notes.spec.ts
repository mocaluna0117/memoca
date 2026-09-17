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

    let panel = await folderPanel(page);
    await panel.getByRole("button", { name: "新しいフォルダ" }).click();
    await expect(page.getByText("新しいフォルダ").filter({ visible: true }).first()).toBeVisible();

    panel = await folderPanel(page);
    await panel.getByRole("button", { name: /の操作$/ }).first().click();
    await page.getByRole("menuitem", { name: "名前を変更" }).click();
    await page.getByRole("textbox").fill("仕事");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page.getByText("仕事").filter({ visible: true }).first()).toBeVisible();

    panel = await folderPanel(page);
    await panel.getByRole("button", { name: "仕事 の操作" }).click();
    await page.getByRole("menuitem", { name: "サブフォルダを追加" }).click();
    await expect(page.getByText("新しいフォルダ").filter({ visible: true }).first()).toBeVisible();
  });

  test("a note created inside a folder stays there", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    const panel = await folderPanel(page);
    await panel.getByRole("button", { name: "新しいフォルダ" }).click();
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
