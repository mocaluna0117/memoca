import { expect, test } from "@playwright/test";
import {
  createNote,
  offlineReady,
  editor,
  openApp,
  showList,
  signIn,
  signUp,
  waitForSynced,
} from "./helpers";

test.describe("offline", () => {
  test("a note written with no network reaches the server afterwards", async ({
    page,
    context,
  }) => {
    const email = await signUp(page);
    await openApp(page);
    await offlineReady(page);
    await createNote(page, "オンラインのメモ");
    await waitForSynced(page);

    await context.setOffline(true);
    await createNote(page, "圏外のメモ", "電波がなくても書ける");
    await showList(page);
    await expect(page.getByText("圏外のメモ").filter({ visible: true }).first()).toBeVisible();

    await context.setOffline(false);
    await waitForSynced(page);

    // A second, empty browser profile can only see it if it really synced.
    const fresh = await context.browser()!.newContext({
      baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
      viewport: page.viewportSize(),
    });
    const other = await fresh.newPage();
    await signIn(other, email);
    await openApp(other);
    await showList(other);
    await expect(other.getByText("圏外のメモ").filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
    await fresh.close();
  });

  test("an edit made offline survives a reload", async ({ page, context }) => {
    await signUp(page);
    await openApp(page);
    await offlineReady(page);
    await createNote(page, "下書き");
    await waitForSynced(page);

    await context.setOffline(true);
    await editor(page).click();
    await page.keyboard.type("オフラインで書いた本文");
    await page.waitForTimeout(1500);

    await page.reload();
    await showList(page);
    await expect(page.getByText("下書き").filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
    await page.getByText("下書き").filter({ visible: true }).first().click();
    await expect(editor(page)).toContainText("オフラインで書いた本文");

    await context.setOffline(false);
    await waitForSynced(page);
  });
});
