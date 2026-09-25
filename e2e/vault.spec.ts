import { expect, type Page, test } from "@playwright/test";
import { createNote, folderPanel, openApp, signUp } from "./helpers";
import { createVaultInSettings, VAULT_PASSWORD } from "./vault-helpers";

const PROMPT_UNLOCK = "ロックを解除";
const PROMPT_CREATE = "ロックを設定";

async function addFolder(page: Page) {
  const panel = await folderPanel(page);
  await panel.getByRole("button", { name: "フォルダを追加" }).click();
  await expect(panel.getByRole("button", { name: "新しいフォルダ", exact: true })).toBeVisible();
}

/** Chooses 「ロックする」 on the folder, which needs the vault open first. */
async function askToLockFolder(page: Page) {
  const panel = await folderPanel(page);
  await panel.getByRole("button", { name: "新しいフォルダ の操作" }).click();
  await page.getByRole("menuitem", { name: "ロックする" }).click();
}

/** Every way a person can close a dialog. */
function dismissals(page: Page): Record<string, () => Promise<void>> {
  return {
    Escape: () => page.keyboard.press("Escape"),
    "outside click": () => page.mouse.click(5, 5),
    "close button": () => page.getByRole("button", { name: "Close" }).click(),
    キャンセル: () => page.getByRole("button", { name: "キャンセル" }).click(),
  };
}

async function expectDismissedWithoutCreation(
  page: Page,
  how: string,
  dismiss: () => Promise<void>,
) {
  const prompt = page.getByRole("heading", { name: PROMPT_UNLOCK });
  await expect(prompt, `prompt before ${how}`).toBeVisible();
  await dismiss();
  await expect(prompt, `prompt after ${how}`).toHaveCount(0);
  // The old behaviour: dismissing jumped straight to vault creation.
  await expect(page.getByRole("heading", { name: PROMPT_CREATE }), how).toHaveCount(0);
  await expect(page.getByLabel("もう一度入力"), how).toHaveCount(0);
}

test.describe("vault prompt", () => {
  test("the one-time recovery key cannot be dismissed by accident", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await page.goto("/app/settings");
    await page.getByRole("button", { name: PROMPT_CREATE }).click();
    await page.getByLabel("金庫パスワード").fill(VAULT_PASSWORD);
    await page.getByLabel("もう一度入力").fill(VAULT_PASSWORD);
    await page.getByRole("button", { name: "設定する" }).click();
    // While the key is still being derived and saved, closing is refused too.
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5);

    const heading = page.getByRole("heading", { name: "リカバリーキーを保管してください" });
    await expect(heading).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5);
    await expect(heading).toBeVisible();
    await expect(page.getByRole("button", { name: "Close" })).toHaveCount(0);

    await page.getByRole("button", { name: "保管しました" }).click();
    await expect(heading).toHaveCount(0);
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
      await expectDismissedWithoutCreation(page, how, dismiss);
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
      await page.getByRole("menuitem", { name: "ロックする" }).click();
      await expectDismissedWithoutCreation(page, how, dismiss);
    }
  });

  test("with no vault yet, one cancel closes the creation prompt", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await addFolder(page);

    await askToLockFolder(page);
    const create = page.getByRole("heading", { name: PROMPT_CREATE });
    await expect(create).toBeVisible();
    await page.getByRole("button", { name: "キャンセル" }).click();
    await expect(create).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: PROMPT_CREATE })).toHaveCount(0);
  });
});
