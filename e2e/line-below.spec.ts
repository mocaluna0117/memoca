import { expect, test } from "@playwright/test";
import { createNote, editor, openApp, signUp } from "./helpers";

/** Each block of the note: its kind and text. */
const blocks = (page: import("@playwright/test").Page) =>
  editor(page).evaluate((root) =>
    [...root.querySelectorAll(".bn-block-content")].map(
      (content) => `${(content as HTMLElement).dataset.contentType}:${content.textContent}`,
    ),
  );

test.describe("on from the end of a note", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "a keyboard's ↓, and a pointer's click");
  });

  test("↓ on the last line of a code block the note ends in goes to a new line under it", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "コードで終わるメモ");
    await editor(page).click();
    await page.keyboard.type("```");
    await page.keyboard.press("Enter");
    await page.keyboard.type("x = 1");
    await page.keyboard.press("Enter");
    await page.keyboard.type("y = 2");
    // On the first line of the code, ↓ goes to the second, as it did.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.type("!");
    await expect.poll(() => blocks(page)).toEqual(["codeBlock:x = 1\ny = 2!"]);
    // On the last: out of the code, to a line under it. Before, the caret stayed, and so did what was typed.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.type("あと");
    await expect.poll(() => blocks(page)).toEqual(["codeBlock:x = 1\ny = 2!", "paragraph:あと"]);
    // With the line there, ↓ from the code goes to it, and makes no other.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.type("で");
    await expect.poll(async () => (await blocks(page)).length).toBe(2);
  });

  test("a click in the empty space far under a short note puts the caret at its end", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "短いメモ");
    await editor(page).click();
    await page.keyboard.type("一行目");
    await page.keyboard.press("Enter");
    await page.keyboard.type("二行目");
    await page.keyboard.press("ArrowUp");
    // Under the editor's own frame (half the window's height), in the note's pane.
    const pane = page.locator('[data-scroll="note"]');
    const box = (await pane.boundingBox())!;
    const frame = (await page.locator(".memoca-editor").boundingBox())!;
    const y = box.y + box.height - 20;
    expect(y).toBeGreaterThan(frame.y + frame.height);
    await page.mouse.click(box.x + box.width / 2, y);
    await page.keyboard.type("の続き");
    // Before: the editor lost the focus to the page, and nothing was typed.
    await expect.poll(() => blocks(page)).toEqual(["paragraph:一行目", "paragraph:二行目の続き"]);
  });
});
