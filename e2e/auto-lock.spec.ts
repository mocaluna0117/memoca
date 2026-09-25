import { expect, test } from "@playwright/test";
import { openApp, signUp } from "./helpers";
import { createVaultInSettings } from "./vault-helpers";

test.describe("the vault closes by itself", () => {
  test("after a minute of no use, not a minute after opening, and it says so", async ({ page }) => {
    // Fake time in the page, flowing normally until jumped forward.
    await page.clock.install();
    await signUp(page);
    await openApp(page);
    await createVaultInSettings(page);

    await page.getByRole("combobox").filter({ hasText: "分" }).click();
    await page.getByRole("option", { name: "1 分" }).click();
    const open = page.getByText("金庫：開いています");
    await expect(open).toBeVisible();

    // Used after 50 seconds: that restarts the minute.
    await page.clock.fastForward(50_000);
    await page.mouse.click(10, 300);
    await page.clock.fastForward(50_000);
    await expect(open).toBeVisible();

    // Then nothing for longer than a minute.
    await page.clock.fastForward(70_000);
    await expect(page.getByText("金庫を閉じました（1 分間操作がなかったため）")).toBeVisible();
    await expect(page.getByText("金庫：閉じています")).toBeVisible();
  });

  test("closing by hand from the badge closes it at once", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createVaultInSettings(page);
    await openApp(page);
    // A full navigation closed it; open it again from Settings.
    await page.goto("/app/settings");
    await page.getByRole("button", { name: "金庫を開く", exact: true }).click();
    const dialog = page.locator('[role="dialog"][data-slot="dialog-content"]');
    await dialog.getByLabel("金庫のパスワード", { exact: true }).fill("e2e-vault-password");
    await dialog.getByRole("button", { name: "開く", exact: true }).click();
    await expect(page.getByText("金庫：開いています")).toBeVisible({ timeout: 30_000 });

    // The badge sits in the sidebar, which on a phone is the folder drawer.
    const narrow = (page.viewportSize()?.width ?? 1280) < 768;
    if (narrow) await page.getByRole("button", { name: "メニューを開く" }).first().click();
    const panel = narrow ? page.locator('[role="dialog"][data-state="open"]').first() : page.locator("aside");
    await panel.getByRole("button", { name: "金庫：開いています" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "いますぐ閉じる" }).click();
    await expect(page.getByText("金庫を閉じました", { exact: true })).toBeVisible();
    await expect(page.getByText("金庫：閉じています")).toBeVisible();
  });
});
