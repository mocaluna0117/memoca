import { expect, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, showList, signIn, signUp, waitForSynced } from "./helpers";

/** The Todo's editor. */
const todo = (page: Page) => page.getByLabel("Todo", { exact: true });
/** The Todo as it reads: "[x] 卵" for one done, "[ ] 牛乳" for one to do. */
const items = (page: Page) =>
  todo(page).evaluate((root) =>
    [...root.querySelectorAll('.bn-block-content[data-content-type="checkListItem"]')].map(
      (item) =>
        `[${(item as HTMLElement).dataset.checked === "true" ? "x" : " "}] ${item.querySelector(".bn-inline-content")?.textContent ?? ""}`,
    ),
  );
/** The Todo as it reads, with an item's details under it, a step in: "  ・説明". */
const lines = (page: Page) =>
  todo(page).evaluate((root) => {
    const out: string[] = [];
    const walk = (group: Element, depth: number) => {
      for (const outer of group.children) {
        const content = outer.querySelector(":scope > .bn-block > .bn-block-content") as HTMLElement | null;
        if (!content) continue;
        const text = content.querySelector(".bn-inline-content")?.textContent ?? "";
        const line =
          content.dataset.contentType === "checkListItem"
            ? `[${content.dataset.checked === "true" ? "x" : " "}] ${text}`
            : `・${text}`;
        out.push(`${"  ".repeat(depth)}${line}`);
        const inner = outer.querySelector(":scope > .bn-block > .bn-block-group");
        if (inner) walk(inner, depth + 1);
      }
    };
    const top = root.querySelector(".bn-block-group");
    if (top) walk(top, 0);
    return out;
  });
/** Ticks the item of this text by its box. */
const tick = (page: Page, text: string) =>
  todo(page)
    .locator('.bn-block-content[data-content-type="checkListItem"]', {
      has: page.locator(".bn-inline-content", { hasText: new RegExp(`^${text}$`) }),
    })
    .locator('input[type="checkbox"]')
    .click();

async function openTodo(page: Page) {
  await page.getByRole("button", { name: "Todo を開く" }).click();
  await expect(todo(page)).toBeVisible();
}

/** Writes items, one a line, after what is to do. */
async function write(page: Page, ...lines: string[]) {
  await todo(page).click();
  for (const [at, line] of lines.entries()) {
    if (at > 0) await page.keyboard.press("Enter");
    await page.keyboard.type(line);
  }
}

test.describe("the quick note's Todo", () => {
  test("every line an item; ticked, it goes to the foot, and the done go together", async ({ page }) => {
    await signUp(page);
    await page.goto("/quick?window=1");
    await openTodo(page);
    await expect(page.getByRole("tab", { name: "Todo" })).toHaveAttribute("aria-selected", "true");
    await write(page, "牛乳", "卵", "パン");
    await expect.poll(() => items(page)).toEqual(["[ ] 牛乳", "[ ] 卵", "[ ] パン"]);

    await tick(page, "卵");
    await expect.poll(() => items(page)).toEqual(["[ ] 牛乳", "[ ] パン", "[x] 卵"]);
    // No save, no folder, no images in it.
    await expect(page.getByRole("button", { name: "保存", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "画像を追加" })).toHaveCount(0);

    await page.getByRole("button", { name: "完了 1 件を消す" }).click();
    await expect.poll(() => items(page)).toEqual(["[ ] 牛乳", "[ ] パン"]);
  });

  test("⌘ + Enter ticks the item, the caret going on to the next to do", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "a keyboard's ⌘ + Enter");
    await signUp(page);
    await page.goto("/quick?window=1");
    await openTodo(page);
    await write(page, "一つ目", "二つ目", "三つ目");
    // To the first item's end, and ticked twice over.
    await todo(page).locator(".bn-inline-content", { hasText: /^一つ目$/ }).click();
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect.poll(() => items(page)).toEqual(["[ ] 三つ目", "[x] 二つ目", "[x] 一つ目"]);
  });

  test("under an item, lines of its details, with no box: they go with it as it is ticked", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "a keyboard's Shift + Enter and Tab");
    await signUp(page);
    await page.goto("/quick?window=1");
    await openTodo(page);
    await write(page, "富士フイルム");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("https://example.com/winter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("11/30 正午");
    // Out of the details, to the next item.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("カプコン");
    await expect.poll(() => lines(page)).toEqual([
      "[ ] 富士フイルム",
      "  ・https://example.com/winter",
      "  ・11/30 正午",
      "[ ] カプコン",
    ]);
    // A line of details has no box, and is smaller than an item.
    const detail = todo(page).locator(".bn-block-content", { hasText: "11/30 正午" });
    await expect(detail.locator('input[type="checkbox"]')).toHaveCount(0);

    await page.keyboard.press("Tab");
    await expect.poll(() => lines(page)).toEqual([
      "[ ] 富士フイルム",
      "  ・https://example.com/winter",
      "  ・11/30 正午",
      "  ・カプコン",
    ]);
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => lines(page)).toEqual([
      "[ ] 富士フイルム",
      "  ・https://example.com/winter",
      "  ・11/30 正午",
      "[ ] カプコン",
    ]);

    await tick(page, "富士フイルム");
    await expect.poll(() => lines(page)).toEqual([
      "[ ] カプコン",
      "[x] 富士フイルム",
      "  ・https://example.com/winter",
      "  ・11/30 正午",
    ]);
    await page.screenshot({ path: testInfo.outputPath("todo-details.png") });
  });

  test("on a phone, a button makes the caret's line a detail, and an item again", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "a phone's screen, with no Tab");
    await signUp(page);
    await page.goto("/quick");
    await openTodo(page);
    await write(page, "株式会社デジタルガレージ", "適性検査 11/13");
    await page.getByRole("button", { name: "補足行にする" }).click();
    await expect.poll(() => lines(page)).toEqual(["[ ] 株式会社デジタルガレージ", "  ・適性検査 11/13"]);
    await page.getByRole("button", { name: "項目にする" }).click();
    await expect.poll(() => lines(page)).toEqual(["[ ] 株式会社デジタルガレージ", "[ ] 適性検査 11/13"]);
  });

  test("its tab, and what is in it, are there when the quick note opens again", async ({ page }) => {
    await signUp(page);
    await page.goto("/quick?window=1");
    await openTodo(page);
    await write(page, "あとでやる");
    await waitForSynced(page).catch(() => undefined);
    await page.waitForTimeout(800);
    await page.reload();
    await expect(page.getByRole("tab", { name: "Todo" })).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => items(page)).toEqual(["[ ] あとでやる"]);
  });

  test("on another device, the same list: what is added on one shows on the other", async ({
    page,
    context,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "two devices, typed on a computer's keyboard");
    test.slow();
    const email = await signUp(page);
    await page.goto("/quick?window=1");
    await openTodo(page);
    await write(page, "こちらで足した");

    const fresh = await context.browser()!.newContext({
      baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
      viewport: page.viewportSize(),
    });
    const other = await fresh.newPage();
    await signIn(other, email);
    await other.goto("/quick?window=1");
    await openTodo(other);
    await expect.poll(() => items(other), { timeout: 30_000 }).toContain("[ ] こちらで足した");
    // Nothing lost on the first, where it was written, as the other opened it.
    await page.waitForTimeout(2_000);
    expect(await items(page)).toContain("[ ] こちらで足した");

    await todo(other).locator(".bn-inline-content", { hasText: /^こちらで足した$/ }).click();
    // To the line's end (a Mac's End scrolls the page instead).
    await other.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
    await other.keyboard.press("Enter");
    await other.keyboard.type("あちらで足した");
    await expect.poll(() => items(page), { timeout: 10_000 }).toEqual([
      "[ ] こちらで足した",
      "[ ] あちらで足した",
    ]);
    await fresh.close();
  });

  test("is not a note of Memoca's own: not listed, not found, not linked to", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the lists and the search, on a computer");
    await signUp(page);
    await page.goto("/quick?window=1");
    await openTodo(page);
    await write(page, "目印のやること");
    await page.waitForTimeout(800);

    await openApp(page);
    await createNote(page, "ふつうのメモ");
    await showList(page);
    await expect(page.locator("[data-note-row]").filter({ hasText: "ふつうのメモ" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("目印のやること")).toHaveCount(0);
    // Not found by the search…
    await page.goto(`/app/search?${new URLSearchParams({ q: "目印" })}`);
    await expect(page.getByText("目印のやること")).toHaveCount(0);
    // …nor offered as a note to link to.
    await openApp(page);
    await page.locator("[data-note-row]").filter({ hasText: "ふつうのメモ" }).first().click();
    await editor(page).click();
    await page.keyboard.type("[[目印");
    await page.waitForTimeout(500);
    await expect(page.getByRole("option", { name: /目印のやること/ })).toHaveCount(0);
  });
});
