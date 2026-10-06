import { expect, test } from "@playwright/test";
import { createNote, editor, openApp, signUp } from "./helpers";
import { makeTextLarger } from "./font-size-helpers";
import { typeAList } from "./list-helpers";
import { linkNotes } from "./note-links-helpers";

/** The Mac desktop app's user agent (desktop/src-tauri/src/window.rs), in its engine. */
test.use({
  browserName: "webkit",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) MemocaShell/0.4.6 (macos)",
});

for (const indented of [true, false]) {
  test(`a word committed from the input method in ${indented ? "an indented" : "a"} list item comes out once`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the Mac desktop app's window");
    await signUp(page);
    await openApp(page);
    await createNote(page, "変換");
    await editor(page).click();
    await page.keyboard.type("- 日本総研");
    await page.keyboard.press("Enter");
    if (indented) await page.keyboard.press("Tab");

    // The word as the input method writes it, then committed as WebKit
    // commits it in the desktop app: the word being composed deleted as one
    // (deleteCompositionText), the word chosen inserted.
    const content = page.locator(".ProseMirror");
    await content.evaluate((root) =>
      root.dispatchEvent(new CompositionEvent("compositionstart", { data: "" })),
    );
    await page.keyboard.insertText("あいうえお");
    await content.evaluate((root) => {
      root.dispatchEvent(
        new InputEvent("beforeinput", { inputType: "deleteCompositionText", bubbles: true }),
      );
      const anchor = getSelection()!.anchorNode!;
      const line = (anchor instanceof Element ? anchor : anchor.parentElement!).closest(
        ".bn-inline-content",
      )!;
      const word = Array.from(line.childNodes).find((child) => child.nodeType === Node.TEXT_NODE)!;
      const range = document.createRange();
      range.selectNodeContents(word);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      document.execCommand("delete");
    });
    await page.keyboard.insertText("あいうえお");
    await content.evaluate((root) =>
      root.dispatchEvent(new CompositionEvent("compositionend", { data: "あいうえお" })),
    );

    const items = page.locator('[data-content-type="bulletListItem"] .bn-inline-content');
    await expect(items).toHaveText(["日本総研", "あいうえお"]);
    // What kept the line through the commit is gone with it.
    await expect(content.locator("img.ProseMirror-separator[mark-placeholder]")).toHaveCount(0);
  });
}

test("a word being written, when the next line is clicked, stays in its line, and the next line too", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the Mac desktop app's window");
  await signUp(page);
  await openApp(page);
  await createNote(page, "クリック");
  await editor(page).click();
  await page.keyboard.type("- 上の行");
  await page.keyboard.press("Enter");
  await page.keyboard.type("下の行");
  const items = page.locator('[data-content-type="bulletListItem"] .bn-inline-content');
  // At its right, past its text: the caret at its end (End is not that on a Mac).
  const box = (await items.first().boundingBox())!;
  await items.first().click({ position: { x: box.width - 2, y: box.height / 2 } });

  // A word being written in the first line, when the second is clicked,
  // which ends the composition there.
  const content = page.locator(".ProseMirror");
  await content.evaluate((root) =>
    root.dispatchEvent(new CompositionEvent("compositionstart", { data: "" })),
  );
  await page.keyboard.insertText("あ");
  await items.last().click();
  await content.evaluate((root) =>
    root.dispatchEvent(new CompositionEvent("compositionend", { data: "あ" })),
  );
  await page.waitForTimeout(200);
  await expect(items).toHaveText(["上の行あ", "下の行"]);
});

test("a list typed on the Mac desktop app's keyboard", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the Mac desktop app's window");
  await signUp(page);
  await openApp(page);
  await createNote(page, "リスト");
  await typeAList(page);
});

test("text made larger from the toolbar on the Mac desktop app", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the Mac desktop app's window");
  await makeTextLarger(page);
});

test("a note linked to another on the Mac desktop app", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the Mac desktop app's window");
  await linkNotes(page);
});
