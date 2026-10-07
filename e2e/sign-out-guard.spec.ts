import { expect, test } from "@playwright/test";
import { createNote, openApp, signUp, waitForSynced } from "./helpers";

test.describe("signing out with what only this device has", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the settings page, on a computer");
  });

  test("a quick note not saved: asked first, kept by default; saved, signed out at once", async ({ page }) => {
    await signUp(page);
    await page.goto("/quick");
    await page.getByLabel("即席メモ", { exact: true }).fill("書きかけの考え");
    // Written as a draft before leaving the page.
    await page.waitForTimeout(800);

    await page.goto("/app/settings");
    await page.getByRole("button", { name: "ログアウト", exact: true }).click();
    const dialog = page.getByRole("alertdialog", { name: /まだ送っていない内容があります/ });
    await expect(dialog).toContainText("保存していない即席メモ 1 件");
    await dialog.getByRole("button", { name: "ログアウトしない" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/app\/settings$/);

    // Saved, there is nothing to lose.
    await page.goto("/quick");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page).toHaveURL(/\/app\?n=/);
    await waitForSynced(page);
    await page.goto("/app/settings");
    await page.getByRole("button", { name: "ログアウト", exact: true }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
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
