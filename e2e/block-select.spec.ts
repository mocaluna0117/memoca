import { expect, test } from "@playwright/test";
import { editor } from "./helpers";
import { caretIn, chosen, openHandleMenu, outline, writeNote } from "./block-select-helpers";

test.describe("blocks chosen whole", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "chosen with the keyboard");
  });

  test("Esc chooses the caret's block, copied and pasted as one, into an empty line or after a line", async ({
    page,
  }) => {
    await writeNote(page);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await caretIn(page, "牛乳");
    await page.keyboard.press("Escape");
    await expect.poll(() => chosen(page)).toEqual(["牛乳"]);
    await page.keyboard.press("ControlOrMeta+c");
    const plain = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      return (await item!.getType("text/plain")).text();
    });
    expect(plain.trim()).toBe("・牛乳");

    // Into the empty line: in its place.
    await editor(page).locator(".bn-block-content").last().click();
    await expect.poll(() => chosen(page)).toEqual([]);
    await page.keyboard.press("ControlOrMeta+v");
    await expect
      .poll(() => outline(page))
      .toEqual([
        "bulletListItem:牛乳",
        "bulletListItem:卵",
        "paragraph:メモの行",
        "bulletListItem:牛乳",
      ]);
    // In the middle of a line of text: after it, the line left whole.
    await caretIn(page, "メモの行", 2);
    await page.keyboard.press("ControlOrMeta+v");
    await expect
      .poll(() => outline(page))
      .toEqual([
        "bulletListItem:牛乳",
        "bulletListItem:卵",
        "paragraph:メモの行",
        "bulletListItem:牛乳",
        "bulletListItem:牛乳",
      ]);
    // Each a block of its own.
    const ids = await editor(page).evaluate((root) =>
      [...root.querySelectorAll("[data-node-type=blockContainer]")].map((block) =>
        block.getAttribute("data-id"),
      ),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("Shift+↓ takes in the next, Backspace takes them out, and ⌘Z brings them back at once", async ({
    page,
  }) => {
    await writeNote(page);
    await caretIn(page, "牛乳");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+ArrowDown");
    await expect.poll(() => chosen(page)).toEqual(["牛乳", "卵"]);
    await page.keyboard.press("Backspace");
    await expect.poll(() => outline(page)).toEqual(["paragraph:メモの行", "paragraph:"]);
    await page.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(() => outline(page))
      .toEqual(["bulletListItem:牛乳", "bulletListItem:卵", "paragraph:メモの行", "paragraph:"]);
  });

  test("⌘D duplicates the blocks chosen, or the caret's, the copies chosen", async ({ page }) => {
    await writeNote(page);
    await caretIn(page, "卵");
    await page.keyboard.press("ControlOrMeta+d");
    await expect
      .poll(() => outline(page))
      .toEqual([
        "bulletListItem:牛乳",
        "bulletListItem:卵",
        "bulletListItem:卵",
        "paragraph:メモの行",
        "paragraph:",
      ]);
    await expect.poll(() => chosen(page)).toEqual(["卵"]);
    // ↑ to the one before: the original.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Shift+ArrowUp");
    await expect.poll(() => chosen(page)).toEqual(["牛乳", "卵"]);
    await page.keyboard.press("ControlOrMeta+d");
    await expect
      .poll(() => outline(page))
      .toEqual([
        "bulletListItem:牛乳",
        "bulletListItem:卵",
        "bulletListItem:牛乳",
        "bulletListItem:卵",
        "bulletListItem:卵",
        "paragraph:メモの行",
        "paragraph:",
      ]);
  });

  test("Enter lets them go, the caret at the end of the line, and Esc too", async ({ page }) => {
    await writeNote(page);
    await caretIn(page, "牛乳", 0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => chosen(page)).toEqual(["卵"]);
    await page.keyboard.press("Enter");
    await expect.poll(() => chosen(page)).toEqual([]);
    await page.keyboard.type("と砂糖");
    await expect.poll(() => outline(page)).toContain("bulletListItem:卵と砂糖");

    await page.keyboard.press("Escape");
    await expect.poll(() => chosen(page)).toEqual(["卵と砂糖"]);
    await page.keyboard.press("Escape");
    await expect.poll(() => chosen(page)).toEqual([]);
  });

  test("pasted over blocks chosen, the blocks go in their place", async ({ page }) => {
    await writeNote(page);
    await caretIn(page, "牛乳");
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+c");
    await caretIn(page, "メモの行");
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+v");
    await expect
      .poll(() => outline(page))
      .toEqual(["bulletListItem:牛乳", "bulletListItem:卵", "bulletListItem:牛乳", "paragraph:"]);
  });

  test("a closed toggle chosen goes with what is hidden inside it", async ({ page }) => {
    await writeNote(page);
    await editor(page).locator(".bn-block-content").last().click();
    await page.keyboard.type("/折りたたみリスト");
    // The list for all that was typed, not an earlier one, loaded after it.
    await expect(page.getByRole("option").first()).toContainText("折りたたみリスト");
    await page.keyboard.press("Enter");
    await page.keyboard.type("箱");
    const toggle = editor(page).locator('[data-content-type="toggleListItem"]');
    await toggle.locator(".bn-toggle-button").click();
    await toggle.locator(".bn-toggle-add-block-button").click();
    await page.keyboard.type("中身");
    await toggle.locator(".bn-toggle-button").click();
    await expect(toggle.locator(".bn-toggle-wrapper")).toHaveAttribute(
      "data-show-children",
      "false",
    );

    await caretIn(page, "箱");
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+c");
    await caretIn(page, "メモの行");
    await page.keyboard.press("ControlOrMeta+v");
    await expect
      .poll(() => outline(page))
      .toEqual([
        "bulletListItem:牛乳",
        "bulletListItem:卵",
        "paragraph:メモの行",
        "toggleListItem:箱",
        "  paragraph:中身",
        "toggleListItem:箱",
        "  paragraph:中身",
      ]);
  });

  test("a block's handle chooses it, and its menu's 複製, コピー and 削除 act on it", async ({
    page,
  }) => {
    await writeNote(page);
    await openHandleMenu(page, "卵");
    await expect.poll(() => chosen(page)).toEqual(["卵"]);
    await page.getByRole("menuitem", { name: "複製" }).click();
    await expect
      .poll(() => outline(page))
      .toEqual([
        "bulletListItem:牛乳",
        "bulletListItem:卵",
        "bulletListItem:卵",
        "paragraph:メモの行",
        "paragraph:",
      ]);

    await openHandleMenu(page, "牛乳");
    await page.getByRole("menuitem", { name: "コピー" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await editor(page).locator(".bn-block-content").last().click();
    await expect.poll(() => chosen(page)).toEqual([]);
    await page.keyboard.press("ControlOrMeta+v");
    await expect
      .poll(() => outline(page))
      .toEqual([
        "bulletListItem:牛乳",
        "bulletListItem:卵",
        "bulletListItem:卵",
        "paragraph:メモの行",
        "bulletListItem:牛乳",
      ]);

    await openHandleMenu(page, "メモの行");
    await page.getByRole("menuitem", { name: "削除" }).click();
    await expect.poll(() => outline(page)).not.toContain("paragraph:メモの行");
  });

  test("a handle of one of the blocks chosen keeps them all chosen, 削除 taking them all", async ({
    page,
  }) => {
    await writeNote(page);
    await caretIn(page, "牛乳");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+ArrowDown");
    await expect.poll(() => chosen(page)).toEqual(["牛乳", "卵"]);
    await openHandleMenu(page, "卵");
    await expect.poll(() => chosen(page)).toEqual(["牛乳", "卵"]);
    await page.getByRole("menuitem", { name: "削除" }).click();
    await expect.poll(() => outline(page)).toEqual(["paragraph:メモの行", "paragraph:"]);
  });

  test("Esc with the / menu open closes the menu, choosing nothing", async ({ page }) => {
    await writeNote(page);
    await editor(page).locator(".bn-block-content").last().click();
    await page.keyboard.type("/");
    await expect(page.getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("option")).toHaveCount(0);
    await expect.poll(() => chosen(page)).toEqual([]);
  });
});
