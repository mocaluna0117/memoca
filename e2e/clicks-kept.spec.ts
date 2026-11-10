import { expect, test } from "@playwright/test";
import { createNote, editor, openApp, signUp } from "./helpers";

test.describe("the page's clicks, left taken by a menu or a dialog gone", () => {
  test("are given back: one click falls through, and the next is the page's", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "clicked with a mouse");
    await signUp(page);
    await openApp(page);
    await createNote(page, "クリックの戻るメモ");
    await editor(page).click();
    await page.keyboard.type("本文");
    // As one left them: taken, with no menu nor dialog open.
    await page.evaluate(() => {
      document.body.style.pointerEvents = "none";
    });
    const menu = page.getByRole("button", { name: "メモの操作" }).filter({ visible: true });
    await menu.click({ force: true });
    // Nothing took that click; the clicks are back for the next.
    await expect.poll(() => page.evaluate(() => document.body.style.pointerEvents)).toBe("");
    await menu.click();
    await expect(page.getByRole("menuitem", { name: "変更履歴" })).toBeVisible();
    await page.keyboard.press("Escape");

    // As the window comes into focus again (brought out by the desktop app), at once.
    await page.evaluate(() => {
      document.body.style.pointerEvents = "none";
      window.dispatchEvent(new Event("focus"));
    });
    expect(await page.evaluate(() => document.body.style.pointerEvents)).toBe("");
    await menu.click();
    await expect(page.getByRole("menuitem", { name: "変更履歴" })).toBeVisible();
  });

  test("taken by a menu open, are its: a click beside it closes it, as ever", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "clicked with a mouse");
    await signUp(page);
    await openApp(page);
    await createNote(page, "メニューのメモ");
    await page.getByRole("button", { name: "メモの操作" }).filter({ visible: true }).click();
    await expect(page.getByRole("menuitem", { name: "変更履歴" })).toBeVisible();
    expect(await page.evaluate(() => document.body.style.pointerEvents)).toBe("none");
    await page.mouse.click(5, 300);
    await expect(page.getByRole("menuitem", { name: "変更履歴" })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.body.style.pointerEvents)).toBe("");
  });
});
