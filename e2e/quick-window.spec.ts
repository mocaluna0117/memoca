import { expect, type Page, test } from "@playwright/test";
import { editor, expectQuickText, openApp, quickField, signUp, writeQuick } from "./helpers";
import { onScreen } from "./image-helpers";
import { readTable } from "./local-db";

const WINDOW = "popup,width=380,height=460";

/** Whether this device holds a draft of the quick note. */
const hasDraft = async (page: Page) =>
  (await readTable<{ key: string }>(page, "meta")).some((row) => row.key.startsWith("quickDraft:"));

test.describe("the quick note in a window of its own", () => {
  test("however much is written, the header and its save button stay in view", async ({ page }) => {
    await signUp(page);
    await page.goto("/quick?window=1");
    await writeQuick(
      quickField(page),
      Array.from({ length: 60 }, (_, line) => `${line + 1} 行目`).join("\n"),
    );
    const save = page.getByRole("button", { name: "保存" });
    expect(onScreen(page, (await save.boundingBox())!)).toBe(true);
    // What is written scrolls inside the field; the window itself does not.
    expect(
      await page.evaluate(() => document.scrollingElement!.scrollHeight <= window.innerHeight),
    ).toBe(true);
  });

  test("Ctrl + Enter saves it, and the window stays, as it is, saying so", async ({
    page,
    context,
  }) => {
    await signUp(page);
    await page.goto("/quick?window=1");
    await expect(page.getByText("Ctrl + Enter で保存 ・ Esc で閉じる")).toBeVisible();
    const field = quickField(page);
    await writeQuick(field, "窓から保存\n本文");
    // Kept as a draft while it is being written...
    await expect.poll(() => hasDraft(page)).toBe(true);
    await field.press("Control+Enter");
    await expect(page.getByRole("status").filter({ hasText: "保存しました" })).toBeVisible();
    await expectQuickText(field, "窓から保存\n本文");
    await expect(page).toHaveURL(/\/quick\?window=1$/);
    // ...and still, saved: the tab stays as it is, nothing new to save.
    await expect.poll(() => hasDraft(page)).toBe(true);
    await expect(page.getByRole("button", { name: "保存" })).toBeDisabled();

    // No window of the app's opened this one: the note opens in a new one,
    // and this one stays the quick note.
    const opened = context.waitForEvent("page");
    await page.getByRole("button", { name: "メモを開く" }).click();
    const app = await opened;
    await expect(app).toHaveURL(/\/app\?n=/);
    await expect(app.getByLabel("メモのタイトル")).toHaveValue("");
    await expect(editor(app)).toContainText("窓から保存");
    await expect(page).toHaveURL(/\/quick\?window=1$/);
  });

  test("Esc puts away a window the app opened, and its draft is there when it opens again", async ({
    page,
    context,
  }) => {
    await signUp(page);
    await openApp(page);
    const opened = context.waitForEvent("page");
    await page.evaluate(
      (features) => window.open("/quick?window=1", "memoca-quick", features),
      WINDOW,
    );
    const popup = await opened;
    const field = quickField(popup);
    await writeQuick(field, "閉じる前の下書き");
    const closed = popup.waitForEvent("close");
    await field.press("Escape");
    await closed;

    const again = context.waitForEvent("page");
    await page.evaluate(
      (features) => window.open("/quick?window=1", "memoca-quick", features),
      WINDOW,
    );
    await expectQuickText(quickField(await again), "閉じる前の下書き");
  });
});

test.describe("the quick note's window on a Mac", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  });

  test("says ⌘ where the keyboard says ⌘", async ({ page }) => {
    await signUp(page);
    await page.goto("/quick?window=1");
    await expect(page.getByText("⌘ + Enter で保存 ・ Esc で閉じる")).toBeVisible();
  });
});
