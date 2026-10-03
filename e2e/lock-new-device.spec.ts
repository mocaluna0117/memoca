import { expect, test } from "@playwright/test";
import {
  createNote,
  editor,
  folderPanel,
  hideFolders,
  openApp,
  showList,
  signIn,
  signUp,
  waitForSynced,
} from "./helpers";
import { readTable } from "./local-db";
import { createVaultInSettings, enterVaultPassword, vaultPrompt } from "./vault-helpers";

/**
 * The desktop app's window is a device of its own, with nothing stored yet,
 * and its quick note's window open beside it on the same storage.
 */
test("a note in a locked folder opens on a device that has never seen it, with the password", async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "one is enough");
  test.setTimeout(240_000);
  const email = await signUp(page);
  await openApp(page);
  await createVaultInSettings(page);
  await openApp(page);
  // A note written in a folder, then the folder locked.
  const panel = await folderPanel(page);
  await panel.getByRole("button", { name: "フォルダを追加" }).click();
  await panel.getByRole("button", { name: "新しいフォルダ", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.type("仕事");
  await page.keyboard.press("Enter");
  await panel.getByRole("button", { name: /^仕事/ }).first().click();
  await hideFolders(page);
  await createNote(page, "秘密のメモ", "秘密の本文");
  await waitForSynced(page);
  const panel2 = await folderPanel(page);
  await panel2.getByRole("button", { name: "仕事 の操作" }).click();
  await page.getByRole("menuitem", { name: "ロックする…" }).click();
  const confirm = vaultPrompt(page).getByRole("button", { name: "ロックする", exact: true });
  await expect(confirm).toBeVisible({ timeout: 30_000 });
  await enterVaultPassword(page, "ロックする");
  await expect(page.getByText("フォルダ「仕事」をロックしました")).toBeVisible({ timeout: 60_000 });
  await waitForSynced(page);
  // The vault, opened again where the note was written, seals it again for
  // the server once (reconcile.ts, resealLockedNotes).
  await page.goto("/app/settings");
  const open = page.getByRole("button", { name: "金庫を開く" }).filter({ visible: true }).first();
  await expect(open).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2000);
  await open.click();
  await enterVaultPassword(page, "開く");
  await expect
    .poll(
      async () =>
        Object.keys(
          ((await readTable<{ key: string; value: unknown }>(page, "meta")).find(
            (row) => row.key === "resealed",
          )?.value ?? {}) as Record<string, number>,
        ).length,
      { timeout: 60_000 },
    )
    .toBe(1);
  await waitForSynced(page);

  const fresh = await context.browser()!.newContext({
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
    viewport: page.viewportSize(),
  });
  const other = await fresh.newPage();
  await signIn(other, email);
  // As the desktop app has it: its quick note's window open too, on the same device.
  const quick = await fresh.newPage();
  await quick.goto("/quick?window=1");
  await quick.waitForTimeout(5000);
  await openApp(other);
  await showList(other);
  await other
    .getByRole("button", { name: /ロックされたメモ/ })
    .filter({ visible: true })
    .first()
    .click();
  const opener = other
    .getByRole("button", { name: "金庫を開く", exact: true })
    .filter({ visible: true })
    .first();
  await expect(opener).toBeVisible({ timeout: 30_000 });
  // Clicked once the page has taken it up: a click before then does nothing.
  await other.waitForTimeout(3000);
  await opener.click();
  await expect(vaultPrompt(other).getByLabel("金庫のパスワード", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await enterVaultPassword(other, "開く");
  await expect(
    editor(other).getByText("秘密の本文").or(other.getByText("このメモを開けませんでした")).first(),
  ).toBeVisible({ timeout: 60_000 });
  await expect(editor(other).getByText("秘密の本文")).toBeVisible();
  await fresh.close();
});
