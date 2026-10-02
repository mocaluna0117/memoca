import { expect, type Locator, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, showList, signUp, waitForSynced } from "./helpers";
import { raiseKeyboard } from "./image-helpers";

/** The caret to the start of its line, arrow by arrow (Home is not that on a Mac). */
async function toLineStart(page: Page) {
  const offset = () => page.evaluate(() => getSelection()?.anchorOffset ?? 0);
  for (let left = 0; left < 50 && (await offset()) > 0; left += 1) {
    await page.keyboard.press("ArrowLeft");
  }
  expect(await offset()).toBe(0);
}

/** The caret to the end of a block's line: a click on its last character's right half. */
async function toLineEnd(page: Page, block: Locator) {
  const text = (await block.textContent()) ?? "";
  const end = await block.locator(".bn-inline-content").evaluate((line) => {
    const range = document.createRange();
    range.selectNodeContents(line);
    const box = range.getBoundingClientRect();
    return { x: box.right - 2, y: box.top + box.height / 2 };
  });
  await page.mouse.click(end.x, end.y);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const selection = getSelection()!;
        const line = selection.anchorNode?.parentElement?.closest(".bn-inline-content");
        if (!line) return null;
        const before = document.createRange();
        before.setStart(line, 0);
        before.setEnd(selection.anchorNode!, selection.anchorOffset);
        return before.toString();
      }),
    )
    .toBe(text);
  // For the editor to take the caret from where the browser put it.
  await page.waitForTimeout(100);
}

/** Text pasted as another app gives it: plain, a line break a line. */
async function pasteText(page: Page, text: string) {
  await editor(page).evaluate((root, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    root.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
}

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
    // The rule runs just after the input method has let go of the text.
    await expect.poll(() => blocks(page)).toEqual(["bulletListItem", "bulletListItem"]);
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

test.describe("lines written with ・", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "selected and changed with the toolbar");
  });

  test("pasted, selected and made a bullet list, lose their ・ for the list's own", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "買い物");
    await editor(page).click();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(() => navigator.clipboard.writeText("・牛乳\n・卵\n・パン"));
    await page.keyboard.press("ControlOrMeta+v");
    await expect(editor(page)).toContainText("・パン");

    // All of it selected: the toolbar comes, and its type is made a bullet list.
    await page.keyboard.press("ControlOrMeta+a");
    // Pasted, the lines are one paragraph, with line breaks between them.
    await expect(editor(page).locator("[data-content-type]")).toHaveCount(1);
    const type = page.locator(".bn-formatting-toolbar").getByRole("combobox");
    await expect(type).toBeVisible();
    await type.click();
    await page.getByRole("option", { name: "箇条書き" }).click();

    await expect
      .poll(() =>
        editor(page)
          .locator("[data-content-type]")
          .evaluateAll((found) =>
            found.map((block) => `${block.getAttribute("data-content-type")}:${block.textContent}`),
          ),
      )
      .toEqual(["bulletListItem:牛乳", "bulletListItem:卵", "bulletListItem:パン"]);
  });
});

test.describe("a ・ at the start of a line of its own", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "typed on a computer's keyboard");
  });

  test("stays when - makes the line an item, and Backspace takes the - back", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "注意");
    await editor(page).click();
    await pasteText(page, "・注意");
    await expect(editor(page).locator('[data-content-type="paragraph"]')).toHaveText("・注意");
    await toLineStart(page);
    await page.keyboard.type("- ");
    await expect(editor(page).locator('[data-content-type="bulletListItem"]')).toHaveText("・注意");
    await page.keyboard.press("Backspace");
    await expect(editor(page).locator('[data-content-type="paragraph"]')).toHaveText("- ・注意");
  });

  test("stays in an item Memoca copied, and goes from one pasted from elsewhere", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "メモ");
    await editor(page).click();
    // Made an item by - at its start, which leaves its ・ as it is.
    await pasteText(page, "・メモ");
    await toLineStart(page);
    await page.keyboard.type("- ");
    const items = editor(page).locator('[data-content-type="bulletListItem"]');
    await expect(items).toHaveText(["・メモ"]);
    await toLineEnd(page, items.first());
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("次の行");
    await expect(editor(page).locator("[data-content-type]")).toHaveCount(2);

    // All of it copied, as blocks: what Memoca put on the clipboard, kept.
    const copied = page.evaluate(
      () =>
        new Promise<{ own: string; html: string }>((resolve) =>
          window.addEventListener(
            "copy",
            (event) =>
              resolve({
                own: event.clipboardData!.getData("blocknote/html"),
                html: event.clipboardData!.getData("text/html"),
              }),
            { once: true },
          ),
        ),
    );
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+c");
    const { own, html } = await copied;
    expect(own).toContain("・メモ");

    /** Pasted on a new line after the last 次の行, as Memoca's own or as another app's HTML. */
    const paste = async (types: Record<string, string>) => {
      await toLineEnd(
        page,
        // The last: what is pasted has one too.
        editor(page)
          .locator('[data-content-type="paragraph"]')
          .filter({ hasText: "次の行" })
          .last(),
      );
      await page.keyboard.press("Enter");
      await editor(page).evaluate((root, types) => {
        const data = new DataTransfer();
        for (const [type, value] of Object.entries(types)) data.setData(type, value);
        root.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
        );
      }, types);
    };
    await paste({ "blocknote/html": own, "text/html": html });
    await expect(items).toHaveText(["・メモ", "・メモ"]);
    await paste({ "text/html": html });
    await expect(items).toHaveText(["・メモ", "・メモ", "メモ"]);
  });
});

test("on a phone, the bar's 箇条書き makes every line selected an item, and a first line with no ・ one too", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "a phone's bar above its keyboard");
  await signUp(page);
  await openApp(page);
  await createNote(page, "買い物");
  await editor(page).click();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await pasteText(page, "今日の買い物\n・牛乳\n・卵");
  await page.keyboard.press("Enter");
  await pasteText(page, "・パン");
  await expect(editor(page)).toContainText("・パン");
  await expect(editor(page).locator("[data-content-type]")).toHaveCount(2);

  await page.keyboard.press("ControlOrMeta+a");
  await raiseKeyboard(page);
  await page
    .getByRole("toolbar", { name: "ブロックの操作" })
    .getByRole("button", { name: "箇条書き" })
    .click();
  await expect
    .poll(() =>
      editor(page)
        .locator("[data-content-type]")
        .evaluateAll((found) =>
          found.map((block) => `${block.getAttribute("data-content-type")}:${block.textContent}`),
        ),
    )
    .toEqual([
      "bulletListItem:今日の買い物",
      "bulletListItem:牛乳",
      "bulletListItem:卵",
      "bulletListItem:パン",
    ]);
});

test("a note whose first line is a bullet shows its • when opened, with the caret elsewhere", async ({ page }) => {
  // Every mark BlockNote ever puts on a block for what it was before, kept:
  // the list markers are drawn only where there is none.
  await page.addInitScript(() => {
    const marked: string[] = [];
    (window as unknown as { marked: string[] }).marked = marked;
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.attributeName?.startsWith("data-prev-")) marked.push(record.attributeName);
      }
    }).observe(document, { subtree: true, attributes: true });
  });
  await signUp(page);
  await openApp(page);
  await createNote(page, "買い物");
  await editor(page).click();
  // The note's first line, the one every new note starts with.
  await page.keyboard.type("- 牛乳");
  await page.keyboard.press("Enter");
  await page.keyboard.type("卵");
  await waitForSynced(page);
  await createNote(page, "ほか");
  await showList(page);
  await page.getByRole("button", { name: /買い物/ }).filter({ visible: true }).first().click();
  const first = editor(page).locator('[data-content-type="bulletListItem"]').first();
  await expect(first).toContainText("牛乳");
  await page.waitForTimeout(500);
  expect(await first.evaluate((line) => getComputedStyle(line, "::before").content)).toBe('"•"');
  expect(await page.evaluate(() => (window as unknown as { marked: string[] }).marked)).toEqual([]);
});
