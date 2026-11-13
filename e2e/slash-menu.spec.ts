import { expect, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, signUp } from "./helpers";

/** The / menu's item the arrow keys have picked, and whether it looks picked. */
const picked = (page: Page) =>
  page.evaluate(() => {
    const item = document.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    if (!item) return null;
    const list = item.closest(".bn-suggestion-menu")!.getBoundingClientRect();
    const box = item.getBoundingClientRect();
    return {
      text: item.textContent ?? "",
      coloured: getComputedStyle(item).backgroundColor !== "rgba(0, 0, 0, 0)",
      inSight: box.top >= list.top - 1 && box.bottom <= list.bottom + 1,
    };
  });

test.describe("the / menu", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "gone through with a keyboard's arrow keys");
  });

  test("is gone through with the arrow keys, the item picked coloured and in sight, and Enter takes it", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "見出しを付ける");
    await editor(page).click();
    await page.keyboard.type("/");
    await expect(page.getByRole("option").first()).toBeVisible();
    expect(await picked(page)).toMatchObject({ coloured: true, inSight: true });
    expect((await picked(page))!.text).toContain("見出し１");

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    expect(await picked(page)).toMatchObject({ coloured: true, inSight: true });
    expect((await picked(page))!.text).toContain("見出し３");
    await page.keyboard.press("ArrowUp");
    expect((await picked(page))!.text).toContain("見出し２");

    // Far down the list, it is scrolled to.
    for (let i = 0; i < 10; i += 1) await page.keyboard.press("ArrowDown");
    expect(await picked(page)).toMatchObject({ coloured: true, inSight: true });

    // Back up to 見出し２, and taken.
    for (let i = 0; i < 10; i += 1) await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("option")).toHaveCount(0);
    await expect(editor(page).locator('[data-content-type="heading"]')).toHaveAttribute(
      "data-level",
      "2",
    );
  });
});

test.describe("a URL typed in a note, or in the quick note", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "typed on a keyboard");
  });

  test("opens no menu at its : or its /: Enter ends the line, and nothing of it goes", async ({ page }) => {
    await signUp(page);
    await page.goto("/quick?window=1");
    const quick = page.locator(".memoca-quick-editor .bn-editor").first();
    await quick.click();
    await page.keyboard.type("https://example.com/a");
    await expect(page.getByRole("option")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await page.keyboard.type("次の行");
    await expect
      .poll(() => quick.locator(".bn-block-content").allInnerTexts())
      .toEqual(["https://example.com/a", "次の行"]);

    await openApp(page);
    await createNote(page, "URL のメモ");
    await editor(page).click();
    await page.keyboard.type("https://example.com/b");
    await page.keyboard.press("Enter");
    await page.keyboard.type("次の行");
    await expect
      .poll(() => editor(page).locator(".bn-block-content").allInnerTexts())
      .toEqual(["https://example.com/b", "次の行"]);
    // Nor at a date's /, after a number.
    await page.keyboard.press("Enter");
    await page.keyboard.type("締切 11/30");
    await page.keyboard.press("Enter");
    await page.keyboard.type("その次");
    await expect
      .poll(() => editor(page).locator(".bn-block-content").allInnerTexts())
      .toEqual(["https://example.com/b", "次の行", "締切 11/30", "その次"]);
    // After a space, the / menu opens as ever; with nothing in it to
    // choose, Enter is a new line.
    await page.keyboard.type(" /");
    await expect(page.getByRole("option").first()).toBeVisible();
    await page.keyboard.type("ないもの");
    await expect(page.getByRole("option")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await editor(page).locator(".bn-block-content").allInnerTexts()).map((text) => text.trim()))
      .toEqual(["https://example.com/b", "次の行", "締切 11/30", "その次 /ないもの", ""]);
  });
});

test("a / written between two words is not the menu's to take: 図/表 and Enter stay as written", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "typed on a computer's keyboard");
  await signUp(page);
  await openApp(page);
  await createNote(page, "スラッシュ");
  await editor(page).click();
  // Before: a table put in, and 「/表」 gone; an image for 写真/画像.
  for (const words of ["図/表", "写真/画像", "行/列"]) {
    await page.keyboard.type(words);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.type("おわり");
  const kinds = await editor(page).evaluate((root) =>
    [...root.querySelectorAll(".bn-block-content")].map(
      (content) => `${(content as HTMLElement).dataset.contentType}:${content.textContent}`,
    ),
  );
  expect(kinds).toEqual(["paragraph:図/表", "paragraph:写真/画像", "paragraph:行/列", "paragraph:おわり"]);

  // After a line's words, the menu still makes that line a heading, found by its reading too.
  await page.keyboard.press("Enter");
  await page.keyboard.type("きょうの予定/みだし");
  // The menu's items are found a moment after what is typed: Enter once they are there.
  await expect(page.getByRole("option", { name: /^見出し１/ })).toBeVisible();
  await page.keyboard.press("Enter");
  const last = editor(page).locator(".bn-block-content").last();
  await expect(last).toHaveAttribute("data-content-type", "heading");
  await expect(last).toHaveText("きょうの予定");
});
