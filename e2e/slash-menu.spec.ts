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
