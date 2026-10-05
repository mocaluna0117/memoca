import { expect, test } from "@playwright/test";
import { createNote, editor, openApp, signUp } from "./helpers";

/** The Mac desktop app's user agent (desktop/src-tauri/src/window.rs). */
const MAC_SHELL =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) MemocaShell/0.4.6 (macos)";

test.use({ userAgent: MAC_SHELL });

test("in the Mac desktop app, the Enter that commits a word makes no line of its own, and Enter still does", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the Mac desktop app's window");
  await signUp(page);
  await openApp(page);
  await createNote(page, "変換");
  await editor(page).click();
  await page.keyboard.type("- 日本総研");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("あいうえお");

  // The line WebKit would make itself, while the word is still being composed
  // and just after: refused. One a moment later is not.
  const refused = await page.locator(".ProseMirror").evaluate(async (root) => {
    const line = () =>
      new InputEvent("beforeinput", {
        inputType: "insertParagraph",
        bubbles: true,
        cancelable: true,
      });
    root.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    const during = line();
    root.dispatchEvent(during);
    root.dispatchEvent(new CompositionEvent("compositionend", { data: "あいうえお" }));
    const after = line();
    root.dispatchEvent(after);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const later = line();
    root.dispatchEvent(later);
    return [during.defaultPrevented, after.defaultPrevented, later.defaultPrevented];
  });
  expect(refused).toEqual([true, true, false]);

  // An Enter of its own makes the next item, as anywhere.
  await page.keyboard.press("Enter");
  await page.keyboard.type("かきくけこ");
  await expect(page.locator('[data-content-type="bulletListItem"] .bn-inline-content')).toHaveText([
    "日本総研",
    "あいうえお",
    "かきくけこ",
  ]);
});
