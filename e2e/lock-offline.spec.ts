import { expect, test } from "@playwright/test";
import {
  createNote,
  editor,
  offlineReady,
  openApp,
  showList,
  signUp,
  waitForSynced,
} from "./helpers";
import { readTable } from "./local-db";
import { createVaultInSettings, VAULT_PASSWORD } from "./vault-helpers";

/**
 * Against a real build only: the offline reload needs the service worker.
 */
test.describe("locked notes offline", () => {
  test("a locked note opens with the password with no network at all", async ({
    page,
    context,
  }) => {
    await signUp(page);
    await openApp(page);
    await createVaultInSettings(page);

    // A full navigation closes the vault; locking asks for it again.
    await openApp(page);
    await createNote(page, "秘密のメモ", "オフラインでも読める本文");
    await waitForSynced(page);
    await page.getByRole("button", { name: "メモの操作" }).click();
    await page.getByRole("menuitem", { name: "ロックする" }).click();
    const prompt = page.getByRole("dialog");
    await prompt.getByLabel("金庫パスワード").fill(VAULT_PASSWORD);
    await prompt.getByRole("button", { name: "ロックを解除" }).click();
    await expect(page.getByText("ロックしました")).toBeVisible({ timeout: 30_000 });
    await waitForSynced(page);

    await offlineReady(page);
    // The vault record has to be on the device before the network goes.
    await expect
      .poll(async () =>
        (await readTable<{ key: string }>(page, "meta")).some((row) => row.key === "vaultRecord"),
      )
      .toBe(true);

    await context.setOffline(true);
    await page.reload();
    await showList(page);
    await page.getByText("ロック中のメモ").filter({ visible: true }).first().click();
    await page.getByRole("button", { name: "ロックを解除" }).filter({ visible: true }).first().click();

    // Before, this waited forever for the server; now it asks for the password.
    await expect(page.getByText("金庫を開けません")).toHaveCount(0);
    await prompt.getByLabel("金庫パスワード").fill(VAULT_PASSWORD);
    await prompt.getByRole("button", { name: "ロックを解除" }).click();
    await expect(editor(page)).toContainText("オフラインでも読める本文", { timeout: 20_000 });

    await context.setOffline(false);
  });
});
