import { expect, type Page, test } from "@playwright/test";
import { createNote, openApp, signUp, waitForSynced } from "./helpers";
import { noteImages, pasteImage, uploadsDrained } from "./image-helpers";
import { readTable } from "./local-db";

type NoteRow = { noteId: string; title: string | null; lastUpdateSeq: number; refsThroughSeq?: number };

/** The server's record of what the note uses has caught up with its latest change. */
async function reported(page: Page, title: string): Promise<number> {
  let seq = 0;
  await expect
    .poll(
      async () => {
        const note = (await readTable<NoteRow>(page, "notes")).find((n) => n.title === title);
        if (!note || note.lastUpdateSeq === 0) return false;
        seq = note.lastUpdateSeq;
        return note.refsThroughSeq === note.lastUpdateSeq;
      },
      // A report goes out on a sync pass at most every 20 seconds.
      { timeout: 60_000, intervals: [1_000] },
    )
    .toBe(true);
  return seq;
}

test.describe("which files a note uses", () => {
  test.skip(({ isMobile }) => isMobile, "the same sync code on every device; the toolbar path is simplest here");

  test("is reported to the server after adding an image and again after removing it", async ({ page }) => {
    test.slow();
    await signUp(page);
    await openApp(page);
    await createNote(page, "画像のメモ", "本文");
    const image = await pasteImage(page);
    await uploadsDrained(page);
    await waitForSynced(page);
    const withImage = await reported(page, "画像のメモ");

    await image.click();
    await page.getByRole("button", { name: "画像を削除" }).click();
    await expect(noteImages(page)).toHaveCount(0);
    await waitForSynced(page);
    await expect
      .poll(async () => (await readTable<NoteRow>(page, "notes")).find((n) => n.title === "画像のメモ")?.lastUpdateSeq)
      .toBeGreaterThan(withImage);
    expect(await reported(page, "画像のメモ")).toBeGreaterThan(withImage);

    // The file itself stays: it is deleted by the server only after 30 days unused.
    const files = await readTable<{ deletedAt: number | null }>(page, "attachments");
    expect(files).toHaveLength(1);
    expect(files[0]!.deletedAt).toBeNull();
  });
});
