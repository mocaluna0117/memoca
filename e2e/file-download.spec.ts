import { expect, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, signUp, waitForSynced } from "./helpers";
import { natural, noteImages, pasteFile, pasteImage, uploadsDrained } from "./image-helpers";
import { clearTable } from "./local-db";
import { createVaultInSettings, enterVaultPassword } from "./vault-helpers";

const PDF = "見積書.pdf";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;
const pdfBlock = (page: Page) => page.locator('[data-content-type="file"]').first();

/** Selects a block of the note, and presses the download button over it. */
async function pressDownload(page: Page, block: ReturnType<Page["locator"]>, label: string) {
  await (isPhone(page) ? block.tap() : block.click());
  const button = page.getByRole("button", { name: label, exact: true });
  await (isPhone(page) ? button.tap() : button.click());
}

/** Locks the open note. */
async function lockTheNote(page: Page) {
  // The caret at the foot of the note puts away a toolbar floating over a
  // file, which on a phone covers the note's header.
  const body = (await editor(page).boundingBox())!;
  await editor(page).click({ position: { x: body.width / 2, y: body.height - 8 } });
  await page.getByRole("button", { name: "メモの操作" }).filter({ visible: true }).click();
  await page.getByRole("menuitem", { name: "ロックする", exact: true }).click();
  await enterVaultPassword(page, "ロックする");
  await expect(page.getByText("メモをロックしました")).toBeVisible({ timeout: 30_000 });
  // Put away: on a phone it lies over the top of the note, where the file
  // goes, and a tap held on it keeps it there.
  await page.getByRole("button", { name: "Close toast" }).first().click();
  await expect(page.getByText("メモをロックしました")).toBeHidden();
  await waitForSynced(page);
}

/** A PDF pasted into the open, locked note: a locked note takes files of any type. */
async function pastePdf(page: Page) {
  await pasteFile(page, { name: PDF, type: "application/pdf", size: 4_000 });
  await expect(pdfBlock(page)).toContainText(PDF, { timeout: 30_000 });
}

test.describe("a note's file, from its download button", () => {
  test("is saved under its name, stored readable or locked, and never opened as a page", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "a phone is the next test's");
    test.slow();
    await signUp(page);
    await openApp(page);
    await createVaultInSettings(page);
    // A full navigation closes the vault; locking asks for it again.
    await openApp(page);
    const tabs: string[] = [];
    page.context().on("page", (opened) => tabs.push(opened.url()));

    // Stored readable on the server, and not kept on this device: fetched
    // from there, and saved, rather than opened at its address.
    await createNote(page, "画像のメモ");
    await pasteImage(page, { name: "景色.png" });
    await uploadsDrained(page);
    await waitForSynced(page);
    await clearTable(page, "blobs");
    await page.reload();
    await expect
      .poll(() => natural(noteImages(page).first()), { timeout: 30_000 })
      .toEqual({
        w: 400,
        h: 300,
      });
    expect(await noteImages(page).first().getAttribute("src")).toMatch(/^https?:/);
    let saving = page.waitForEvent("download", { timeout: 20_000 });
    await pressDownload(page, noteImages(page).first(), "画像をダウンロード");
    let saved = await saving;
    // Stored as WebP, whatever it was pasted as: named for what it is.
    expect(saved.suggestedFilename()).toBe("景色.webp");

    // Locked: decrypted here, and saved under its name too.
    await createNote(page, "書類のメモ");
    await lockTheNote(page);
    await pastePdf(page);
    saving = page.waitForEvent("download", { timeout: 20_000 });
    await pressDownload(page, pdfBlock(page), "ファイルをダウンロード");
    saved = await saving;
    expect(saved.suggestedFilename()).toBe(PDF);
    expect(tabs).toEqual([]);
  });

  test("on an iPhone, is handed to the share sheet under its name", async ({
    browser,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "the computer's is the test before");
    test.slow();
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      userAgent: IPHONE,
    });
    // A share sheet that says what it was handed.
    await context.addInitScript(() => {
      const shared: { name: string; type: string; size: number }[] = [];
      (window as unknown as { shared: typeof shared }).shared = shared;
      Object.defineProperty(navigator, "canShare", { value: () => true, configurable: true });
      // As long after the press as the test says.
      Object.defineProperty(navigator, "userActivation", {
        get: () => ({ isActive: !(window as unknown as { stale?: boolean }).stale }),
        configurable: true,
      });
      Object.defineProperty(navigator, "share", {
        value: async ({ files }: { files: File[] }) => {
          shared.push(...files.map(({ name, type, size }) => ({ name, type, size })));
        },
        configurable: true,
      });
    });
    const page = await context.newPage();
    await signUp(page);
    await openApp(page);
    await createVaultInSettings(page);
    await openApp(page);
    await createNote(page, "書類のメモ");
    await lockTheNote(page);
    await pastePdf(page);
    const tabs: string[] = [];
    context.on("page", (opened) => tabs.push(opened.url()));

    await pressDownload(page, pdfBlock(page), "ファイルをダウンロード");
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { shared: unknown[] }).shared))
      .toEqual([{ name: PDF, type: "application/pdf", size: 4_000 }]);

    // Too long after the press for the sheet: offered again, to hand on at a tap of its own.
    await page.evaluate(() => ((window as unknown as { stale: boolean }).stale = true));
    await pressDownload(page, pdfBlock(page), "ファイルをダウンロード");
    await expect(page.getByText("ファイルの準備ができました")).toBeVisible();
    await page.getByRole("button", { name: "共有", exact: true }).tap();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { shared: unknown[] }).shared.length))
      .toBe(2);
    expect(tabs).toEqual([]);
    await context.close();
  });
});
