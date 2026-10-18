import { expect, type Page, test } from "@playwright/test";
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

/**
 * A word written with the input method, then committed as WebKit commits it
 * in the desktop app: the word being composed deleted as one
 * (deleteCompositionText), then the word chosen inserted. No word chosen:
 * the composition given up, as with Backspace. `clause`: the first so many
 * characters of it selected as it is committed, as WebKit has the clause
 * being converted when a phrase is converted in parts.
 */
async function commitWord(page: Page, composed: string, word: string, clause = 0) {
  const content = page.locator(".ProseMirror");
  await content.evaluate((root) =>
    root.dispatchEvent(new CompositionEvent("compositionstart", { data: "" })),
  );
  await content.evaluate(
    (root, data) => root.dispatchEvent(new CompositionEvent("compositionupdate", { data })),
    composed,
  );
  await page.keyboard.insertText(composed);
  if (clause) {
    await content.evaluate((root, length) => {
      const anchor = getSelection()!.anchorNode!;
      const range = document.createRange();
      range.setStart(anchor, 0);
      range.setEnd(anchor, length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    }, clause);
    // Taken in by the editor, as WebKit's is while the phrase is converted.
    await expect
      .poll(() =>
        content.evaluate((root) => {
          const { selection } = (
            root as unknown as { editor: { view: { state: { selection: { empty: boolean } } } } }
          ).editor.view.state;
          return selection.empty;
        }),
      )
      .toBe(false);
  }
  await content.evaluate((root) => {
    root.dispatchEvent(
      new InputEvent("beforeinput", { inputType: "deleteCompositionText", bubbles: true }),
    );
    const anchor = getSelection()!.anchorNode!;
    const line = (anchor instanceof Element ? anchor : anchor.parentElement!).closest(
      ".bn-inline-content",
    )!;
    const written = Array.from(line.childNodes).find((child) => child.nodeType === Node.TEXT_NODE)!;
    const range = document.createRange();
    range.selectNodeContents(written);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    document.execCommand("delete");
  });
  if (word) await page.keyboard.insertText(word);
  await content.evaluate(
    (root, data) => root.dispatchEvent(new CompositionEvent("compositionend", { data })),
    word,
  );
}

/** Each block of the note a line: its type and text, indented by how deep it is. */
const outline = (page: Page) =>
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

// With the caret after the word, and with the word selected, as WebKit has
// it while it is being converted.
for (const [indented, selected] of [
  [true, false],
  [false, false],
  [true, true],
] as const) {
  test(`a word committed from the input method in ${indented ? "an indented" : "a"} list item${selected ? ", selected," : ""} comes out once`, async ({
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

    await commitWord(page, "あいうえお", "あいうえお", selected ? 5 : 0);

    const content = page.locator(".ProseMirror");
    const items = page.locator('[data-content-type="bulletListItem"] .bn-inline-content');
    await expect(items).toHaveText(["日本総研", "あいうえお"]);
    // What kept the line through the commit is gone with it.
    await expect(content.locator("img.ProseMirror-separator[mark-placeholder]")).toHaveCount(0);
  });
}

// In the only line inside an open toggle, as alone in its group as an
// indented item: WebKit takes it out as the word is deleted, and ProseMirror
// splits it. Put right, the line is as the word committed leaves it: ・ made
// a bullet of it (japanese-lists), nothing at all.
for (const [word, made, selected] of [
  ["・", "bulletListItem:", false],
  ["", "paragraph:", false],
  ["・", "bulletListItem:", true],
  ["", "paragraph:", true],
] as const) {
  test(`${word ? "・ committed" : "a word given up"}${selected ? ", selected," : ""} in the only line inside a toggle ${word ? "makes it a bullet" : "leaves it empty"}`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the Mac desktop app's window");
    await signUp(page);
    await openApp(page);
    await createNote(page, "トグル");
    await editor(page).click();
    await page.keyboard.type("/折りたたみリスト");
    // The list for all that was typed, not an earlier one, loaded after it.
    await expect(page.getByRole("option").first()).toContainText("折りたたみリスト");
    await page.keyboard.press("Enter");
    await page.keyboard.type("買い物");
    const toggle = editor(page).locator('[data-content-type="toggleListItem"]');
    await toggle.locator(".bn-toggle-button").click();
    await expect(toggle.locator(".bn-toggle-wrapper")).toHaveAttribute(
      "data-show-children",
      "true",
    );
    // At its right, past its text: the caret at its end. Enter: a line inside it.
    const line = toggle.locator(".bn-inline-content");
    const box = (await line.boundingBox())!;
    await line.click({ position: { x: box.width - 2, y: box.height / 2 } });
    await page.keyboard.press("Enter");
    await expect.poll(() => outline(page)).toEqual(["toggleListItem:買い物", "  paragraph:"]);

    await commitWord(page, "・", word, selected ? 1 : 0);
    await expect.poll(() => outline(page)).toEqual(["toggleListItem:買い物", `  ${made}`]);
  });
}

// A phrase converted in parts, committed with its first part still the one
// being converted, in an item indented under another inside a toggle:
// ProseMirror's Enter for the line WebKit took out took that part out with
// the selection, and split the rest into a new line, where the phrase went too.
test("a phrase committed in parts in an indented item inside a toggle comes out once, in its line", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the Mac desktop app's window");
  await signUp(page);
  await openApp(page);
  await createNote(page, "文節");
  await editor(page).click();
  await page.keyboard.type("/折りたたみリスト");
  // The list for all that was typed, not an earlier one, loaded after it.
  await expect(page.getByRole("option").first()).toContainText("折りたたみリスト");
  await page.keyboard.press("Enter");
  await page.keyboard.type("見出し");
  const toggle = editor(page).locator('[data-content-type="toggleListItem"]');
  await toggle.locator(".bn-toggle-button").click();
  await expect(toggle.locator(".bn-toggle-wrapper")).toHaveAttribute("data-show-children", "true");
  const line = toggle.locator(".bn-inline-content");
  const box = (await line.boundingBox())!;
  await line.click({ position: { x: box.width - 2, y: box.height / 2 } });
  await page.keyboard.press("Enter");
  await page.keyboard.type("- 上の行");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect
    .poll(() => outline(page))
    .toEqual(["toggleListItem:見出し", "  bulletListItem:上の行", "    bulletListItem:"]);

  await commitWord(page, "お前の首が危ない", "お前の首が危ない", 3);
  await page.waitForTimeout(200);
  await expect
    .poll(() => outline(page))
    .toEqual([
      "toggleListItem:見出し",
      "  bulletListItem:上の行",
      "    bulletListItem:お前の首が危ない",
    ]);
});

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
