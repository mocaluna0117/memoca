import { expect, type Page, test } from "@playwright/test";
import { swipe } from "./gestures";
import { createNote, editor, folderPanel, hideFolders, openApp, settle, signUp } from "./helpers";

// Velocity thresholds are covered in tests/drawer-swipe.test.ts. Here every
// swipe is decided by distance alone, so a slow machine cannot turn one into
// a flick.

const anyDialog = (page: Page) => page.locator('[role="dialog"]');
const drawer = (page: Page) => page.locator('[role="dialog"][data-state="open"]');

/** The drawer's left edge: minus its width when shut, 0 when fully open. */
const drawerX = (page: Page) =>
  page.locator('[data-slot="drawer-content"]').evaluate((el) => el.getBoundingClientRect().x);

/** How far the page has moved aside for the drawer. */
const pageShift = (page: Page) =>
  page.locator("main").evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41);

/**
 * Every transform on the page, the bottom bar and whatever holds them. Any
 * one of them would become the reference for fixed elements such as the bar
 * and the block toolbar, and move them.
 */
const transformsLeft = (page: Page) =>
  page.evaluate(() => {
    const bar = [...document.querySelectorAll("nav")].find(
      (el) => getComputedStyle(el).position === "fixed",
    );
    const found: string[] = [];
    for (const start of [document.querySelector("main"), bar ?? null]) {
      for (let el: Element | null = start; el; el = el.parentElement) {
        const { transform } = getComputedStyle(el);
        if (transform !== "none") found.push(`${el.tagName.toLowerCase()} ${transform}`);
      }
    }
    return found;
  });

test.describe("the folder drawer follows a swipe on a phone", () => {
  test.skip(({ isMobile }) => !isMobile, "phone gesture");

  test("a swipe right opens it and a swipe left on it closes it", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await expect(anyDialog(page)).toHaveCount(0);

    await swipe(page, { x: 40, y: 420 }, { x: 340, y: 430 });
    await expect(drawer(page)).toBeVisible();
    await settle(drawer(page));
    await expect(drawer(page).getByRole("button", { name: "フォルダを追加" })).toBeVisible();
    expect(await drawerX(page)).toBeCloseTo(0, 0);
    // The page moves aside with the drawer's edge, as in ChatGPT.
    const width = await page
      .locator('[data-slot="drawer-content"]')
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(await pageShift(page)).toBeCloseTo(width, 0);

    // Up and down is the folder list's own scroll: the drawer stays.
    await swipe(page, { x: 140, y: 600 }, { x: 145, y: 300 });
    await expect(drawer(page)).toBeVisible();

    await swipe(page, { x: 260, y: 420 }, { x: 20, y: 425 });
    await expect(anyDialog(page)).toHaveCount(0);
    expect(await transformsLeft(page)).toEqual([]);

    // The button and Escape still work as before.
    const panel = await folderPanel(page);
    await expect(panel.getByRole("button", { name: "フォルダを追加" })).toBeVisible();
    await hideFolders(page);
    await expect(anyDialog(page)).toHaveCount(0);
  });

  test("a swipe left on the dimmed page closes it, and so does a tap", async ({ page }) => {
    await signUp(page);
    await openApp(page);

    await folderPanel(page);
    await swipe(page, { x: 395, y: 420 }, { x: 95, y: 425 });
    await expect(anyDialog(page)).toHaveCount(0);

    await folderPanel(page);
    await page.touchscreen.tap(380, 300);
    await expect(anyDialog(page)).toHaveCount(0);
    expect(await transformsLeft(page)).toEqual([]);
  });

  test("while it slides away the page already answers, and a swipe catches it", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);

    // Closed and checked in one go, well inside the 280ms it takes to leave.
    await folderPanel(page);
    const leaving = await page.evaluate(async () => {
      const focused = document.activeElement ?? document.body;
      focused.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const hit = (x: number, y: number) => document.elementFromPoint(x, y);
      return {
        mounted: document.querySelector('[role="dialog"]') !== null,
        // Beside it is the page, still moved aside.
        besideDrawer: hit(380, 300)?.closest("main") != null,
        // On it, the touch goes through to whatever is underneath.
        throughDrawer: hit(100, 300)?.closest('[role="dialog"]') == null,
      };
    });
    expect(leaving).toEqual({ mounted: true, besideDrawer: true, throughDrawer: true });
    await expect(anyDialog(page)).toHaveCount(0);

    // A swipe that starts while it leaves brings it back. (On a slow run the
    // drawer may be gone first; the swipe opens a new one all the same.)
    await folderPanel(page);
    await page.keyboard.press("Escape");
    await swipe(page, { x: 40, y: 420 }, { x: 340, y: 430 });
    await expect(drawer(page)).toBeVisible();
    await settle(drawer(page));
    expect(await drawerX(page)).toBeCloseTo(0, 0);
    await hideFolders(page);
    expect(await transformsLeft(page)).toEqual([]);
  });

  test("growing past a phone closes it and stops listening on the page", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    const cdp = await page.context().newCDPSession(page);
    // The swipe is taken by the shell around the page, bare strip included.
    const pageListens = async () => {
      const { result } = await cdp.send("Runtime.evaluate", {
        expression: 'document.querySelector("main").parentElement',
      });
      const { listeners } = await cdp.send("DOMDebugger.getEventListeners", {
        objectId: result.objectId!,
      });
      return listeners.some((listener) => listener.type === "touchmove");
    };
    expect(await pageListens()).toBe(true);

    await folderPanel(page);
    // A phone turned on its side.
    await page.setViewportSize({ width: 915, height: 412 });
    await expect(anyDialog(page)).toHaveCount(0);
    expect(await transformsLeft(page)).toEqual([]);
    await expect(page.locator("aside")).toBeVisible();
    // From md up the swipe never starts, so scrolling there waits on nothing.
    expect(await pageListens()).toBe(false);

    await page.setViewportSize({ width: 412, height: 839 });
    await expect.poll(pageListens).toBe(true);
    await swipe(page, { x: 40, y: 420 }, { x: 340, y: 430 });
    await expect(drawer(page)).toBeVisible();
    await cdp.detach();
  });

  test("a short, slow drag follows the finger and goes back", async ({ page }) => {
    await signUp(page);
    await openApp(page);

    // Held still before letting go, so the release has no speed left.
    const lift = await swipe(
      page,
      { x: 30, y: 420 },
      { x: 130, y: 420 },
      {
        steps: 20,
        stepMs: 25,
        holdMs: 200,
        release: false,
      },
    );
    // The drawer's edge is 100px in, less the 10px it takes to tell a swipe
    // from a scroll, and the page has moved with it.
    const width = await page
      .locator('[data-slot="drawer-content"]')
      .evaluate((el) => el.getBoundingClientRect().width);
    await expect.poll(() => drawerX(page)).toBeCloseTo(-width + 90, 0);
    expect(await pageShift(page)).toBeCloseTo(90, 0);
    const dim = await page
      .locator('[data-slot="drawer-shade"]')
      .evaluate((el) => Number(getComputedStyle(el).opacity));
    expect(dim).toBeCloseTo(90 / width, 2);
    await lift();

    await expect(anyDialog(page)).toHaveCount(0);
    expect(await transformsLeft(page)).toEqual([]);
  });

  test("with reduced motion it still follows the finger, but the page stays put", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await signUp(page);
    await openApp(page);

    const lift = await swipe(page, { x: 30, y: 420 }, { x: 330, y: 420 }, { release: false });
    const width = await page
      .locator('[data-slot="drawer-content"]')
      .evaluate((el) => el.getBoundingClientRect().width);
    await expect.poll(() => drawerX(page)).toBeCloseTo(Math.min(0, -width + 290), 0);
    expect(await transformsLeft(page)).toEqual([]);
    await lift();

    await expect(drawer(page)).toBeVisible();
    await settle(drawer(page));
    expect(await drawerX(page)).toBeCloseTo(0, 0);
    expect(await transformsLeft(page)).toEqual([]);
    await hideFolders(page);
  });

  test("a vertical swipe scrolls the page and does not open it", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await swipe(page, { x: 200, y: 650 }, { x: 215, y: 250 });
    await expect(anyDialog(page)).toHaveCount(0);

    await createNote(page, "長いメモ");
    await editor(page).click();
    for (let i = 1; i <= 40; i += 1) {
      await page.keyboard.type(`${i} 行目`);
      await page.keyboard.press("Enter");
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

    await swipe(page, { x: 200, y: 650 }, { x: 215, y: 250 });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
    await expect(anyDialog(page)).toHaveCount(0);
  });

  test("a swipe right with a note open opens it, and the note stays open", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "開いたまま", "本文の一行目");
    const noteId = new URL(page.url()).searchParams.get("n");
    expect(noteId).not.toBeNull();

    // On the body text, clear of the editor's side menu at the left edge.
    const box = (await editor(page).boundingBox())!;
    await swipe(page, { x: 100, y: box.y + 60 }, { x: 390, y: box.y + 70 });
    await expect(drawer(page)).toBeVisible();

    await hideFolders(page);
    expect(new URL(page.url()).searchParams.get("n")).toBe(noteId);
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("開いたまま");
  });

  // A table is what scrolls sideways in the editor: code blocks wrap their
  // lines in this version of BlockNote.
  test("a sideways swipe on a wide table scrolls the table instead", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "表");
    await editor(page).click();
    await page.keyboard.type("/表");
    await expect(page.locator(".bn-suggestion-menu")).toBeVisible();
    await page.keyboard.press("Enter");
    // The menu fades out over the table; a finger on it would not reach the table.
    await expect(page.locator(".bn-suggestion-menu")).toHaveCount(0);

    const table = page.locator(".tableWrapper");
    await expect(table).toBeVisible();
    expect(await table.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(30);
    const end = await table.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
      return el.scrollLeft;
    });
    expect(end).toBeGreaterThan(30);

    // Rightwards, the way that opens the drawer anywhere else.
    const box = (await table.boundingBox())!;
    const y = box.y + box.height / 2;
    await swipe(page, { x: box.x + 20, y }, { x: box.x + 300, y });
    await expect.poll(() => table.evaluate((el) => el.scrollLeft)).toBeLessThan(end);
    await expect(anyDialog(page)).toHaveCount(0);
  });

  test("closing a drawer opened with the button gives focus back to it", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await folderPanel(page);
    await hideFolders(page);
    await expect(page.getByRole("button", { name: "メニューを開く" })).toBeFocused();
  });
});
