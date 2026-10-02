import { expect, type Page, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { editor, signUp } from "./helpers";
import { natural, noteImages, uploadsDrained } from "./image-helpers";
import { readTable } from "./local-db";

const field = (page: Page) => page.getByLabel("即席メモ");
const thumbnails = (page: Page) => page.getByRole("list", { name: "追加した画像" }).getByRole("img");

/** Pastes into the quick note's field a made-up picture (a PNG of four colours), or another file. */
async function pasteInto(page: Page, file: { name: string; type?: string; bytes?: number }) {
  await field(page).evaluate(async (target, options) => {
    let blob: Blob;
    if (options.type) {
      blob = new Blob([new Uint8Array(options.bytes ?? 2048).fill(7)], { type: options.type });
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 300;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#ff0000";
      context.fillRect(0, 0, 200, 150);
      context.fillStyle = "#0000ff";
      context.fillRect(200, 0, 200, 150);
      context.fillStyle = "#00ff00";
      context.fillRect(0, 150, 400, 150);
      blob = await new Promise<Blob>((resolve) => canvas.toBlob((made) => resolve(made!), "image/png"));
    }
    const data = new DataTransfer();
    data.items.add(new File([blob], options.name, { type: blob.type }));
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, file);
}

test.describe("images in the quick note", () => {
  test("pasted, shown under the field, and saved into the note under its lines", async ({ page }) => {
    await signUp(page);
    await page.goto("/quick");
    await field(page).fill("写真のメモ");
    await pasteInto(page, { name: "景色.png" });
    await expect(thumbnails(page)).toHaveCount(1);
    await expect(thumbnails(page).first()).toHaveAttribute("alt", "景色.png");

    await page.getByRole("button", { name: "保存" }).click();
    await expect(page).toHaveURL(/\/app\?n=/);
    const noteId = new URL(page.url()).searchParams.get("n")!;
    await expect(editor(page).locator('[data-content-type="paragraph"]').first()).toHaveText("写真のメモ");
    await expect.poll(() => natural(noteImages(page).first()), { timeout: 30_000 }).toEqual({ w: 400, h: 300 });
    // The note's own file, sent as any is, made smaller on the way (WebP).
    await uploadsDrained(page);
    const files = await readTable<{ noteId: string; mime: string; status: string }>(page, "attachments");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ noteId, mime: "image/webp" });
  });

  test("chosen by its button, taken off again, and saved alone, with no text", async ({ page }, testInfo) => {
    await signUp(page);
    await page.goto("/quick");
    const png = testInfo.outputPath("選んだ.png");
    // A 1×1 PNG.
    await writeFile(
      png,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const choose = async () => {
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "画像を追加" }).click();
      await (await chooser).setFiles(png);
    };
    await choose();
    await expect(thumbnails(page)).toHaveCount(1);
    await page.getByRole("button", { name: "選んだ.png を外す" }).click();
    await expect(thumbnails(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();

    await choose();
    await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page).toHaveURL(/\/app\?n=/);
    await expect(noteImages(page)).toHaveCount(1, { timeout: 30_000 });
  });

  test("kept in the draft, and come back with it", async ({ page }) => {
    await signUp(page);
    await page.goto("/quick");
    await pasteInto(page, { name: "下書きの画像.png" });
    await expect(thumbnails(page)).toHaveCount(1);
    // Written once the typing (here, the adding) pauses.
    await page.waitForTimeout(800);
    await page.goto("/app");
    await page.goto("/quick");
    await expect(thumbnails(page)).toHaveCount(1);
    await expect(thumbnails(page).first()).toHaveAttribute("alt", "下書きの画像.png");
    await expect(page.getByText("前回の下書きを戻しました")).toBeVisible();
  });

  test("a file not an image, or an image this browser cannot read, is turned away with the reason", async ({
    page,
  }) => {
    await signUp(page);
    await page.goto("/quick");
    await pasteInto(page, { name: "資料.pdf", type: "application/pdf" });
    await expect(page.getByRole("status")).toContainText("即席メモに入れられるのは、文字と画像だけです");
    await pasteInto(page, { name: "IMG_0001.HEIC", type: "image/heic" });
    await expect(page.getByRole("status")).toContainText("HEIC 形式の画像は");
    await expect(thumbnails(page)).toHaveCount(0);
  });
});
