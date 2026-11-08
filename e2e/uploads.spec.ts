import { expect, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, signUp, waitForSynced } from "./helpers";
import { pasteFile, uploadsDrained } from "./image-helpers";
import { clearTable, readTable } from "./local-db";

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
    await pasteFile(page, {
      name: "資料.docx",
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: 4096,
    });
    await expect(page.getByText("この種類のファイルは追加できません", { exact: false })).toBeVisible();
    await nothingKept(page);
  });

  test("several files pasted at once all go in, one turned away among them or not", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "まとめて");
    await editor(page).click();
    // A Word file (turned away) and two pictures, in one paste, as from Finder.
    await editor(page).evaluate(async (target: HTMLElement) => {
      const picture = async (fill: string) => {
        const canvas = document.createElement("canvas");
        canvas.width = 40;
        canvas.height = 30;
        const context = canvas.getContext("2d")!;
        context.fillStyle = fill;
        context.fillRect(0, 0, 40, 30);
        return new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"));
      };
      const data = new DataTransfer();
      data.items.add(new File([await picture("#ff0000")], "一.png", { type: "image/png" }));
      data.items.add(
        new File([new Uint8Array(64)], "資料.docx", {
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
      );
      data.items.add(new File([await picture("#0000ff")], "二.png", { type: "image/png" }));
      target.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });
    await expect(page.locator('[data-content-type="image"] img.bn-visual-media')).toHaveCount(2, {
      timeout: 20_000,
    });
    await uploadsDrained(page);
  });

  test("a PDF goes into an ordinary note, is stored on the server, and is saved again under its name", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the download is pressed for with a mouse");
    await signUp(page);
    await openApp(page);
    await createNote(page, "見積もり");
    await pasteFile(page, { name: "見積書.pdf", type: "application/pdf", size: 4096 });
    const block = page.locator('[data-content-type="file"]').first();
    await expect(block).toContainText("見積書.pdf", { timeout: 30_000 });
    await uploadsDrained(page);
    await waitForSynced(page);
    await expect
      .poll(async () => (await readTable(page, "attachments")).map((row) => [row.mime, row.locked]))
      .toEqual([["application/pdf", false]]);

    // Not kept on this device: fetched from the server.
    await clearTable(page, "blobs");
    await page.reload();
    await expect(block).toContainText("見積書.pdf", { timeout: 30_000 });
    const saving = page.waitForEvent("download", { timeout: 20_000 });
    await block.click();
    await page.getByRole("button", { name: "ファイルをダウンロード", exact: true }).click();
    const saved = await saving;
    expect(saved.suggestedFilename()).toBe("見積書.pdf");
  });
});
