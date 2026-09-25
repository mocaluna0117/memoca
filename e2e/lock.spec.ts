import { expect, type Page, test } from "@playwright/test";
import { createNote, folderPanel, hideFolders, openApp, signUp, waitForSynced } from "./helpers";
import { readTable } from "./local-db";
import { createVaultInSettings, enterVaultPassword, vaultPrompt } from "./vault-helpers";

/** Adds a top-level folder and names it, with the keyboard, as in VS Code. */
async function addFolder(page: Page, name: string) {
  const panel = await folderPanel(page);
  await panel.getByRole("button", { name: "フォルダを追加" }).click();
  await panel.getByRole("button", { name: "新しいフォルダ", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("button", { name, exact: true })).toBeVisible();
}

async function openFolder(page: Page, name: string) {
  const panel = await folderPanel(page);
  await panel.getByRole("button", { name: new RegExp(`^${name}`) }).first().click();
  await hideFolders(page);
}

async function folderMenu(page: Page, name: string) {
  const panel = await folderPanel(page);
  await panel.getByRole("button", { name: `${name} の操作` }).click();
}

type Row = { noteId: string; locked: boolean; lockOrigin?: string };

test.describe("folder locks", () => {
  test("taking a folder's lock off leaves a note locked by hand locked", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createVaultInSettings(page);
    await openApp(page);

    await addFolder(page, "仕事");
    await openFolder(page, "仕事");
    await createNote(page, "自分でロック", "個別に守る本文");
    await waitForSynced(page);
    await page.getByRole("button", { name: "メモの操作" }).click();
    await page.getByRole("menuitem", { name: "ロックする", exact: true }).click();
    await enterVaultPassword(page, "ロックする");
    await expect(page.getByText("メモをロックしました")).toBeVisible({ timeout: 30_000 });

    await createNote(page, "フォルダでロック", "フォルダで守る本文");
    await waitForSynced(page);

    // With the vault open, locking the folder still asks, and counts the note.
    await folderMenu(page, "仕事");
    await page.getByRole("menuitem", { name: "ロックする…" }).click();
    await expect(vaultPrompt(page)).toContainText("中にあるメモ 1 件");
    await vaultPrompt(page).getByRole("button", { name: "ロックする", exact: true }).click();
    await expect(page.getByText("フォルダ「仕事」をロックしました（メモ 1 件）")).toBeVisible({
      timeout: 30_000,
    });

    // The folder keeps its name, marked as locked for screen readers.
    const panel = await folderPanel(page);
    await expect(panel.getByRole("button", { name: /^仕事\s*（ロック中）$/ })).toBeVisible();
    await hideFolders(page);

    // A note under the folder's lock cannot have it taken off on its own.
    await page.getByRole("button", { name: /^フォルダでロック/ }).filter({ visible: true }).first().click();
    await page.getByRole("button", { name: "メモの操作" }).filter({ visible: true }).click();
    await expect(page.getByRole("menuitem", { name: /フォルダ「仕事」でロック中/ })).toBeDisabled();
    await page.keyboard.press("Escape");

    // Taking the folder's lock off says what it keeps, and keeps it.
    await folderMenu(page, "仕事");
    await page.getByRole("menuitem", { name: "ロックを外す…" }).click();
    await expect(vaultPrompt(page)).toContainText("1 件は、ロックしたままにします");
    await vaultPrompt(page).getByRole("button", { name: "ロックを外す", exact: true }).click();
    await expect(page.getByText("フォルダ「仕事」のロックを外しました（メモ 1 件）")).toBeVisible({
      timeout: 30_000,
    });

    await expect
      .poll(async () => {
        const notes = await readTable<Row>(page, "notes");
        return notes.filter((n) => n.locked).map((n) => n.lockOrigin);
      })
      .toEqual(["note"]);
  });

  test("a subfolder shows its parent's lock, and Inbox cannot be locked", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createVaultInSettings(page);

    await openApp(page);
    await addFolder(page, "仕事");
    await folderMenu(page, "仕事");
    await page.getByRole("menuitem", { name: "ロックする…" }).click();
    await enterVaultPassword(page, "ロックする");
    await expect(page.getByText("フォルダ「仕事」をロックしました")).toBeVisible({ timeout: 30_000 });

    await folderMenu(page, "仕事");
    await page.getByRole("menuitem", { name: "サブフォルダを追加" }).click();
    const panel = await folderPanel(page);
    await expect(panel.getByRole("button", { name: /^新しいフォルダ\s*（親フォルダでロック中）$/ })).toBeVisible();
    await panel.getByRole("button", { name: "新しいフォルダ の操作" }).click();
    await expect(page.getByRole("menuitem", { name: "親フォルダ「仕事」でロック中" })).toBeDisabled();
    await page.keyboard.press("Escape");
    // The last menu has to finish closing before the next one opens.
    await expect(page.getByRole("menu")).toHaveCount(0);

    await panel.getByRole("button", { name: "Inbox の操作" }).click();
    await expect(page.getByRole("menuitem", { name: "名前を変更" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /ロック/ })).toHaveCount(0);
  });
});
