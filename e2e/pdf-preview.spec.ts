import { expect, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, signUp, waitForSynced } from "./helpers";
import { pasteFile, uploadsDrained } from "./image-helpers";
import { clearTable } from "./local-db";
import { drawnRed, pastePdf } from "./pdf-helpers";
import { createVaultInSettings, enterVaultPassword } from "./vault-helpers";

const card = (page: Page) => page.locator(".memoca-pdf").first();

/** Locks the open note. */
async function lockTheNote(page: Page) {
  const body = (await editor(page).boundingBox())!;
  await editor(page).click({ position: { x: body.width / 2, y: body.height - 8 } });
  await page.getByRole("button", { name: "メモの操作" }).filter({ visible: true }).click();
  await page.getByRole("menuitem", { name: "ロックする", exact: true }).click();
  await enterVaultPassword(page, "ロックする");
  await expect(page.getByText("メモをロックしました")).toBeVisible({ timeout: 30_000 });
  await waitForSynced(page);
}

test.describe("a PDF in a note", () => {
  test("shows its first page and how many pages it has, and opens to every page", async ({ page }) => {
    test.slow();
    await signUp(page);
    await openApp(page);
    await createNote(page, "書類");
    await pastePdf(page, { name: "職務経歴書.pdf", pages: 3 });
    await expect(card(page)).toContainText("職務経歴書.pdf", { timeout: 30_000 });
    await expect(card(page)).toContainText("3 ページ");
    await expect.poll(() => drawnRed(card(page).locator("canvas"))).toBe(true);

    // Read again from the server, as another device would.
    await uploadsDrained(page);
    await waitForSynced(page);
    await clearTable(page, "blobs");
    await page.reload();
    await expect.poll(() => drawnRed(card(page).locator("canvas")), { timeout: 30_000 }).toBe(true);

    await card(page).getByRole("button", { name: "職務経歴書.pdf を開く" }).click();
    const viewer = page.getByRole("dialog", { name: "職務経歴書.pdf" });
    await expect(viewer).toBeVisible();
    await expect(viewer.locator("[data-page]")).toHaveCount(3);
    await expect.poll(() => drawnRed(viewer.locator('[data-page="1"] canvas'))).toBe(true);
    // The last page, drawn once it is scrolled to.
    await viewer.locator('[data-page="3"]').scrollIntoViewIfNeeded();
    await expect.poll(() => drawnRed(viewer.locator('[data-page="3"] canvas'))).toBe(true);

    const first = viewer.locator('[data-page="1"]');
    const before = (await first.boundingBox())!.width;
    await viewer.getByRole("button", { name: "拡大" }).click();
    await expect.poll(async () => (await first.boundingBox())!.width).toBeGreaterThan(before);
    await viewer.getByRole("button", { name: "幅に合わせる" }).click();
    await expect.poll(async () => Math.round((await first.boundingBox())!.width)).toBe(Math.round(before));

    await viewer.getByRole("button", { name: "閉じる" }).click();
    await expect(viewer).toBeHidden();
    await expect(card(page)).toBeVisible();
  });

  test("in a locked note, shows its first page too, decrypted here", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the lock is the same on a phone");
    test.slow();
    await signUp(page);
    await openApp(page);
    await createVaultInSettings(page);
    await openApp(page);
    await createNote(page, "秘密の書類");
    await lockTheNote(page);
    await pastePdf(page, { name: "契約書.pdf", pages: 2 });
    await expect(card(page)).toContainText("2 ページ", { timeout: 30_000 });
    await expect.poll(() => drawnRed(card(page).locator("canvas"))).toBe(true);
    await uploadsDrained(page);
    await page.reload();
    await page
      .getByRole("button", { name: "金庫を開く", exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await enterVaultPassword(page, "開く");
    await expect.poll(() => drawnRed(card(page).locator("canvas")), { timeout: 30_000 }).toBe(true);
  });

  test("a file named .pdf that is not one shows by its name, as any other file", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "壊れた書類");
    await pasteFile(page, { name: "壊れた.pdf", type: "application/pdf", size: 4096 });
    const block = page.locator('[data-content-type="file"]').first();
    await expect(block.locator(".bn-file-name-with-icon")).toContainText("壊れた.pdf", { timeout: 30_000 });
    await expect(card(page)).toHaveCount(0);
  });
});
