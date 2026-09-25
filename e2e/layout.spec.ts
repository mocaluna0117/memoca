import { expect, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, showList, signUp } from "./helpers";

const NOTE = '[data-scroll="note"]';
const LIST = '[data-scroll="list"] [data-slot="scroll-area-viewport"]';

/** How far the page and one scroll area can scroll, and where they are. */
const scrollState = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    const doc = document.scrollingElement!;
    return {
      windowY: window.scrollY,
      pageOverflow: doc.scrollHeight - doc.clientHeight,
      top: el ? el.scrollTop : null,
      overflow: el ? el.scrollHeight - el.clientHeight : null,
    };
  }, selector);

test.describe("side by side, each pane scrolls on its own", () => {
  test.skip(({ isMobile }) => isMobile, "the list and the note share the screen only when it is wide");

  test("scrolling a long note leaves the list where it is", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "動かない行");
    await createNote(page, "長いメモ");
    await editor(page).click();
    for (let i = 1; i <= 60; i += 1) {
      await page.keyboard.type(`${i} 行目`);
      await page.keyboard.press("Enter");
    }

    const row = page.locator("[data-note-row]").filter({ hasText: "動かない行" });
    // The list's own box, not a row: the edited note moves to the top of the
    // list once its change lands, which is not scrolling.
    const list = page.locator(LIST);
    const before = (await list.boundingBox())!;
    const title = page.getByLabel("メモのタイトル");
    const box = (await title.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 300);
    await page.mouse.wheel(0, -20_000);
    await expect.poll(async () => (await scrollState(page, NOTE)).top).toBe(0);
    await page.mouse.wheel(0, 1_500);
    await expect.poll(async () => (await scrollState(page, NOTE)).top).toBeGreaterThan(0);

    // The page itself never scrolls: only the note did.
    const state = await scrollState(page, LIST);
    expect(state.windowY).toBe(0);
    expect(state.pageOverflow).toBeLessThanOrEqual(1);
    expect(state.top ?? 0).toBe(0);
    expect((await list.boundingBox())!.y).toBe(before.y);
    await expect(title).toBeInViewport();
    await expect(row).toBeInViewport();

    // The end of the note can be reached.
    await page.mouse.wheel(0, 20_000);
    await expect(page.getByText("60 行目")).toBeInViewport();

    // The next note opens at its top, not where the last one was left.
    await row.click();
    await expect(title).toHaveValue("動かない行");
    await expect.poll(async () => (await scrollState(page, NOTE)).top).toBe(0);
  });
});

test.describe("on a phone", () => {
  test.skip(({ isMobile }) => !isMobile, "phone layout");

  test("a short list does not scroll, and the bottom bar hides none of it", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    expect((await scrollState(page, LIST)).pageOverflow).toBeLessThanOrEqual(1);

    await createNote(page, "ひとつ目");
    await createNote(page, "ふたつ目");
    await showList(page);
    const rows = page.locator("[data-note-row]").filter({ visible: true });
    await expect(rows).toHaveCount(2);

    const state = await scrollState(page, LIST);
    expect(state.pageOverflow).toBeLessThanOrEqual(1);
    expect(state.overflow ?? 0).toBeLessThanOrEqual(1);
    await page.mouse.wheel(0, 600);
    expect((await scrollState(page, LIST)).windowY).toBe(0);

    const nav = (await page.getByRole("navigation").filter({ visible: true }).last().boundingBox())!;
    const last = (await rows.last().boundingBox())!;
    expect(last.y + last.height).toBeLessThanOrEqual(nav.y);
  });

  test("a finger on a long note scrolls it", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "長いメモ");
    await editor(page).click();
    for (let i = 1; i <= 40; i += 1) {
      await page.keyboard.type(`${i} 行目`);
      await page.keyboard.press("Enter");
    }
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.scrollTo(0, 0);
    });

    // A real touch drag, through Chromium's input pipeline, on the note text.
    const box = (await page.getByText("5 行目", { exact: true }).boundingBox())!;
    const x = box.x + box.width / 2;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.synthesizeScrollGesture", {
      x,
      y: box.y + 200,
      yDistance: -400,
      gestureSourceType: "touch",
      speed: 800,
    });
    await cdp.detach();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  });

  test("a note opens at its top, and going back finds the list where it was", async ({ page }) => {
    test.slow();
    await signUp(page);
    await openApp(page);
    const noteParam = () => new URL(page.url()).searchParams.get("n");
    for (let i = 0; i < 16; i += 1) {
      const previous = noteParam();
      await page.getByRole("button", { name: "新しいメモ" }).first().click();
      await expect.poll(noteParam).not.toBe(previous);
      await page.getByRole("button", { name: "戻る" }).click();
      await expect(page.getByRole("button", { name: "新しいメモ" }).first()).toBeVisible();
    }
    const rows = page.locator("[data-note-row]").filter({ visible: true });
    await expect(rows).toHaveCount(16);

    // A long list scrolls the page, as a phone expects.
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement!.scrollHeight));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    const listY = await page.evaluate(() => window.scrollY);

    await rows.last().click();
    await expect(page.getByLabel("メモのタイトル")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

    await page.getByRole("button", { name: "戻る" }).click();
    await expect(rows.last()).toBeInViewport();
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - listY)).toBeLessThanOrEqual(2);
  });
});
