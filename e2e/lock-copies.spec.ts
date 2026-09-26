import { expect, type Page, test } from "@playwright/test";
import {
  createNote,
  editor,
  folderPanel,
  hideFolders,
  openApp,
  showList,
  signUp,
  waitForSynced,
} from "./helpers";
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

async function openNote(page: Page, title: RegExp) {
  await showList(page);
  await page.getByRole("button", { name: title }).filter({ visible: true }).first().click();
}

/** Adds a folder, 「新しいフォルダ」. */
async function addFolder(page: Page) {
  const panel = await folderPanel(page);
  await panel.getByRole("button", { name: "フォルダを追加" }).click();
  await expect(panel.getByRole("button", { name: "新しいフォルダ", exact: true })).toBeVisible();
  await hideFolders(page);
}

/** Shows a folder's notes, or every note for 「すべてのメモ」. */
async function openFolder(page: Page, name: string) {
  const panel = await folderPanel(page);
  await panel.getByRole("button", { name: new RegExp(`^${name}`) }).first().click();
  await hideFolders(page);
}

/** Locks a folder of one note from its menu, opening the vault if it asks. */
async function lockFolder(page: Page, name: string) {
  const panel = await folderPanel(page);
  await panel.getByRole("button", { name: `${name} の操作` }).click();
  await page.getByRole("menuitem", { name: "ロックする…" }).click();
  const confirm = vaultPrompt(page).getByRole("button", { name: "ロックする", exact: true });
  await expect(confirm).toBeVisible();
  const asks = vaultPrompt(page).getByLabel("金庫のパスワード", { exact: true });
  if (await asks.isVisible()) await enterVaultPassword(page, "ロックする");
  else await confirm.click();
  await expect(page.getByText(`フォルダ「${name}」をロックしました（メモ 1 件）`)).toBeVisible({
    timeout: 60_000,
  });
  await hideFolders(page);
}

test.describe("an image copied into a locked note", () => {
  test("gets a copy of its own: at once while the note is open, or when it is locked", async ({
    page,
    context,
  }) => {
    test.slow();
    await signUp(page);
    await openApp(page);
    await createVaultInSettings(page);
    // A full navigation closes the vault; the first lock asks for it again.
    await openApp(page);

    // An ordinary note with an image of its own.
    await createNote(page, "画像の元");
    const source = openNoteId(page);
    await pasteImage(page);
    await awayFromImage(page);
    await uploadsDrained(page);
    await waitForSynced(page);
    const [original] = await attachments(page);
    expect(original).toMatchObject({ noteId: source, locked: false });
    const copyHtml = `<img src="${ref(original!.attachmentId)}" alt="コピー">`;

    // Pasted into a note that is locked and open. Offline, so only the open
    // editor can act on it: the repair pass needs the network.
    await createNote(page, "ロックしたメモ");
    const locked = openNoteId(page);
    await lockOpenNote(page);
    await context.setOffline(true);
    await pasteHtml(page, copyHtml);
    await expect.poll(() => shownFile(page), { timeout: 15_000 }).not.toBe(ref(original!.attachmentId));
    const first = (await attachments(page)).find(
      (row) => row.noteId === locked && row.attachmentId !== original!.attachmentId,
    );
    expect(first).toMatchObject({ locked: true });
    expect(await shownFile(page)).toBe(ref(first!.attachmentId));
    await expect.poll(() => natural(noteImages(page).first()), { timeout: 30_000 }).toEqual({
      w: 400,
      h: 300,
    });
    await awayFromImage(page);
    // Back online the service worker reloads the page, which closes the vault.
    await Promise.all([page.waitForEvent("load"), context.setOffline(false)]);
    await openApp(page);

    // Pasted into an ordinary note that is then locked: the lock makes the
    // copy before it seals the note, so it is there when the lock is done.
    await createNote(page, "あとでロックするメモ");
    const later = openNoteId(page);
    await pasteHtml(page, copyHtml);
    await expect.poll(() => natural(noteImages(page).first()), { timeout: 30_000 }).toEqual({
      w: 400,
      h: 300,
    });
    expect(await shownFile(page)).toBe(ref(original!.attachmentId));
    await waitForSynced(page);
    // Left as it is while it is an ordinary note, however long it is open:
    // only the lock makes a copy.
    await page.waitForTimeout(2_000);
    expect((await attachments(page)).filter((row) => row.noteId === later)).toEqual([]);
    expect(await shownFile(page)).toBe(ref(original!.attachmentId));
    await lockOpenNote(page);
    // Sealed together with its copy: not "copies still to be encrypted".
    await expect(page.getByText("メモをロックしました", { exact: true })).toBeVisible();
    const second = (await attachments(page)).find(
      (row) => row.noteId === later && row.attachmentId !== original!.attachmentId,
    );
    expect(second).toBeDefined();
    expect(await shownFile(page)).toBe(ref(second!.attachmentId));

    // In a folder locked while the note is not open, only the lock itself can
    // make the copy: the note is sealed as it is, copy and all, with nothing
    // left to change afterwards. The last message has to go first: on a
    // phone it covers the menu, and pointing at it keeps it there.
    await expect(page.getByText("メモをロックしました", { exact: true })).toBeHidden({ timeout: 15_000 });
    await addFolder(page);
    await openFolder(page, "新しいフォルダ");
    await createNote(page, "フォルダのメモ");
    const filed = openNoteId(page);
    await pasteHtml(page, copyHtml);
    await expect.poll(() => natural(noteImages(page).first()), { timeout: 30_000 }).toEqual({
      w: 400,
      h: 300,
    });
    await awayFromImage(page);
    await waitForSynced(page);
    await openFolder(page, "すべてのメモ");
    await openNote(page, /画像の元/);
    await lockFolder(page, "新しいフォルダ");
    const third = (await attachments(page)).find(
      (row) => row.noteId === filed && row.attachmentId !== original!.attachmentId,
    );
    expect(third).toBeDefined();
    const edits = await readTable<{ noteId: string }>(page, "updates");
    expect(edits.filter((row) => row.noteId === filed)).toEqual([]);

    // Every copy reaches the server encrypted; the original is still the
    // first note's, as it was.
    await uploadsDrained(page);
    await waitForSynced(page);
    const byNote = (x: { noteId: string }, y: { noteId: string }) => (x.noteId < y.noteId ? -1 : 1);
    await expect
      .poll(async () =>
        (await attachments(page))
          .filter((row) => row.attachmentId !== original!.attachmentId)
          .map((row) => ({ noteId: row.noteId, status: row.status, locked: row.locked }))
          .sort(byNote),
      )
      .toEqual(
        [
          { noteId: locked, status: "committed", locked: true },
          { noteId: later, status: "committed", locked: true },
          { noteId: filed, status: "committed", locked: true },
        ].sort(byNote),
      );
    expect((await attachments(page)).find((row) => row.attachmentId === original!.attachmentId)).toMatchObject({
      noteId: source,
      locked: false,
    });
    // No plaintext of any copy is kept on the device.
    const cached = (await readTable<{ attachmentId: string }>(page, "blobs")).map((row) => row.attachmentId);
    for (const copy of [first, second, third]) expect(cached).not.toContain(copy!.attachmentId);

    // After a reload every note still points at its own copy.
    await openNote(page, /あとでロックするメモ/);
    await page.reload();
    await page
      .getByRole("button", { name: "金庫を開く", exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await enterVaultPassword(page, "開く");
    await expect.poll(() => shownFile(page), { timeout: 30_000 }).toBe(ref(second!.attachmentId));
    await openNote(page, /ロックしたメモ/);
    await expect.poll(() => shownFile(page), { timeout: 30_000 }).toBe(ref(first!.attachmentId));
    await openNote(page, /フォルダのメモ/);
    await expect.poll(() => shownFile(page), { timeout: 30_000 }).toBe(ref(third!.attachmentId));
  });
});
