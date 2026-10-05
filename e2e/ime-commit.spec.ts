import { expect, test } from "@playwright/test";
import { createNote, editor, openApp, signUp } from "./helpers";

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
