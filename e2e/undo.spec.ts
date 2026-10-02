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
});
