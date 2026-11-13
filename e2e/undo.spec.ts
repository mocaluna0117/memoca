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

  test("⌘Z just after **太字** was made bold takes back the making alone: the text as typed, its signs with it", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "太字を取り消す");
    await editor(page).click();
    // Typed without a pause: before, the whole line went with the one ⌘Z.
    await page.keyboard.type("これは **太字**");
    const line = editor(page).locator(".bn-inline-content").first();
    await expect(line.locator("strong")).toHaveText("太字");
    await expect(line).toHaveText("これは 太字");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(line).toHaveText("これは **太字**");
    await expect(line.locator("strong")).toHaveCount(0);
    // Typing goes on in the text as it is, not made bold again.
    await page.keyboard.type(" です");
    await expect(line).toHaveText("これは **太字** です");
    await expect(line.locator("strong")).toHaveCount(0);

    // `code` the same, and put back by ⌘⇧Z.
    await page.keyboard.press("Enter");
    await page.keyboard.type("`code`");
    const second = editor(page).locator(".bn-inline-content").nth(1);
    await expect(second.locator("code")).toHaveText("code");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(second).toHaveText("`code`");
    await expect(second.locator("code")).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(second.locator("code")).toHaveText("code");
    // What is typed after it is taken back on its own, the code staying.
    await page.keyboard.type(" あと");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(second.locator("code")).toHaveText("code");
    await expect(second).toHaveText("code");
  });

  test("⌘Z after words typed on into a heading its mark made takes back the words, not the heading", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "見出しの文字を取り消す");
    await editor(page).click();
    // The mark and the words at once, with no pause between them.
    await page.keyboard.type("# 見出し");
    const line = editor(page).locator(".bn-block-content").first();
    await expect(line).toHaveAttribute("data-content-type", "heading");
    await expect(line).toHaveText("見出し");
    await page.keyboard.press("ControlOrMeta+z");
    // Before: a line of text reading "# ", the heading gone with its words.
    await expect(line).toHaveAttribute("data-content-type", "heading");
    await expect(line).toHaveText("");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(line).toHaveAttribute("data-content-type", "paragraph");
    await expect(line).toHaveText("# ");
  });
});
