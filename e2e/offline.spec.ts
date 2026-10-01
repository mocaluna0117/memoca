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
      baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
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
    // Saved on this device first, so what goes up once the network returns
    // is the note and its file, not an edit still waiting its half second.
    await expect
      .poll(async () =>
        (await readTable<{ noteId: string }>(page, "updates")).filter((row) => row.noteId === noteId).length,
      )
      .toBeGreaterThan(0);

    // Back online, the note and its file both go up. (Which the server hears
    // of first depends on the connection; tests/attachments.test.ts covers a
    // file arriving before its note.)
    await context.setOffline(false);
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

  test("the quick note opens with no network, once it has been opened with one", async ({ page, context }) => {
    await signUp(page);
    await openApp(page);
    await offlineReady(page);
    await page.goto("/quick");
    await expect.poll(() => page.evaluate(async () => Boolean(await caches.match("/quick")))).toBe(true);

    // Another address of it, from the one copy kept, and written into as ever.
    await context.setOffline(true);
    await page.goto("/quick?window=1");
    const field = page.getByLabel("即席メモ");
    await field.fill("圏外で書いた即席メモ");
    await field.press("Control+Enter");
    await expect(page.getByRole("status").filter({ hasText: "保存しました" })).toBeVisible();

    // And it goes up once the network is back.
    await context.setOffline(false);
    await openApp(page);
    await waitForSynced(page);
    await showList(page);
    await expect(page.getByText("圏外で書いた即席メモ").filter({ visible: true }).first()).toBeVisible();
  });

  test("the page shown for one not kept offline comes back by itself with the network", async ({ page, context }) => {
    await signUp(page);
    await openApp(page);
    await offlineReady(page);

    // Never opened on this device, so not kept: the stand-in is shown instead.
    await context.setOffline(true);
    await page.goto("/app/trash");
    await expect(page.getByText("この画面はまだ端末に保存されていません")).toBeVisible();
    const again = page.getByRole("button", { name: "もう一度読み込む" });
    await expect(again).toBeVisible();
    // Offered once the page has started, and with it what listens for the
    // network: back before then, the network would go unnoticed.
    await expect(again).toBeEnabled();

    await Promise.all([page.waitForEvent("load"), context.setOffline(false)]);
    await expect(page.getByRole("heading", { name: "ゴミ箱" }).filter({ visible: true }).first()).toBeVisible();
  });
});
