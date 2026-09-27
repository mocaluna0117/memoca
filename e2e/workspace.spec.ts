import { expect, test } from "@playwright/test";
import { createNote, editor, offlineReady, openApp, signUp, waitForSynced } from "./helpers";
import { createVaultInSettings } from "./vault-helpers";

test.describe("the workspace", () => {
  test("going to the quick note and back leaves the vault open", async ({ page }, testInfo) => {
    // The quick note is reached from the phone's bottom bar; a computer gets its own way in later.
    test.skip(testInfo.project.name !== "mobile", "the bottom bar is the phone's");
    await signUp(page);
    await openApp(page);
    await createVaultInSettings(page);
    const open = page.getByText("金庫：開いています");
    await expect(open).toBeVisible();

    // Within the app, not a page load: the vault would close with one.
    const bar = page.getByRole("navigation").filter({ visible: true }).last();
    await bar.getByRole("link", { name: "即席メモ" }).click();
    await expect(page.getByLabel("即席メモ")).toBeVisible();
    await page.getByRole("button", { name: "戻る" }).click();
    await expect(page).toHaveURL(/\/app$/);
    await bar.getByRole("link", { name: "設定" }).click();
    await expect(open).toBeVisible();
  });

  test("the network coming back does not reload the page, or lose what is being written", async ({
    page,
    context,
  }) => {
    await signUp(page);
    await openApp(page);
    await offlineReady(page);
    await createNote(page, "書きかけ");
    await waitForSynced(page);
    await page.evaluate(() => {
      (window as unknown as { stayed: boolean }).stayed = true;
    });

    await context.setOffline(true);
    await editor(page).click();
    await page.keyboard.type("つながる直前に書いた");
    // Straight back, before the edit has been saved: nothing throws it away.
    await context.setOffline(false);
    await waitForSynced(page);

    expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(
      true,
    );
    await expect(editor(page)).toContainText("つながる直前に書いた");
  });
});
