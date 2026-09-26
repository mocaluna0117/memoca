import { expect, test } from "@playwright/test";
import {
  createNote,
  offlineReady,
  editor,
  openApp,
  showList,
  signIn,
  signUp,
  waitForSynced,
} from "./helpers";
import { natural, noteImages, pasteImage, uploadsDrained } from "./image-helpers";
import { readTable } from "./local-db";

test.describe("offline", () => {
  test("a note written with no network reaches the server afterwards", async ({
    page,
    context,
  }) => {
    const email = await signUp(page);
    await openApp(page);
    await offlineReady(page);
    await createNote(page, "オンラインのメモ");
    await waitForSynced(page);

    await context.setOffline(true);
    await createNote(page, "圏外のメモ", "電波がなくても書ける");
    await showList(page);
    await expect(page.getByText("圏外のメモ").filter({ visible: true }).first()).toBeVisible();

    await context.setOffline(false);
    await waitForSynced(page);

    // A second, empty browser profile can only see it if it really synced.
    const fresh = await context.browser()!.newContext({
      baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
      viewport: page.viewportSize(),
    });
    const other = await fresh.newPage();
    await signIn(other, email);
    await openApp(other);
    await showList(other);
    await expect(other.getByText("圏外のメモ").filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
    await fresh.close();
  });

  test("an image added to a note made offline goes up once the note has", async ({ page, context }) => {
    await signUp(page);
    await openApp(page);
    await offlineReady(page);
    await createNote(page, "オンラインのメモ");
    await waitForSynced(page);

    // The file waits to go up, and the note it belongs to too.
    await context.setOffline(true);
    await createNote(page, "圏外で貼った画像");
    const noteId = new URL(page.url()).searchParams.get("n")!;
    await pasteImage(page);
    await expect.poll(() => natural(noteImages(page).first()), { timeout: 30_000 }).toEqual({ w: 400, h: 300 });
    // Saved on this device first: the page reloads as the network returns,
    // and an edit still waiting its half second would not survive that.
    await expect
      .poll(async () =>
        (await readTable<{ noteId: string }>(page, "updates")).filter((row) => row.noteId === noteId).length,
      )
      .toBeGreaterThan(0);

    // Back online, the note and its file both go up. (Which the server hears
    // of first depends on the connection; tests/attachments.test.ts covers a
    // file arriving before its note.) The service worker reloads the page as
    // the network returns.
    await Promise.all([page.waitForEvent("load"), context.setOffline(false)]);
    await uploadsDrained(page);
    await waitForSynced(page);
    await expect
      .poll(async () =>
        (await readTable<{ noteId: string; status: string }>(page, "attachments"))
          .filter((row) => row.noteId === noteId)
          .map((row) => row.status),
      )
      .toEqual(["committed"]);
    await expect.poll(() => natural(noteImages(page).first()), { timeout: 30_000 }).toEqual({ w: 400, h: 300 });
  });

  test("an edit made offline survives a reload", async ({ page, context }) => {
    await signUp(page);
    await openApp(page);
    await offlineReady(page);
    await createNote(page, "下書き");
    await waitForSynced(page);

    await context.setOffline(true);
    await editor(page).click();
    await page.keyboard.type("オフラインで書いた本文");
    await page.waitForTimeout(1500);

    await page.reload();
    await showList(page);
    await expect(page.getByText("下書き").filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
    await page.getByText("下書き").filter({ visible: true }).first().click();
    await expect(editor(page)).toContainText("オフラインで書いた本文");

    await context.setOffline(false);
    await waitForSynced(page);
  });
});
