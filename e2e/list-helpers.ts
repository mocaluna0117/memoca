import { expect, type Page } from "@playwright/test";
import { editor } from "./helpers";

/** Each block of the note: its type and text. */
export const lines = (page: Page) =>
  editor(page)
    .locator("[data-content-type]")
    .evaluateAll((found) =>
      found.map((block) => `${block.getAttribute("data-content-type")}:${block.textContent}`),
    );

/** Whether the caret is still in the note, not moved on to a button. */
const inNote = (page: Page) =>
  page.evaluate(() => document.activeElement?.closest(".ProseMirror") != null);

/**
 * A list typed in an empty note, as on a computer's keyboard: Tab and
 * Shift+Tab where an item cannot move keep the caret in the note, a ・ at
 * the start of an item stays, and - with Enter made an item and taken back
 * by Backspace leaves the - alone.
 */
export async function typeAList(page: Page) {
  await editor(page).click();
  await page.keyboard.type("- 一");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  expect(await inNote(page)).toBe(true);

  await page.keyboard.press("Enter");
  await page.keyboard.type("二");
  await page.keyboard.press("Tab");
  await expect
    .poll(() => editor(page).locator(".bn-block-group .bn-block-group [data-content-type]").count())
    .toBe(1);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.type("・");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => lines(page)).toEqual(["bulletListItem:一", "bulletListItem:・二"]);

  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("-");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => lines(page))
    .toEqual(["bulletListItem:一", "bulletListItem:・二", "bulletListItem:"]);
  await page.keyboard.press("Backspace");
  await expect
    .poll(() => lines(page))
    .toEqual(["bulletListItem:一", "bulletListItem:・二", "paragraph:-"]);
  expect(await inNote(page)).toBe(true);
}
