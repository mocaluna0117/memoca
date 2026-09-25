import { expect, type Page } from "@playwright/test";

export const VAULT_PASSWORD = "e2e-vault-password";

/**
 * Creates the vault from Settings and returns the recovery key it shows.
 *
 * Leaves the page on Settings with the vault open. A full navigation after
 * this closes the vault again, since its key lives only in memory.
 */
export async function createVaultInSettings(page: Page): Promise<string> {
  await page.goto("/app/settings");
  await page.getByRole("button", { name: "ロックを設定" }).click();
  await page.getByLabel("金庫パスワード").fill(VAULT_PASSWORD);
  await page.getByLabel("もう一度入力").fill(VAULT_PASSWORD);
  await page.getByRole("button", { name: "設定する" }).click();

  const heading = page.getByRole("heading", { name: "リカバリーキーを保管してください" });
  await expect(heading).toBeVisible({ timeout: 30_000 });
  const key = await confirmRecoveryKey(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  return key;
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
