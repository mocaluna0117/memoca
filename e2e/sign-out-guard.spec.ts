import { expect, test } from "@playwright/test";
import { createNote, openApp, signIn, signUp, waitForSynced } from "./helpers";

test.describe("signing out with what only this device has", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the settings page, on a computer");
  });

  test("a quick note not saved, once sent, is the account's: signed out at once, and there on signing in again", async ({
    page,
  }) => {
    const email = await signUp(page);
    await page.goto("/quick");
    await page.getByLabel("即席メモ", { exact: true }).click();
    await page.keyboard.insertText("書きかけの考え");
    // Sent as any edit is: its tab is a note of the account's.
    await page.waitForTimeout(800);
    await page.goto("/app/settings");
    await waitForSynced(page);
    await page.getByRole("button", { name: "ログアウト", exact: true }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });

    await signIn(page, email);
    await page.goto("/quick");
    await expect(page.getByLabel("即席メモ", { exact: true })).toContainText("書きかけの考え", { timeout: 30_000 });
  });

  test("changes not sent, with no network: asked, and signed out only if chosen", async ({ page, context }) => {
    await signUp(page);
    await openApp(page);
    await page.goto("/app/settings");
    await openApp(page);
    await waitForSynced(page);

    await context.setOffline(true);
    await createNote(page, "送れないメモ");
    await page.locator("aside").getByRole("link", { name: "設定" }).click();
    await page.getByRole("button", { name: "ログアウト", exact: true }).click();
    const dialog = page.getByRole("alertdialog", { name: /まだ送っていない内容があります/ });
    await expect(dialog).toContainText("サーバーに送っていない変更");
    await dialog.getByRole("button", { name: "消えてもよいのでログアウト" }).click();
    await expect.poll(() => page.evaluate(() => location.pathname), { timeout: 20_000 }).not.toBe("/app/settings");
  });
});
