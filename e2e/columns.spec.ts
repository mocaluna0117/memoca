import { expect, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, signUp, waitForSynced } from "./helpers";

/** A block's line, by its text. */
const line = (page: Page, text: string) =>
  editor(page).locator(".bn-inline-content").filter({ hasText: text }).first();

/** The columns of the note, and the text in each. */
const columns = (page: Page) =>
  editor(page)
    .locator(".bn-block-column")
    .evaluateAll((all) => all.map((column) => column.textContent?.trim() ?? ""));

/** Where two lines are, to tell side by side from one under the other. */
async function boxes(page: Page, a: string, b: string) {
  const first = (await line(page, a).boundingBox())!;
  const second = (await line(page, b).boundingBox())!;
  return { first, second };
}

test.describe("columns", () => {
  test("made from the / menu, written in, side by side where the note is wide, one under another where it is not", async ({
    page,
  }, testInfo) => {
    const phone = testInfo.project.name === "mobile";
    await signUp(page);
    await openApp(page);
    await createNote(page, "段組み");
    await editor(page).click();
    await page.keyboard.type("/二列");
    await expect(page.getByRole("option", { name: /二列/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(editor(page).locator(".bn-block-column")).toHaveCount(2);

    // The caret is in the first; the second is clicked into.
    await page.keyboard.type("左の列");
    await editor(page).locator(".bn-block-column").nth(1).locator(".bn-block-content").first().click();
    await page.keyboard.type("右の列");
    await expect.poll(() => columns(page)).toEqual(["左の列", "右の列"]);

    const { first, second } = await boxes(page, "左の列", "右の列");
    if (phone) {
      expect(Math.abs(first.x - second.x)).toBeLessThan(4);
      expect(second.y).toBeGreaterThan(first.y + first.height);
      // Laid out at a sheet's width, as for a PDF: side by side, from a phone too.
      const row = await editor(page).evaluate((element) => {
        const note = element.closest<HTMLElement>(".memoca-editor")!;
        note.style.width = "720px";
        const direction = getComputedStyle(note.querySelector(".bn-block-column-list")!).flexDirection;
        note.style.width = "";
        return direction;
      });
      expect(row).toBe("row");
    } else {
      expect(second.x).toBeGreaterThan(first.x + 100);
      expect(Math.abs(first.y - second.y)).toBeLessThan(4);
    }

    // Kept, as any block is.
    await waitForSynced(page);
    await page.reload();
    await expect.poll(() => columns(page), { timeout: 30_000 }).toEqual(["左の列", "右の列"]);
  });

  test("a block dragged to another's right edge goes beside it, in a column of its own", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "a mouse");
    await signUp(page);
    await openApp(page);
    await createNote(page, "並べる");
    await editor(page).click();
    await page.keyboard.type("一つ目");
    await page.keyboard.press("Enter");
    await page.keyboard.type("二つ目");

    await line(page, "二つ目").hover();
    const handle = page.locator(".bn-side-menu [draggable='true']").first();
    await expect(handle).toBeVisible();
    const from = (await handle.boundingBox())!;
    const target = (await editor(page).locator(".bn-block-outer").filter({ hasText: "一つ目" }).first().boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width - 8, target.y + target.height / 2, { steps: 12 });
    await page.mouse.up();

    await expect.poll(() => columns(page)).toEqual(["一つ目", "二つ目"]);
    const { first, second } = await boxes(page, "一つ目", "二つ目");
    expect(second.x).toBeGreaterThan(first.x + 100);
  });

  test("a block dragged straight down the margin its handle is in is moved, not put beside another", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "a mouse");
    await signUp(page);
    await openApp(page);
    await createNote(page, "並べ替え");
    await editor(page).click();
    for (const text of ["一行目", "二行目", "三行目"]) {
      await page.keyboard.type(text);
      await page.keyboard.press("Enter");
    }
    await line(page, "三行目").hover();
    const handle = page.locator(".bn-side-menu [draggable='true']").first();
    await expect(handle).toBeVisible();
    const from = (await handle.boundingBox())!;
    const to = (await line(page, "二行目").boundingBox())!;
    const x = from.x + from.width / 2;
    await page.mouse.move(x, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, to.y + 4, { steps: 10 });
    await page.mouse.up();

    await expect
      .poll(() => editor(page).locator(".bn-inline-content").allTextContents())
      .toEqual(["一行目", "三行目", "二行目", ""]);
    await expect(editor(page).locator(".bn-block-column")).toHaveCount(0);
  });
});
