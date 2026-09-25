import { expect, test } from "@playwright/test";
import { openApp, signUp } from "./helpers";
import {
  VAULT_PASSWORD,
  confirmRecoveryKey,
  createVaultInSettings,
  fillNewVaultPassword,
  vaultPrompt,
} from "./vault-helpers";
import { addVirtualPasskey, countCredentialGets, setUserVerified } from "./webauthn";

/** 「Windows Hello で開く」, 「指紋・顔認証で開く」 and so on, by device. */
const OPEN_WITH_PASSKEY = /で開く$/;

test.describe("passkey unlock", () => {
  test("one tap shows the system sheet once and opens the vault; cancel stops", async ({
    page,
    context,
  }) => {
    const gets = await countCredentialGets(page);
    await signUp(page);
    const { cdp, authenticatorId } = await addVirtualPasskey(context, page);
    await openApp(page);
    await createVaultInSettings(page);

    // Register this device from Settings: the password, then one tap.
    const rows = page.getByRole("button", { name: /のパスキーを削除$/ });
    await page.getByRole("button", { name: /^この端末で .+を使う$/ }).click();
    const dialog = vaultPrompt(page);
    await dialog.getByLabel("金庫のパスワード").fill(VAULT_PASSWORD);
    await dialog.getByRole("button", { name: "次へ" }).click();
    await dialog.getByRole("button", { name: "登録を始める" }).click({ timeout: 30_000 });
    await expect(page.getByText(/を使えるようにしました$/)).toBeVisible({ timeout: 30_000 });
    await expect(rows).toHaveCount(1);
    await expect(page.getByText("この端末", { exact: true })).toBeVisible();

    // Registering again does not make a second passkey for the same device.
    await page.getByRole("button", { name: /^この端末で .+を使う$/ }).click();
    await dialog.getByLabel("金庫のパスワード").fill(VAULT_PASSWORD);
    await dialog.getByRole("button", { name: "次へ" }).click();
    await dialog.getByRole("button", { name: "登録を始める" }).click({ timeout: 30_000 });
    await expect(dialog.getByRole("heading", { name: "この端末のパスキーは登録済みです" })).toBeVisible();
    await dialog.getByRole("button", { name: /で確認$/ }).click();
    await expect(page.getByText("この端末のパスキーを使えるようにしました")).toBeVisible();
    await expect(rows).toHaveCount(1);

    // A reload closes the vault. The one tap on 「金庫を開く」 starts the
    // passkey sheet itself: one sheet, and the vault is open.
    await page.goto("/app/settings");
    const prompt = vaultPrompt(page);
    const before = await gets();
    await page.getByRole("button", { name: "金庫を開く", exact: true }).click();
    // Right after a load, the device's passkey list may not have been read
    // yet; then the prompt offers the passkey button instead. Either way it is
    // one sheet.
    const opened = page.getByText("金庫：開いています");
    const button = prompt.getByRole("button", { name: OPEN_WITH_PASSKEY });
    await expect(opened.or(button)).toBeVisible();
    if (await button.isVisible()) await button.click();
    await expect(opened).toBeVisible();
    await expect(prompt).toHaveCount(0);
    expect(await gets()).toBe(before + 1);

    // Cancelled verification: the prompt stays, and no second sheet follows.
    await page.goto("/app/settings");
    await setUserVerified(cdp, authenticatorId, false);
    const again = await gets();
    await page.getByRole("button", { name: "金庫を開く", exact: true }).click();
    await expect(prompt).toBeVisible();
    if ((await gets()) === again) await button.click();
    await page.waitForTimeout(1_000);
    expect(await gets()).toBe(again + 1);
    await expect(page.getByText("金庫：閉じています")).toBeVisible();

    // Trying again is one more tap and one more sheet; that path is covered
    // by the unit tests, because Chromium's virtual authenticator keeps
    // refusing once it has failed a verification in the same session.

    // Deleting asks first, and the entry goes.
    await page.keyboard.press("Escape");
    await rows.first().click();
    await expect(vaultPrompt(page).getByRole("heading", { name: /のパスキーを削除しますか？$/ })).toBeVisible();
    await vaultPrompt(page).getByRole("button", { name: "削除する" }).click();
    await expect(page.getByText("パスキーを削除しました")).toBeVisible();
    await expect(rows).toHaveCount(0);
  });

  test("right after the vault is made, Face ID / Touch ID can be set up in the same flow", async ({
    page,
    context,
  }) => {
    await signUp(page);
    await addVirtualPasskey(context, page);
    await openApp(page);
    await page.goto("/app/settings");
    await page.getByRole("button", { name: "金庫を作成" }).click();
    await fillNewVaultPassword(page);
    await vaultPrompt(page).getByRole("button", { name: "作成する" }).click();
    await expect(page.getByRole("heading", { name: "リカバリーキーを保管してください" })).toBeVisible({
      timeout: 30_000,
    });
    await confirmRecoveryKey(page);

    const dialog = vaultPrompt(page);
    await expect(dialog.getByRole("heading", { name: /でも開けるようにしますか？$/ })).toBeVisible();
    await dialog.getByRole("button", { name: /を使う$/ }).click();
    // No second password: the key from creation is still at hand.
    await expect(dialog.getByLabel("金庫のパスワード")).toHaveCount(0);
    await dialog.getByRole("button", { name: "登録を始める" }).click();
    await expect(page.getByText(/を使えるようにしました$/)).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: /のパスキーを削除$/ })).toHaveCount(1);
    await expect(page.getByText("この端末", { exact: true })).toBeVisible();
  });
});
