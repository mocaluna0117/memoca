import { expect, test } from "@playwright/test";
import { createNote, editor, openApp, signUp } from "./helpers";

test.describe("undo", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "a keyboard's ⌘Z");
  });

  test("⌘Z takes back what was typed last, and ⌘⇧Z puts it back, in a note opened again too", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "取り消すメモ");
    await createNote(page, "ほかのメモ");
    // Back to the first: its editor made again, as when a note is opened.
    await page.getByRole("button", { name: /取り消すメモ/ }).filter({ visible: true }).first().click();
    await editor(page).click();
    await page.keyboard.type("一つ目");
    // Apart from what comes next, as typing a moment later is.
    await page.waitForTimeout(700);
    await page.keyboard.type("二つ目");
    await page.waitForTimeout(700);
    await expect(editor(page)).toContainText("一つ目二つ目");

    await page.keyboard.press("ControlOrMeta+z");
    await expect(editor(page)).toContainText("一つ目");
    await expect(editor(page)).not.toContainText("二つ目");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(editor(page)).toContainText("一つ目二つ目");
  });

  test("⌘Z just after a line was turned into a list takes back the turning alone: what was typed stays", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "記法を取り消す");
    await editor(page).click();
    // Typed without a pause, as a person does: the mark, the space, and ⌘Z at once.
    await page.keyboard.type("- ");
    const line = editor(page).locator(".bn-block-content").first();
    await expect(line).toHaveAttribute("data-content-type", "bulletListItem");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(line).toHaveAttribute("data-content-type", "paragraph");
    await expect(line).toHaveText("- ");
    // Once more: what was typed, too.
    await page.keyboard.press("ControlOrMeta+z");
    await expect(line).toHaveText("");
    // And put back: the mark, then the list.
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(line).toHaveAttribute("data-content-type", "bulletListItem");

    // A heading made by its mark, with its words typed on at once: ⌘Z leaves the mark's line.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("# ");
    const last = editor(page).locator(".bn-block-content").last();
    await expect(last).toHaveAttribute("data-content-type", "heading");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(last).toHaveAttribute("data-content-type", "paragraph");
    await expect(last).toHaveText("# ");
  });

  test("⌘Z just after Enter turned a line into a list leaves its mark, with no line break in the line", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    for (const [mark, kind] of [
      ["-", "bulletListItem"],
      ["1.", "numberedListItem"],
      ["#", "heading"],
    ] as const) {
      await createNote(page, `Enter で ${mark}`);
      await editor(page).click();
      await page.keyboard.type(mark);
      await page.keyboard.press("Enter");
      const line = editor(page).locator(".bn-block-content").first();
      await expect(line).toHaveAttribute("data-content-type", kind);
      await page.keyboard.press("ControlOrMeta+z");
      await expect(line).toHaveAttribute("data-content-type", "paragraph");
      // The mark as it was typed: the Enter that ran the rule is not left as a break in the line.
      expect(await line.locator(".bn-inline-content").evaluate((element) => element.textContent)).toBe(mark);
    }
  });
});
