import { expect, type Page, test } from "@playwright/test";
import { createNote, openApp, signUp } from "./helpers";
import { pasteFile } from "./image-helpers";
import { readTable } from "./local-db";

/** Nothing of a refused file is kept: no file waiting, no row, no block left loading. */
async function nothingKept(page: Page) {
  expect(await readTable(page, "pendingUploads")).toEqual([]);
  expect(await readTable(page, "attachments")).toEqual([]);
  await expect(page.locator('[data-content-type="image"], [data-content-type="file"]')).toHaveCount(0);
  await expect(page.locator(".bn-file-loading-preview")).toHaveCount(0);
}

test.describe("adding a file to a note", () => {
  test("an image this browser cannot read is turned away with the reason, and nothing is kept", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "写真を貼る");
    // A HEIC photo from an iPhone: Chrome cannot read it, and the server does
    // not take it.
    const said = page.getByText("HEIC 形式の画像は、このブラウザでは読み込めません", { exact: false });
    await pasteFile(page, { name: "IMG_0001.HEIC", type: "image/heic", size: 4096 });
    await expect(said).toBeVisible();
    await nothingKept(page);
    // Put away, so the next one is seen to say it again.
    await page.getByRole("button", { name: "Close toast" }).first().click();
    await expect(said).toBeHidden();

    // The same with no type at all, as some systems hand it over: told by its name.
    await pasteFile(page, { name: "IMG_0002.HEIC", type: "", size: 4096 });
    await expect(said).toBeVisible();
    await nothingKept(page);
  });

  test("a file of a type the server does not take is turned away in an ordinary note", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "資料を貼る");
    await pasteFile(page, { name: "資料.pdf", type: "application/pdf", size: 4096 });
    await expect(page.getByText("この種類のファイルは追加できません", { exact: false })).toBeVisible();
    await nothingKept(page);
  });
});
