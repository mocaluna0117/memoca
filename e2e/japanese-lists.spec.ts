import { expect, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, signUp } from "./helpers";

const blocks = (page: Page) =>
  editor(page)
    .locator("[data-content-type]")
    .evaluateAll((found) => found.map((block) => block.getAttribute("data-content-type")));

/** ・ typed with the input method on, and committed, as a Japanese keyboard's / key gives it. */
async function typeWithInputMethod(page: Page, text: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text, selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.insertText", { text });
  await cdp.detach();
}

test.describe("a list typed as Japanese is", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "typed on a computer's keyboard");
  });

  test("made by ・ at the start of a line, not in the middle of one, nor in a heading", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "箇条書き");
    await editor(page).click();

    await page.keyboard.type("・");
    await page.keyboard.type("牛乳");
    expect(await blocks(page)).toEqual(["bulletListItem"]);
    await expect(editor(page).locator('[data-content-type="bulletListItem"]')).toHaveText("牛乳");

    // With the input method, committed.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    expect(await blocks(page)).toEqual(["bulletListItem", "paragraph"]);
    await typeWithInputMethod(page, "・");
    await page.keyboard.type("卵");
    expect(await blocks(page)).toEqual(["bulletListItem", "bulletListItem"]);

    // In the middle of a line, a ・ is a ・.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("山田・佐藤");
    expect(await blocks(page)).toEqual(["bulletListItem", "bulletListItem", "paragraph"]);
    await expect(editor(page).locator('[data-content-type="paragraph"]')).toHaveText("山田・佐藤");

    // Backspace straight after gives the ・ back.
    await page.keyboard.press("Enter");
    await page.keyboard.type("・");
    await page.keyboard.press("Backspace");
    expect((await blocks(page)).at(-1)).toBe("paragraph");
    await expect(editor(page).locator('[data-content-type="paragraph"]').last()).toHaveText("・");

    // And BlockNote's own - , the same way: the - and the space, once each.
    await page.keyboard.press("Enter");
    await page.keyboard.type("- ");
    expect((await blocks(page)).at(-1)).toBe("bulletListItem");
    await page.keyboard.press("Backspace");
    expect((await blocks(page)).at(-1)).toBe("paragraph");
    expect(
      await editor(page)
        .locator('[data-content-type="paragraph"]')
        .last()
        .evaluate((block) => block.textContent),
    ).toBe("- ");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");

    // A heading stays one.
    await page.keyboard.press("Enter");
    await page.keyboard.type("# ");
    await page.keyboard.type("・見出し");
    expect((await blocks(page)).at(-1)).toBe("heading");
  });
});
