import { expect, test } from "@playwright/test";
import { openApp, signUp } from "./helpers";
import { createVaultInSettings, VAULT_PASSWORD, vaultPrompt } from "./vault-helpers";
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

    // Register twice from Settings. The second replaces the first on this
    // authenticator, leaving a stale entry in the list: the case that used to
    // bring up the browser's chooser before the working passkey was tried.
    for (let round = 0; round < 2; round += 1) {
      await page.getByLabel("登録するには金庫のパスワードを入力してください").fill(VAULT_PASSWORD);
      await page.getByRole("button", { name: "登録", exact: true }).click();
      await expect(page.getByText("パスキーを登録しました").first()).toBeVisible({
        timeout: 30_000,
      });
      const rows = page.getByRole("button", { name: /^(iPhone|Android|この端末) を削除$/ });
      await expect(rows).toHaveCount(round + 1);
    }

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
  });
});
