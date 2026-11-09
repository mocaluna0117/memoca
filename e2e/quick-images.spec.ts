import { expect, type Page, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { editor, quickField, signUp, writeQuick } from "./helpers";
import { natural, noteImages, uploadsDrained } from "./image-helpers";
import { readTable } from "./local-db";

const field = (page: Page) => quickField(page);
/** The images in the quick note's field, as they are drawn there. */
const imagesIn = (page: Page) => field(page).locator('[data-content-type="image"] img.bn-visual-media');
/** The field's blocks, one a line: "image" for an image, a line's text for a line. */
const blocksIn = (page: Page) =>
  field(page).evaluate((root) =>
    [...root.querySelectorAll(".bn-block-content")].map((block) =>
      (block as HTMLElement).dataset.contentType === "image" ? "image" : (block.textContent ?? ""),
    ),
  );

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
  test("pasted where the caret is, shown there, and saved into the note there", async ({ page }) => {
    await signUp(page);
    await page.goto("/quick");
    await writeQuick(field(page), "上の行\n下の行");
    await field(page).locator(".bn-inline-content", { hasText: /^上の行$/ }).click();
    await pasteInto(page, { name: "景色.png" });
    await expect(imagesIn(page)).toHaveCount(1);
    await expect.poll(() => natural(imagesIn(page).first()), { timeout: 30_000 }).toEqual({ w: 400, h: 300 });
    await expect.poll(() => blocksIn(page)).toEqual(["上の行", "image", "下の行"]);

    await page.getByRole("button", { name: "保存" }).click();
    await expect(page).toHaveURL(/\/app\?n=/);
    const noteId = new URL(page.url()).searchParams.get("n")!;
    await expect.poll(() => natural(noteImages(page).first()), { timeout: 30_000 }).toEqual({ w: 400, h: 300 });
    // In the note where it was put, between the lines.
    await expect
      .poll(() =>
        editor(page).evaluate((root) =>
          [...root.querySelectorAll(".bn-block-content")].map((block) =>
            (block as HTMLElement).dataset.contentType === "image" ? "image" : (block.textContent ?? ""),
          ),
        ),
      )
      .toEqual(["上の行", "image", "下の行"]);
    // Sent as it was pasted, as the tab's note's file (made smaller on the
    // way, WebP), and used by the note saved from it, not sent again.
    await uploadsDrained(page);
    const files = await readTable<{ noteId: string; mime: string; status: string }>(page, "attachments");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ noteId: expect.stringMatching(/^quick-tab-/), mime: "image/webp" });
    expect(noteId).not.toMatch(/^quick-tab-/);
  });

  test("chosen by its button, put in where the caret is, taken out again, and saved alone, with no text", async ({
    page,
  }, testInfo) => {
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
    // Into the empty line the caret was in.
    await expect(imagesIn(page)).toHaveCount(1);
    await expect.poll(() => blocksIn(page)).toEqual(["image"]);
    await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
    // Taken out as any block is: nothing left to save.
    await imagesIn(page).first().click();
    await page.keyboard.press("Backspace");
    await expect(imagesIn(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();

    await choose();
    await expect(page.getByRole("button", { name: "保存" })).toBeEnabled();
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page).toHaveURL(/\/app\?n=/);
    await expect(noteImages(page)).toHaveCount(1, { timeout: 30_000 });
  });

  test("kept in the draft, where they were put, and come back with it", async ({ page }) => {
    await signUp(page);
    await page.goto("/quick");
    await writeQuick(field(page), "上の行\n下の行");
    await field(page).locator(".bn-inline-content", { hasText: /^上の行$/ }).click();
    await pasteInto(page, { name: "下書きの画像.png" });
    await expect.poll(() => blocksIn(page)).toEqual(["上の行", "image", "下の行"]);
    // Written once the typing (here, the adding) pauses.
    await page.waitForTimeout(800);
    await page.goto("/app");
    await page.goto("/quick");
    await expect.poll(() => blocksIn(page)).toEqual(["上の行", "image", "下の行"]);
    await expect.poll(() => natural(imagesIn(page).first()), { timeout: 30_000 }).toEqual({ w: 400, h: 300 });
  });

  test("a file not an image, or an image this browser cannot read, is turned away with the reason, leaving nothing", async ({
    page,
  }) => {
    await signUp(page);
    await page.goto("/quick");
    await writeQuick(field(page), "メモ");
    await pasteInto(page, { name: "資料.pdf", type: "application/pdf" });
    await expect(page.getByRole("status")).toContainText("即席メモに入れられるのは、文字と画像だけです");
    await pasteInto(page, { name: "IMG_0001.HEIC", type: "image/heic" });
    await expect(page.getByRole("status")).toContainText("HEIC 形式の画像は");
    // No block left for either: the line as it was.
    await expect.poll(async () => (await blocksIn(page)).filter((line) => line !== "")).toEqual(["メモ"]);
    await expect(field(page).locator('[data-content-type="image"], [data-content-type="file"]')).toHaveCount(0);
  });
});
