import { expect, test } from "@playwright/test";
import { createNote, openApp, signUp } from "./helpers";
import { natural, noteImages, pastePicture } from "./image-helpers";
import { readTable } from "./local-db";

test.describe("an image is written by what it shows", () => {
  test("a phone's screenshot keeps its own size, and a photo is brought down to 2048", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "スクショと写真");

    // An iPhone's screenshot: shrunk to 2048 tall, as photos are, its text would blur.
    await pastePicture(page, { width: 1179, height: 2556, kind: "screen" });
    await expect
      .poll(() => natural(noteImages(page).first()), { timeout: 30_000 })
      .toEqual({ w: 1179, h: 2556 });

    await pastePicture(page, { width: 2400, height: 1800, kind: "photo" });
    await expect.poll(() => natural(noteImages(page).nth(1)), { timeout: 30_000 }).toEqual({ w: 2048, h: 1536 });

    // Both written again as WebP, not kept as the PNGs they came as.
    await expect
      .poll(async () => (await readTable<{ mime: string }>(page, "attachments")).map((row) => row.mime))
      .toEqual(["image/webp", "image/webp"]);
  });
});
