import { expect, test } from "@playwright/test";
import { openApp, signUp } from "./helpers";
import {
  VAULT_PASSWORD,
  confirmRecoveryKey,
  createVaultInSettings,
  enterVaultPassword,
  vaultPrompt,
} from "./vault-helpers";

const NEW_PASSWORD = "a-new-vault-password";

test.describe("recovery key", () => {
  test("a new key replaces the old one, and it can reset a forgotten password", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    const oldKey = await createVaultInSettings(page);
    await expect(page.getByText(/に保管を確認済み$/)).toBeVisible();

    // Make a new key, proving identity with the password.
    await page.getByRole("button", { name: "リカバリーキーを作り直す" }).click();
    const dialog = vaultPrompt(page);
    await dialog.getByLabel("金庫のパスワード").fill(VAULT_PASSWORD);
    await dialog.getByRole("button", { name: "続ける" }).click();
    await expect(page.getByRole("heading", { name: "リカバリーキーを保管してください" })).toBeVisible({
      timeout: 30_000,
    });
    // The one-time key cannot be closed away before it is confirmed.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    const newKey = await confirmRecoveryKey(page);
    await expect(page.getByText("新しいリカバリーキーを保存しました")).toBeVisible();
    expect(newKey).not.toBe(oldKey);

    // The old key no longer works; the new one does. Neither opens the vault.
    await page.getByRole("button", { name: "リカバリーキーを試す" }).click();
    await dialog.getByLabel("リカバリーキー").fill(oldKey);
    await dialog.getByRole("button", { name: "試す" }).click();
    await expect(dialog.getByText("このリカバリーキーでは開けません。")).toBeVisible();
    await dialog.getByLabel("リカバリーキー").fill(newKey.toLowerCase());
    await dialog.getByRole("button", { name: "試す" }).click();
    await expect(dialog.getByText("このリカバリーキーは使えます。")).toBeVisible();
    await dialog.getByRole("button", { name: "閉じる" }).first().click();

    // Forgot the password: the recovery key sets a new one.
    await page.getByRole("button", { name: "パスワードを忘れた場合" }).click();
    await dialog.getByLabel("リカバリーキー").fill(newKey);
    await dialog.getByRole("button", { name: "続ける" }).click();
    await dialog.getByLabel("新しいパスワード", { exact: true }).fill(NEW_PASSWORD);
    await dialog.getByLabel("新しいパスワード（確認）").fill(NEW_PASSWORD);
    await dialog.getByRole("button", { name: "再設定する" }).click();
    await expect(page.getByText("金庫のパスワードを再設定しました")).toBeVisible({ timeout: 30_000 });

    // A reload closes the vault; only the new password opens it now.
    await page.goto("/app/settings");
    await page.getByRole("button", { name: "金庫を開く", exact: true }).click();
    await enterVaultPassword(page, "開く", VAULT_PASSWORD);
    await expect(dialog.getByText("パスワードが違います。")).toBeVisible({ timeout: 30_000 });
    await enterVaultPassword(page, "開く", NEW_PASSWORD);
    await expect(page.getByText("金庫：開いています")).toBeVisible({ timeout: 30_000 });
  });
});
