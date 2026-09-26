import { expect, test } from "@playwright/test";
import { createNote, openApp, signUp, waitForSynced } from "./helpers";
import { pasteImage, uploadsDrained } from "./image-helpers";

test.describe("storage in Settings", () => {
  test("says where the storage goes, and opens the note a large file is in", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "写真のメモ");
    const noteId = new URL(page.url()).searchParams.get("n")!;
    await pasteImage(page);
    await uploadsDrained(page);
    await waitForSynced(page);

    await page.goto("/app/settings");
    // Only what this account holds: one image, and the text of one note.
    const breakdown = page.getByRole("img", {
      name: /^画像 [\d.]+ K?B、メモの本文 [\d.]+ K?B、空き [\d.]+ [KMG]?B$/,
    });
    await expect(breakdown).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("空き", { exact: true })).toBeVisible();
    await expect(page.getByText("大きいファイル", { exact: true })).toBeVisible();
    // Nothing to tell an ordinary account about the running total.
    await expect(page.getByText(/管理者向け/)).toHaveCount(0);

    // The pasted image, in the note it was pasted into.
    const file = page.getByRole("button", { name: /e2e\.png.*「写真のメモ」/ });
    await expect(file).toBeVisible();
    await file.click();
    await expect(page).toHaveURL(new RegExp(`/app\\?n=${noteId}`));
  });
});
