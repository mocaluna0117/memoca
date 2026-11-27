import { expect, type Page, test } from "@playwright/test";
import { signUp } from "./helpers";

/** The Mac desktop app's user agent (desktop/src-tauri/src/window.rs), in its engine. */
test.use({
  browserName: "webkit",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) MemocaShell/0.4.21 (macos)",
});

const todo = (page: Page) => page.getByLabel("Todo", { exact: true });
const lines = (page: Page) =>
  todo(page).evaluate((root) => [...root.querySelectorAll(".bn-inline-content")].map((p) => p.textContent ?? ""));
const line = (page: Page, text: string) =>
  todo(page).locator(".bn-inline-content", { hasText: new RegExp(`^${text}$`) });

/** The Todo, with enough items for its pane to scroll (WebKit's selection autoscroll needs one). */
async function longTodo(page: Page) {
  await signUp(page);
  await page.goto("/quick?window=1");
  await page.getByRole("button", { name: "Todo を開く" }).click();
  await expect(todo(page)).toBeVisible();
  await todo(page).click();
  await page.keyboard.type("first");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await page.keyboard.press("Enter");
  await page.keyboard.type("third");
  for (let at = 0; at < 40; at += 1) {
    await page.keyboard.press("Enter");
    await page.keyboard.insertText(`item${at}`);
  }
  await line(page, "second").scrollIntoViewIfNeeded();
}

/** Where the text of the line of this text ends, on screen. */
const textEnd = (page: Page, text: string) =>
  line(page, text).evaluate((p) => {
    const range = document.createRange();
    range.selectNodeContents(p);
    const rect = range.getBoundingClientRect();
    return { x: rect.right, y: rect.top + rect.height / 2 };
  });

test("a press WebKit never saw let go of: Enter's new item kept, every character typed into it, the selection left still", async ({
  page,
}) => {
  await longTodo(page);
  await line(page, "item30").scrollIntoViewIfNeeded();
  // As the Mac desktop app's records had it (2026-11-25, 2026-11-28): the
  // caret put at the end of an item by a press that moved a little and was
  // never let go of, the pointer left there.
  const end = await textEnd(page, "item30");
  await page.mouse.move(end.x + 15, end.y);
  await page.mouse.down();
  await page.mouse.move(end.x + 17, end.y, { steps: 2 });
  await page.waitForTimeout(200);
  const pane = page.locator("[data-quick-pane]");
  const scrolled = await pane.evaluate((box) => box.scrollTop);
  expect(scrolled).toBeGreaterThan(0);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  // WebKit's selection autoscroll, which took the selection on every 50 ms, stopped.
  const changes = await page.evaluate(async () => {
    let count = 0;
    const counted = () => {
      count += 1;
    };
    document.addEventListener("selectionchange", counted);
    await new Promise((resolve) => setTimeout(resolve, 500));
    document.removeEventListener("selectionchange", counted);
    return count;
  });
  expect(changes).toBe(0);
  for (const character of "abcdefghijklmnopqrstuvwx") {
    await page.keyboard.type(character);
    await page.waitForTimeout(80);
  }
  await page.mouse.up();
  const all = await lines(page);
  const at = all.indexOf("item30");
  expect(all.slice(at, at + 3)).toEqual(["item30", "abcdefghijklmnopqrstuvwx", "item31"]);
  // Where the pane was scrolled to, kept as the autoscroll was stopped.
  expect(Math.abs((await pane.evaluate((box) => box.scrollTop)) - scrolled)).toBeLessThan(60);
});

test("a selection made by dragging over the text, or with Shift and an arrow after typing, is kept", async ({
  page,
}) => {
  await longTodo(page);
  const end = await textEnd(page, "second");
  await line(page, "second").click();
  await page.keyboard.press("Meta+ArrowRight");
  await page.keyboard.type("!");
  // Shift + ← twice: "d!" selected, and typed over.
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.waitForTimeout(150);
  await page.keyboard.type("D");
  await expect.poll(async () => (await lines(page))[1]).toBe("seconD");

  // Dragged from the line's end back over its last three characters, and typed over.
  const box = (await line(page, "seconD").boundingBox())!;
  await page.mouse.move(end.x + 5, end.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, end.y, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const selected = await page.evaluate(() => getSelection()!.toString());
  expect(selected.length).toBeGreaterThan(0);
  await page.keyboard.type("Z");
  await expect.poll(async () => (await lines(page))[1]).toBe(`seconD`.slice(0, 6 - selected.length) + "Z");
});
