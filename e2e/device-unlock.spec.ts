import { type Page, expect, test } from "@playwright/test";
import { createNote, editor, openApp, signUp, waitForSynced } from "./helpers";
import { enterVaultPassword, createVaultInSettings, vaultPrompt } from "./vault-helpers";

/**
 * The vault opened by the computer's own check in the desktop app (Touch
 * ID): src/lib/vault/device-unlock.ts. The app is stood in for, its check
 * answering at once or (as a Mac's keychain question left unanswered does)
 * never.
 */

/** As the desktop app's window has it: Touch ID, which hangs while `e2e:touch-id-hangs` is set. */
async function inDesktopApp(page: Page) {
  await page.context().addInitScript(() => {
    const asked = window as unknown as { __asked: boolean[] };
    asked.__asked = [];
    Object.defineProperty(window, "memocaShell", {
      value: {
        platform: "macos",
        hide() {},
        openExternal() {},
        deviceUnlock: {
          kind: async () => "touchId",
          secret: (create: boolean) => {
            asked.__asked.push(create);
            if (!create && localStorage.getItem("e2e:touch-id-hangs") === "1") return new Promise<string>(() => {});
            return Promise.resolve(btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
          },
        },
      },
    });
  });
}

/** The locked note chosen, and the vault's prompt asked for. */
async function openLocked(page: Page) {
  await page.getByText("ロックされたメモ").filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "金庫を開く", exact: true }).filter({ visible: true }).first().click();
  await expect(vaultPrompt(page)).toBeVisible();
}

test("Touch ID left unanswered (the Mac's keychain asking, say): the prompt can still be cancelled, and the password still opens the vault", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the desktop app, on a computer");
  test.slow();
  await inDesktopApp(page);
  await signUp(page);
  await openApp(page);
  await createVaultInSettings(page);
  await openApp(page);
  await createNote(page, "ロックするメモ", "秘密の本文");
  await waitForSynced(page);

  // Locked with the password, and Touch ID taken up as it is offered.
  await page.getByRole("button", { name: "メモの操作" }).click();
  await page.getByRole("menuitem", { name: "ロックする", exact: true }).click();
  await enterVaultPassword(page, "ロックする");
  await vaultPrompt(page).getByRole("button", { name: "Touch ID を使う" }).click();
  await expect(page.getByText("次からは Touch ID で金庫を開けます")).toBeVisible();
  await expect(page.getByText("メモをロックしました")).toBeVisible({ timeout: 30_000 });
  await waitForSynced(page);

  // The check never answers. The vault closed (a page loaded anew), the note asked for.
  await page.evaluate(() => localStorage.setItem("e2e:touch-id-hangs", "1"));
  await openApp(page);
  await openLocked(page);
  const prompt = vaultPrompt(page);
  // Waited for, and said so, with what to do about the keychain's question.
  await expect(prompt.getByRole("button", { name: /Touch ID の確認を待っています/ })).toBeVisible();
  await expect(prompt).toContainText("キーチェーン");
  // Not held by it: cancelled.
  await expect(prompt.getByRole("button", { name: "キャンセル" })).toBeEnabled();
  await prompt.getByRole("button", { name: "キャンセル" }).click();
  await expect(prompt).toHaveCount(0);

  // Asked for again, the check still unanswered (not asked a second time): the password opens it.
  await openLocked(page);
  await expect(prompt.getByRole("button", { name: /Touch ID の確認を待っています/ })).toBeVisible();
  await enterVaultPassword(page, "開く");
  await expect(prompt).toHaveCount(0);
  await expect(editor(page)).toContainText("秘密の本文", { timeout: 15_000 });
  const asks = await page.evaluate(() => (window as unknown as { __asked: boolean[] }).__asked);
  expect(asks.filter((create) => !create)).toHaveLength(1);

  // Answering again: Touch ID alone opens it, as before.
  await page.evaluate(() => localStorage.removeItem("e2e:touch-id-hangs"));
  await openApp(page);
  await openLocked(page);
  await expect(prompt).toHaveCount(0);
  await expect(editor(page)).toContainText("秘密の本文", { timeout: 15_000 });
});
