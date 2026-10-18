import { expect, type Page } from "@playwright/test";
import { createNote, editor, openApp, signUp } from "./helpers";

/** Each block of the note a line: its type and text, indented by how deep it is. */
export const outline = (page: Page) =>
  editor(page).evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>(".bn-block-content")].map((content) => {
      let depth = 0;
      for (let at = content.parentElement; at && at !== root; at = at.parentElement) {
        if (at.classList.contains("bn-block-group")) depth += 1;
      }
      const type = content.dataset.contentType ?? "";
      const text = content.querySelector(".bn-inline-content")?.textContent ?? "";
      return `${"  ".repeat(Math.max(0, depth - 1))}${type}:${text}`;
    }),
  );

/** The lines of the blocks chosen. */
export const chosen = (page: Page) =>
  editor(page).evaluate((root) =>
    [...root.querySelectorAll(".memoca-chosen-block")].map(
      (block) => block.querySelector(".bn-inline-content")?.textContent ?? "",
    ),
  );

/** The caret into a line, at `offset` (its end by default). */
export async function caretIn(page: Page, text: string, offset?: number) {
  await editor(page)
    .locator(".bn-inline-content", { hasText: new RegExp(`^${text}$`) })
    .first()
    .evaluate((line, offset) => {
      const node = line.firstChild!;
      const range = document.createRange();
      range.setStart(node, offset ?? (node.textContent ?? "").length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    }, offset);
  // Taken in by the editor.
  await page.waitForTimeout(50);
}

/** A note: 牛乳 and 卵 as bullets, a line of text, and an empty line. */
export async function writeNote(page: Page) {
  await signUp(page);
  await openApp(page);
  await createNote(page, "ブロック");
  await editor(page).click();
  await page.keyboard.type("- 牛乳");
  await page.keyboard.press("Enter");
  await page.keyboard.type("卵");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("メモの行");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => outline(page))
    .toEqual(["bulletListItem:牛乳", "bulletListItem:卵", "paragraph:メモの行", "paragraph:"]);
}

/** The menu of a block's handle, opened. */
export async function openHandleMenu(page: Page, text: string) {
  await editor(page)
    .locator(".bn-block-content", {
      has: page.locator(".bn-inline-content", { hasText: new RegExp(`^${text}$`) }),
    })
    .first()
    .hover();
  await page.locator(".bn-side-menu [draggable='true']").first().click();
  await expect(page.getByRole("menuitem", { name: "複製" })).toBeVisible();
}

/** The caret into the note's last line, empty: under a phone's bar, where a tap cannot reach. */
export async function caretInLastLine(page: Page) {
  await editor(page)
    .locator(".bn-inline-content")
    .last()
    .evaluate((line) => {
      const range = document.createRange();
      range.setStart(line, 0);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
  await page.waitForTimeout(50);
}
