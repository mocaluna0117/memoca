import { expect, test } from "@playwright/test";
import { openApp, signUp } from "./helpers";
import { createVaultInSettings, VAULT_PASSWORD } from "./vault-helpers";
import { addVirtualPasskey, countCredentialGets, setUserVerified } from "./webauthn";

const BIOMETRIC = "Face ID / Touch ID で解除";

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

    // Register twice from Settings. The second replaces the first on this
    // authenticator, leaving a stale entry in the list: the case that used to
    // bring up the browser's chooser before the working passkey was tried.
    for (let round = 0; round < 2; round += 1) {
      await page.getByLabel("登録するには金庫パスワードを入力してください").fill(VAULT_PASSWORD);
      await page.getByRole("button", { name: "登録", exact: true }).click();
      await expect(page.getByText("生体認証を登録しました").first()).toBeVisible({
        timeout: 30_000,
      });
      const rows = page.getByRole("button", { name: /^(iPhone|Android|この端末) を削除$/ });
      await expect(rows).toHaveCount(round + 1);
    }

    // A reload closes the vault. Open it with the passkey.
    await page.goto("/app/settings");
    await page.getByRole("button", { name: "ロックを解除" }).click();
    const prompt = page.getByRole("dialog");
    const before = await gets();
    await prompt.getByRole("button", { name: BIOMETRIC }).click();
    await expect(prompt).toHaveCount(0);
    await expect(page.getByText("状態：解除中")).toBeVisible();
    expect(await gets()).toBe(before + 1);

    // Cancelled verification: back to the prompt, and no second sheet.
    await page.goto("/app/settings");
    await setUserVerified(cdp, authenticatorId, false);
    await page.getByRole("button", { name: "ロックを解除" }).click();
    const again = await gets();
    await prompt.getByRole("button", { name: BIOMETRIC }).click();
    await expect(prompt.getByRole("button", { name: BIOMETRIC })).toBeEnabled();
    await page.waitForTimeout(1_000);
    expect(await gets()).toBe(again + 1);
    await expect(prompt).toBeVisible();
    await expect(page.getByText("状態：ロックされています")).toBeVisible();
  });
});
