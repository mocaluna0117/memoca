import { expect, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, showList, signUp, waitForSynced } from "./helpers";
import { createVaultInSettings, enterVaultPassword } from "./vault-helpers";

/** A note's row in the list on screen. */
const row = (page: Page, name: string) =>
  page.locator("[data-note-row]").filter({ visible: true }).filter({ hasText: name });

/** A line of the open note, by its text. */
const line = (page: Page, text: string) =>
  editor(page)
    .locator(".bn-block-content")
    .filter({ has: page.locator(".bn-inline-content", { hasText: new RegExp(`^${text}$`) }) })
    .first();

/** How far below the bottom of the note's header a line's top is on the screen. */
const belowHeader = (page: Page, text: string) =>
  line(page, text).evaluate((content) => {
    const header = document.querySelector(".memoca-note-pane > header")!;
    return Math.round(content.getBoundingClientRect().top - header.getBoundingClientRect().bottom);
  });

/** Within a couple of pixels of being just below the note's header. */
const atTop = async (page: Page, text: string, timeout = 15_000) =>
  expect
    .poll(async () => Math.abs(await belowHeader(page, text)), { timeout })
    .toBeLessThanOrEqual(2);

/** Types lines into the open note, at its end. */
async function typeLines(page: Page, prefix: string, count: number) {
  await editor(page).click();
  for (let i = 1; i <= count; i += 1) {
    if (i > 1) await page.keyboard.press("Enter");
    await page.keyboard.type(`${prefix}${i}`);
  }
  await expect(line(page, `${prefix}${count}`)).toBeVisible();
}

/** Two long notes, 別 and 長い (60 lines each), neither read here yet, 長い open. */
async function twoNotes(page: Page) {
  await signUp(page);
  await openApp(page);
  await createNote(page, "別");
  await typeLines(page, "別", 60);
  await createNote(page, "長い");
  await typeLines(page, "行", 60);
  // Typing scrolled them: as if never read.
  await page.evaluate(() => localStorage.removeItem("memoca:note-places"));
}

/**
 * Scrolls the open note so that a line is at the top, just below the header,
 * and (unless `hurried`) lets the scrolling stop a moment before going on.
 * By a wheel first, on a computer, as a reader would: that ends the note's
 * being put back where it was read, which a scroll from a script does not.
 * (A finger would on a phone; these call it there only while nothing is
 * being put back.)
 */
async function readFrom(page: Page, text: string, { hurried = false } = {}) {
  if (page.viewportSize()!.width >= 768) {
    const pane = (await page.locator('[data-scroll="note"]').boundingBox())!;
    await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
    await page.mouse.wheel(0, 1);
  }
  await line(page, text).evaluate((content) => {
    const header = document.querySelector(".memoca-note-pane > header")!;
    const by = content.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
    const pane = document.querySelector<HTMLElement>('[data-scroll="note"]')!;
    if (getComputedStyle(pane).overflowY === "auto") pane.scrollTop += by;
    else window.scrollBy(0, by);
  });
  await atTop(page, text);
  if (!hurried) await page.waitForTimeout(400);
}

test.describe("on a computer", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the note in its own pane");
  });

  test("a note opens where it was last read, one never read at its top, and still after a reload", async ({
    page,
  }) => {
    await twoNotes(page);
    await readFrom(page, "行40");

    await row(page, "別").click();
    await expect(line(page, "別1")).toBeVisible();
    // Long enough to be anywhere, and never read here: at its top.
    const pane = page.locator('[data-scroll="note"]');
    expect(await pane.evaluate((each) => each.scrollHeight - each.clientHeight)).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    expect(await pane.evaluate((each) => each.scrollTop)).toBe(0);

    await row(page, "長い").click();
    await atTop(page, "行40");

    // Scrolled and another opened at once, not a moment after: kept as well.
    await readFrom(page, "行20", { hurried: true });
    await row(page, "別").click();
    await expect(line(page, "別1")).toBeVisible();
    await row(page, "長い").click();
    await atTop(page, "行20");

    // Scrolled by whoever is reading as it is put back: left where they took it.
    await readFrom(page, "行40");
    await row(page, "別").click();
    await expect(line(page, "別1")).toBeVisible();
    await row(page, "長い").click();
    await atTop(page, "行40");
    const box = (await pane.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(1_000);
    expect(await belowHeader(page, "行40")).toBeGreaterThan(200);

    // Kept on this device.
    await readFrom(page, "行40");
    await page.reload();
    await atTop(page, "行40", 25_000);
  });

  test("a locked note, read and reloaded, is put back once the vault is opened from it", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createVaultInSettings(page);
    await openApp(page);
    await createNote(page, "鍵付き");
    await typeLines(page, "行", 60);
    await waitForSynced(page);
    await page.getByRole("button", { name: "メモの操作" }).click();
    await page.getByRole("menuitem", { name: "ロックする", exact: true }).click();
    await enterVaultPassword(page, "ロックする");
    await expect(page.getByText("メモをロックしました")).toBeVisible({ timeout: 30_000 });
    await readFrom(page, "行40");

    await page.reload();
    await page.getByRole("button", { name: "金庫を開く", exact: true }).click();
    await enterVaultPassword(page, "開く");
    await atTop(page, "行40", 30_000);

    // The vault closed with it open (as it does by itself after a while),
    // and opened again from it: back where it was read.
    await readFrom(page, "行30");
    await page.locator("aside").getByRole("button", { name: "金庫：開いています" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "いますぐ閉じる" }).click();
    await expect(page.getByText("このメモはロックされています")).toBeVisible();
    await page.getByRole("button", { name: "金庫を開く", exact: true }).click();
    await enterVaultPassword(page, "開く");
    await atTop(page, "行30", 30_000);
  });

  test("read deep inside a long open toggle, under its line kept at the top, it is put back there", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "別", "短い");
    await createNote(page, "トグル");
    await editor(page).click();
    await page.keyboard.type("/折りたたみリスト");
    await expect(page.getByRole("option", { name: /折りたたみリスト/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await page.keyboard.type("箱");
    const toggle = editor(page).locator(".bn-block-content").first();
    await toggle.locator(".bn-toggle-button").click();
    await toggle.locator(".bn-toggle-add-block-button").click();
    for (let i = 1; i <= 40; i += 1) {
      if (i > 1) await page.keyboard.press("Enter");
      await page.keyboard.type(`中身${i}`);
    }
    await readFrom(page, "中身20");
    // The toggle's line kept at the top, over the line read.
    await atTop(page, "箱");

    await row(page, "別").click();
    await expect(line(page, "短い")).toBeVisible();
    await row(page, "トグル").click();
    await atTop(page, "中身20");
  });
});

test("on a phone, a note opened again from the list, or after a reload, opens where it was read", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "the page scrolled on a phone");
  await twoNotes(page);
  // Not 行40: a phone's screen is taller than the twenty lines after it, so
  // the page ends before that line reaches the top.
  await readFrom(page, "行30");

  await showList(page);
  await row(page, "別").click();
  await expect(line(page, "別1")).toBeVisible();
  // Never read here: at its top.
  expect(
    await page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight),
  ).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await showList(page);
  await row(page, "長い").click();
  await atTop(page, "行30");

  await page.reload();
  await atTop(page, "行30", 25_000);
});
