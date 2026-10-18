import { expect, test } from "@playwright/test";
import { caretIn, chosen, outline, writeNote } from "./block-select-helpers";

/** The Mac desktop app's user agent (desktop/src-tauri/src/window.rs), in its engine. */
test.use({
  browserName: "webkit",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) MemocaShell/0.4.6 (macos)",
});

test.describe("blocks chosen whole, in the Mac desktop app's engine", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the Mac desktop app's window");
  });

  test("⌘C copies them, though nothing is selected", async ({ page }) => {
    await writeNote(page);
    await page.evaluate(() => {
      const kept: string[] = [];
      (window as unknown as { kept: string[] }).kept = kept;
      const own = DataTransfer.prototype.setData;
      DataTransfer.prototype.setData = function (type: string, data: string) {
        kept.push(type);
        own.call(this, type, data);
      };
    });
    await caretIn(page, "牛乳");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Meta+c");
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { kept: string[] }).kept))
      .toContain("memoca/blocks");
  });

  test("a word written with the input method goes in at the caret, the blocks kept", async ({
    page,
  }) => {
    await writeNote(page);
    await caretIn(page, "牛乳");
    await page.keyboard.press("Escape");
    await expect.poll(() => chosen(page)).toEqual(["牛乳"]);
    const content = page.locator(".ProseMirror");
    await content.evaluate((root) =>
      root.dispatchEvent(new CompositionEvent("compositionstart", { data: "" })),
    );
    await page.keyboard.insertText("あ");
    await content.evaluate((root) =>
      root.dispatchEvent(new CompositionEvent("compositionend", { data: "あ" })),
    );
    await expect.poll(() => chosen(page)).toEqual([]);
    const lines = await outline(page);
    expect(lines).toContain("bulletListItem:卵");
    expect(lines.some((line) => line.includes("牛乳"))).toBe(true);
  });
});
