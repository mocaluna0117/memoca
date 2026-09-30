import { expect, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, signUp, waitForSynced } from "./helpers";
import { natural, noteImages, pasteHtml, pasteImage, uploadsDrained } from "./image-helpers";
import { readTable } from "./local-db";
import { createVaultInSettings, enterVaultPassword, vaultPrompt } from "./vault-helpers";

type AttachmentRow = { attachmentId: string; noteId: string; status: string; locked: boolean };

const attachments = (page: Page) => readTable<AttachmentRow>(page, "attachments");
const openNoteId = (page: Page) => new URL(page.url()).searchParams.get("n")!;
const ref = (attachmentId: string) => `memoca://att/${attachmentId}`;
/** The file the open note's first image block points at, as BlockNote renders it. */
const shownFile = (page: Page) =>
  page.locator('[data-content-type="image"]').first().getAttribute("data-url");

/**
 * Puts the caret under the image, which puts away the toolbar floating over
 * it: on a phone it covers the note's header, 戻る and the menu included.
 */
async function awayFromImage(page: Page) {
  const body = (await editor(page).boundingBox())!;
  await editor(page).click({ position: { x: body.width / 2, y: body.height - 8 } });
}

/** Locks the open note from its menu, opening the vault if it asks. */
async function lockOpenNote(page: Page) {
  await awayFromImage(page);
  await page.getByRole("button", { name: "メモの操作" }).filter({ visible: true }).click();
  await page.getByRole("menuitem", { name: "ロックする", exact: true }).click();
  const done = page.getByText("メモをロックしました");
  const asks = vaultPrompt(page).getByLabel("金庫のパスワード", { exact: true });
  await expect(done.or(asks).first()).toBeVisible({ timeout: 30_000 });
  if (await asks.isVisible()) await enterVaultPassword(page, "ロックする");
  await expect(done).toBeVisible({ timeout: 60_000 });
}

test.describe("an image copied out of a locked note", () => {
  test("gets a plaintext copy of its own in a note that is not locked, shown with the vault closed", async ({
    page,
  }) => {
    test.slow();
    await signUp(page);
    await openApp(page);
    await createVaultInSettings(page);
    // A full navigation closes the vault; the lock asks for it again.
    await openApp(page);

    // A locked note with an image of its own, which is encrypted with it.
    await createNote(page, "ロックしたメモ");
    const source = openNoteId(page);
    await pasteImage(page);
    await awayFromImage(page);
    await uploadsDrained(page);
    await waitForSynced(page);
    await lockOpenNote(page);
    await waitForSynced(page);
    await expect.poll(async () => (await attachments(page))[0]?.locked).toBe(true);
    const [original] = await attachments(page);
    expect(original).toMatchObject({ noteId: source, locked: true });

    // Pasted into an ordinary note while the vault is open: the note is
    // pointed at a plaintext copy of its own.
    await createNote(page, "ロックしていないメモ");
    const plain = openNoteId(page);
    await pasteHtml(page, `<img src="${ref(original!.attachmentId)}" alt="コピー">`);
    await expect
      .poll(() => shownFile(page), { timeout: 15_000 })
      .not.toBe(ref(original!.attachmentId));
    const copy = (await attachments(page)).find((row) => row.noteId === plain);
    expect(copy).toMatchObject({ noteId: plain, locked: false });
    expect(await shownFile(page)).toBe(ref(copy!.attachmentId));
    await expect
      .poll(() => natural(noteImages(page).first()), { timeout: 30_000 })
      .toEqual({
        w: 400,
        h: 300,
      });
    await awayFromImage(page);

    // It reaches the server as an ordinary file; the original stays
    // encrypted with the note it belongs to.
    await uploadsDrained(page);
    await waitForSynced(page);
    await expect
      .poll(async () => {
        const row = (await attachments(page)).find((r) => r.attachmentId === copy!.attachmentId);
        return { noteId: row?.noteId, status: row?.status, locked: row?.locked };
      })
      .toEqual({ noteId: plain, status: "committed", locked: false });
    expect(
      (await attachments(page)).find((row) => row.attachmentId === original!.attachmentId),
    ).toMatchObject({
      noteId: source,
      locked: true,
    });

    // After a reload the vault is closed, and the note still shows the image.
    await page.reload();
    expect(openNoteId(page)).toBe(plain);
    await expect.poll(() => shownFile(page), { timeout: 30_000 }).toBe(ref(copy!.attachmentId));
    await expect
      .poll(() => natural(noteImages(page).first()), { timeout: 30_000 })
      .toEqual({
        w: 400,
        h: 300,
      });
    // It was closed all along: the locked note asks for it.
    const locked = new URL(page.url());
    locked.searchParams.set("n", source);
    await page.goto(locked.toString());
    await expect(
      page
        .getByRole("button", { name: "金庫を開く", exact: true })
        .filter({ visible: true })
        .first(),
    ).toBeVisible({ timeout: 30_000 });
  });
});
