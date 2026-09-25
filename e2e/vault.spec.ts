import { expect, type Page, test } from "@playwright/test";
import { createNote, folderPanel, openApp, settle, signUp } from "./helpers";
import {
  VAULT_PASSWORD,
  confirmRecoveryKey,
  createVaultInSettings,
  enterVaultPassword,
  fillNewVaultPassword,
  vaultPrompt,
} from "./vault-helpers";

const CREATE = "金庫を作成";
const LOCK_FOLDER = "フォルダ「新しいフォルダ」をロックしますか？";

async function addFolder(page: Page) {
  const panel = await folderPanel(page);
  await panel.getByRole("button", { name: "フォルダを追加" }).click();
  await expect(panel.getByRole("button", { name: "新しいフォルダ", exact: true })).toBeVisible();
}

/** Chooses 「ロックする…」 on a folder. */
async function askToLockFolder(page: Page, folder = "新しいフォルダ") {
  const panel = await folderPanel(page);
  await panel.getByRole("button", { name: `${folder} の操作` }).click();
  await page.getByRole("menuitem", { name: "ロックする…" }).click();
}

/** Every way a person can close a dialog. */
function dismissals(page: Page): Record<string, () => Promise<void>> {
  return {
    Escape: () => page.keyboard.press("Escape"),
    "outside click": () => page.mouse.click(5, 5),
    "close button": () => vaultPrompt(page).getByRole("button", { name: "閉じる" }).click(),
    キャンセル: () => page.getByRole("button", { name: "キャンセル" }).click(),
  };
}

async function expectDismissedWithoutCreation(
  page: Page,
  heading: string,
  how: string,
  dismiss: () => Promise<void>,
) {
  const prompt = page.getByRole("heading", { name: heading });
  await expect(prompt, `prompt before ${how}`).toBeVisible();
  // Radix starts listening for outside clicks only once the dialog has
  // opened; a click during the opening animation is not a dismissal.
  await settle(vaultPrompt(page).last());
  await dismiss();
  await expect(prompt, `prompt after ${how}`).toHaveCount(0);
  // The old behaviour: dismissing jumped straight to vault creation.
  await expect(page.getByRole("heading", { name: CREATE }), how).toHaveCount(0);
  await expect(page.getByLabel("確認のためもう一度入力"), how).toHaveCount(0);
}

test.describe("vault prompt", () => {
  test("locking says it locks: it never reads 「ロックを解除」", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createVaultInSettings(page);
    await openApp(page);
    await addFolder(page);

    // With the vault closed, the prompt names the folder and the act.
    await askToLockFolder(page);
    const dialog = vaultPrompt(page);
    await expect(dialog.getByRole("heading", { name: LOCK_FOLDER })).toBeVisible();
    await expect(dialog).not.toContainText("ロックを解除");
    await expect(dialog).not.toContainText("解除");
    await enterVaultPassword(page, "ロックする");
    await expect(page.getByText(/をロックしました$/)).toBeVisible({ timeout: 30_000 });

    // Taking the lock off asks for a yes even with the vault open, and
    // closing that question changes nothing.
    const panel = await folderPanel(page);
    await panel.getByRole("button", { name: /の操作$/ }).nth(1).click();
    await page.getByRole("menuitem", { name: "ロックを外す…" }).click();
    const unlockHeading = dialog.getByRole("heading", { name: /のロックを外しますか？$/ });
    await expect(unlockHeading).toBeVisible();
    await expect(dialog).toContainText("暗号化されない状態でサーバーに保存されます");
    await page.keyboard.press("Escape");
    await expect(unlockHeading).toHaveCount(0);
    // Focus goes back to the folder row. The earlier menu must also have
    // finished closing: while it animates out it can still take focus, which
    // would close the one opened next.
    await expect(panel.locator("[data-folder-row]").nth(1)).toBeFocused();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await panel.getByRole("button", { name: /の操作$/ }).nth(1).click();
    await expect(page.getByRole("menuitem", { name: "ロックを外す…" })).toBeVisible();
    await page.getByRole("menuitem", { name: "ロックを外す…" }).click();
    await dialog.getByRole("button", { name: "ロックを外す", exact: true }).click();
    await expect(page.getByText(/のロックを外しました$/)).toBeVisible({ timeout: 30_000 });
  });

  test("the one-time recovery key cannot be dismissed by accident", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await page.goto("/app/settings");
    await page.getByRole("button", { name: CREATE }).click();
    await fillNewVaultPassword(page);
    await page.getByRole("button", { name: "作成する" }).click();
    // While the key is still being derived and saved, closing is refused too.
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5);

    const heading = page.getByRole("heading", { name: "リカバリーキーを保管してください" });
    await expect(heading).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5);
    await expect(heading).toBeVisible();
    await expect(vaultPrompt(page).getByRole("button", { name: "閉じる" })).toHaveCount(0);

    // Moving on needs the key's last four characters, not just a click.
    await page.getByRole("button", { name: "次へ" }).click();
    await page.getByLabel("最後の 4 文字").fill("ZZZZ");
    await page.getByRole("button", { name: "確認", exact: true }).click();
    await expect(page.getByText("一致しません。")).toBeVisible();
    await page.getByRole("button", { name: "キーをもう一度表示" }).click();
    await confirmRecoveryKey(page);
    await expect(heading).toHaveCount(0);
    await expect(vaultPrompt(page)).toHaveCount(0);
  });

  test("closing the prompt in any way never offers to create a second vault", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createVaultInSettings(page);

    // A full navigation drops the key from memory: the vault is closed again.
    await openApp(page);
    await addFolder(page);

    for (const [how, dismiss] of Object.entries(dismissals(page))) {
      await askToLockFolder(page);
      await expectDismissedWithoutCreation(page, LOCK_FOLDER, how, dismiss);
    }
  });

  test("closing the prompt opened from a note never offers to create a vault either", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createVaultInSettings(page);
    await openApp(page);
    await createNote(page, "ロックしたいメモ");

    for (const [how, dismiss] of Object.entries(dismissals(page))) {
      await page.getByRole("button", { name: "メモの操作" }).click();
      await page.getByRole("menuitem", { name: "ロックする", exact: true }).click();
      await expectDismissedWithoutCreation(page, "メモをロック", how, dismiss);
    }
  });

  test("the recovery key shown at creation opens the vault, however it is typed", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    const key = await createVaultInSettings(page);
    // All 52 characters, in groups of four.
    expect(key.replace(/-/g, "")).toHaveLength(52);

    // A reload closes the vault; open it again with the key alone.
    await page.goto("/app/settings");
    await page.getByRole("button", { name: "金庫を開く", exact: true }).click();
    const prompt = vaultPrompt(page);
    await prompt.getByRole("button", { name: "パスワードを忘れた場合" }).click();
    await prompt.getByLabel("リカバリーキー").fill(key.toLowerCase().replace(/-/g, " "));
    await prompt.getByRole("button", { name: "開く", exact: true }).click();

    // Opened with the key alone, it offers to set a new password.
    await expect(prompt.getByRole("heading", { name: "新しいパスワードを設定しますか？" })).toBeVisible({
      timeout: 30_000,
    });
    await prompt.getByRole("button", { name: "あとで" }).click();
    await expect(prompt).toHaveCount(0);
    await expect(page.getByText("金庫：開いています")).toBeVisible();
  });

  test("a new password set after opening with the recovery key replaces the old one", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    const key = await createVaultInSettings(page);

    await page.goto("/app/settings");
    await page.getByRole("button", { name: "金庫を開く", exact: true }).click();
    const prompt = vaultPrompt(page);
    await prompt.getByRole("button", { name: "パスワードを忘れた場合" }).click();
    await prompt.getByLabel("リカバリーキー").fill(key);
    await prompt.getByRole("button", { name: "開く", exact: true }).click();
    await prompt.getByRole("button", { name: "新しいパスワードを設定" }).click({ timeout: 30_000 });
    await prompt.getByLabel("新しいパスワード", { exact: true }).fill("another-vault-password");
    await prompt.getByLabel("新しいパスワード（確認）").fill("another-vault-password");
    await prompt.getByRole("button", { name: "設定する" }).click();
    await expect(page.getByText("金庫のパスワードを再設定しました")).toBeVisible({ timeout: 30_000 });

    await page.goto("/app/settings");
    await page.getByRole("button", { name: "金庫を開く", exact: true }).click();
    await enterVaultPassword(page, "開く", VAULT_PASSWORD);
    await expect(prompt.getByText("パスワードが違います。")).toBeVisible({ timeout: 30_000 });
    await enterVaultPassword(page, "開く", "another-vault-password");
    await expect(page.getByText("金庫：開いています")).toBeVisible({ timeout: 30_000 });
  });

  test("with no vault yet, one cancel closes the creation prompt", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await addFolder(page);

    await askToLockFolder(page);
    const create = page.getByRole("heading", { name: CREATE });
    await expect(create).toBeVisible();
    await page.getByRole("button", { name: "キャンセル" }).click();
    await expect(create).toHaveCount(0);
    await expect(vaultPrompt(page)).toHaveCount(0);
  });
});
