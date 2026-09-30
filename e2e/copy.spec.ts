import { expect, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, signUp } from "./helpers";

/** A note of two lines in one paragraph (a line break within it), then a list. */
async function writeNote(page: Page) {
  await signUp(page);
  await openApp(page);
  await createNote(page, "コピー元");
  await editor(page).click();
  await page.keyboard.type("一行目");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("二行目 a_b*c");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- 牛乳");
  await page.keyboard.press("Enter");
  await page.keyboard.type("卵");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
}

/** What the clipboard holds, once every handler has had the copy. */
async function copied(page: Page): Promise<{ plain: string; html: string }> {
  await page.keyboard.press("ControlOrMeta+c");
  const { plain, html, windows } = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    const read = async (type: string) =>
      item?.types.includes(type) ? (await item.getType(type)).text() : "";
    return {
      plain: await read("text/plain"),
      html: await read("text/html"),
      windows: /Windows/.test(navigator.userAgent),
    };
  });
  // On Windows (as Playwright's desktop Chrome says it is), lines end in CRLF.
  expect(plain.includes("\r\n")).toBe(windows);
  return { plain: plain.replace(/\r\n/g, "\n"), html };
}

/** As it reads: no backslash for the line break, nothing escaped, no blank lines, and the marks of the list. */
const AS_IT_READS = "一行目\n二行目 a_b*c\n・牛乳\n・卵";

test.describe("copying from a note", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "selected by the mouse and copied by the keyboard",
    );
  });

  test("gives an app that takes plain text the text as it reads, and a rich one the note's own", async ({
    page,
  }) => {
    await writeNote(page);
    // Selected with the mouse, from the first line to the end of the list.
    const first = (await page.locator('[data-content-type="paragraph"]').first().boundingBox())!;
    const last = (await page.locator('[data-content-type="bulletListItem"]').last().boundingBox())!;
    await page.mouse.move(first.x + 2, first.y + 5);
    await page.mouse.down();
    await page.mouse.move(last.x + last.width - 2, last.y + last.height - 5, { steps: 10 });
    await page.mouse.up();

    const { plain, html } = await copied(page);
    expect(plain).toBe(AS_IT_READS);
    // A note, or a rich-text app, still gets the note as it is.
    expect(html).toContain("<ul>");
  });

  test("the same for the whole note, selected all at once", async ({ page }) => {
    await writeNote(page);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+a");
    expect((await copied(page)).plain).toBe(AS_IT_READS);
  });
});
