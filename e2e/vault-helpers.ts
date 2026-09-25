import { expect, type Page } from "@playwright/test";

export const VAULT_PASSWORD = "e2e-vault-password";

/**
 * The vault prompt. Not just any dialog: on a phone the folder drawer is a
 * dialog too, and it can be open underneath.
 */
export function vaultPrompt(page: Page) {
  return page.locator('[role="dialog"][data-slot="dialog-content"]');
}

/**
 * Creates the vault from Settings and returns the recovery key it shows.
 *
 * Leaves the page on Settings with the vault open. A full navigation after
 * this closes the vault again, since its key lives only in memory.
 */
export async function createVaultInSettings(page: Page): Promise<string> {
  await page.goto("/app/settings");
  await page.getByRole("button", { name: "金庫を作成" }).click();
  await fillNewVaultPassword(page);
  await page.getByRole("button", { name: "作成する" }).click();

  const heading = page.getByRole("heading", { name: "リカバリーキーを保管してください" });
  await expect(heading).toBeVisible({ timeout: 30_000 });
  const key = await confirmRecoveryKey(page);
  await expect(vaultPrompt(page)).toHaveCount(0);
  return key;
}

/** Fills the creation form's two password fields. */
export async function fillNewVaultPassword(page: Page, password = VAULT_PASSWORD): Promise<void> {
  const dialog = vaultPrompt(page);
  await dialog.getByLabel("金庫のパスワード", { exact: true }).fill(password);
  await dialog.getByLabel("確認のためもう一度入力").fill(password);
}

/** Opens the vault from the prompt with the password. */
export async function enterVaultPassword(
  page: Page,
  submit: string,
  password = VAULT_PASSWORD,
): Promise<void> {
  const dialog = vaultPrompt(page);
  await dialog.getByLabel("金庫のパスワード", { exact: true }).fill(password);
  await dialog.getByRole("button", { name: submit, exact: true }).click();
}

/**
 * Reads the recovery key on screen and proves it was kept: 次へ, then its
 * last four characters. Returns the key as shown.
 */
export async function confirmRecoveryKey(page: Page): Promise<string> {
  const key = (await page.locator("[data-recovery-key]").textContent())?.trim() ?? "";
  await page.getByRole("button", { name: "次へ" }).click();
  await page.getByLabel("最後の 4 文字").fill(key.replace(/-/g, "").slice(-4));
  await page.getByRole("button", { name: "確認", exact: true }).click();
  return key;
}
