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

  test("an image taken out of its note is counted as unused, and is kept from an early delete for a while", async ({
    page,
  }) => {
    test.slow();
    await signUp(page);
    await openApp(page);
    await createNote(page, "消す写真");
    const image = await pasteImage(page);
    await uploadsDrained(page);
    await waitForSynced(page);

    // Out of the note: selected, then deleted.
    await image.click();
    await page.keyboard.press("Backspace");
    await expect(image).toHaveCount(0);
    await waitForSynced(page);

    // Once the note has reported it no longer uses it, the settings say so.
    await page.goto("/app/settings");
    const unused = page.getByText("使われなくなったファイル", { exact: true });
    await expect
      .poll(
        async () => {
          await page.getByRole("button", { name: "更新" }).click();
          return unused.isVisible();
        },
        { timeout: 60_000, intervals: [3_000] },
      )
      .toBe(true);

    // Unused for less than ten minutes: a paste might still use it, so it stays.
    await page.getByRole("button", { name: "今すぐ削除" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "今すぐ削除" }).click();
    await expect(page.getByText("今すぐ削除できるファイルはありませんでした")).toBeVisible();
    await expect(unused).toBeVisible();
  });
});
