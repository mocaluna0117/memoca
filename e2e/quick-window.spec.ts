import { expect, test } from "@playwright/test";
import { openApp, signUp } from "./helpers";
import { onScreen } from "./image-helpers";

const WINDOW = "popup,width=380,height=460";

test.describe("the quick note in a window of its own", () => {
  test("however much is written, the header and its save button stay in view", async ({ page }) => {
    await signUp(page);
    await page.goto("/quick?window=1");
    await page
      .getByLabel("即席メモ")
      .fill(Array.from({ length: 60 }, (_, line) => `${line + 1} 行目`).join("\n"));
    const save = page.getByRole("button", { name: "保存" });
    expect(onScreen(page, (await save.boundingBox())!)).toBe(true);
    // What is written scrolls inside the field; the window itself does not.
    expect(
      await page.evaluate(() => document.scrollingElement!.scrollHeight <= window.innerHeight),
    ).toBe(true);
  });

  test("Ctrl + Enter saves it, and the window stays, emptied, saying so", async ({ page }) => {
    await signUp(page);
    await page.goto("/quick?window=1");
    await expect(page.getByText("Ctrl + Enter で保存 ・ Esc で閉じる")).toBeVisible();
    const field = page.getByLabel("即席メモ");
    await field.fill("窓から保存\n本文");
    await field.press("Control+Enter");
    await expect(page.getByRole("status").filter({ hasText: "保存しました" })).toBeVisible();
    await expect(field).toHaveValue("");
    await expect(page).toHaveURL(/\/quick\?window=1$/);

    // No window opened this one, so the note opens here.
    await page.getByRole("button", { name: "エディタで開く" }).click();
    await expect(page).toHaveURL(/\/app\?n=/);
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("窓から保存");
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
    const field = popup.getByLabel("即席メモ");
    await field.fill("閉じる前の下書き");
    const closed = popup.waitForEvent("close");
    await field.press("Escape");
    await closed;

    const again = context.waitForEvent("page");
    await page.evaluate(
      (features) => window.open("/quick?window=1", "memoca-quick", features),
      WINDOW,
    );
    await expect((await again).getByLabel("即席メモ")).toHaveValue("閉じる前の下書き");
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
