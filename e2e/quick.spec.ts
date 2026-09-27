import { expect, type Page, test } from "@playwright/test";
import { editor, signUp } from "./helpers";
import { onScreen } from "./image-helpers";
import { readTable } from "./local-db";

/** Whether this device holds a draft of the quick note. */
const hasDraft = async (page: Page) =>
  (await readTable<{ key: string }>(page, "meta")).some((row) => row.key === "quickDraft");

test.describe("the quick note", () => {
  test("a short first line becomes the title, and only the rest the body", async ({ page }) => {
    await signUp(page);
    await page.goto("/quick");
    await page.getByLabel("即席メモ").fill("買い物\n\n牛乳\n卵");
    await page.getByRole("button", { name: "保存" }).click();

    await expect(page).toHaveURL(/\/app\?n=/);
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("買い物");
    // A paragraph a line, as the editor makes them, and the title not again.
    const paragraphs = editor(page).locator('[data-content-type="paragraph"]');
    await expect(paragraphs.nth(0)).toHaveText("牛乳");
    await expect(paragraphs.nth(1)).toHaveText("卵");
    await expect(editor(page)).not.toContainText("買い物");
  });

  test("a long single line stays whole in the body, where all of it can be read", async ({
    page,
  }) => {
    const thought = "明日の打ち合わせで山田さんに見積もりの件を確認する、あと資料も持っていくこと";
    await signUp(page);
    await page.goto("/quick");
    await page.getByLabel("即席メモ").fill(thought);
    await page.getByRole("button", { name: "保存" }).click();

    await expect(page).toHaveURL(/\/app\?n=/);
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("");
    await expect(editor(page).locator('[data-content-type="paragraph"]').first()).toHaveText(
      thought,
    );
  });

  test("what is being written is kept as a draft until it is saved", async ({ page }) => {
    await signUp(page);
    await page.goto("/quick");
    await page.getByLabel("即席メモ").fill("書きかけの考え");
    // Away and back, as when another app is opened in between.
    await page.getByRole("button", { name: "戻る" }).click();
    await expect(page).toHaveURL(/\/app$/);
    await page.goto("/quick");
    await expect(page.getByLabel("即席メモ")).toHaveValue("書きかけの考え");

    await page.getByRole("button", { name: "保存" }).click();
    await expect(page).toHaveURL(/\/app\?n=/);
    await expect.poll(() => hasDraft(page)).toBe(false);
    await page.goto("/quick");
    await expect(page.getByLabel("即席メモ")).toHaveValue("");
  });

  test("however much is written, and wherever a keyboard leaves the page, the save button stays in sight", async ({
    page,
  }) => {
    // The browser's visual viewport, to be moved as a phone's keyboard moves it.
    await page.addInitScript(() => {
      const viewport = Object.assign(new EventTarget(), { height: 0, offsetTop: 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
      (window as unknown as { seen: typeof viewport }).seen = viewport;
    });
    const move = (height: number, offsetTop: number) =>
      page.evaluate(
        ([height, offsetTop]) => {
          const viewport = (window as unknown as { seen: EventTarget & object }).seen;
          Object.assign(viewport, { height, offsetTop });
          viewport.dispatchEvent(new Event("resize"));
          viewport.dispatchEvent(new Event("scroll"));
        },
        [height, offsetTop],
      );
    const { height } = page.viewportSize()!;

    await signUp(page);
    await page.goto("/quick");
    await move(height, 0);
    await page
      .getByLabel("即席メモ")
      .fill(Array.from({ length: 60 }, (_, line) => `${line + 1} 行目`).join("\n"));
    const save = page.getByRole("button", { name: "保存" });
    expect(onScreen(page, (await save.boundingBox())!)).toBe(true);
    // What is written scrolls inside the field; the page itself does not.
    expect(
      await page.evaluate(() => document.scrollingElement!.scrollHeight <= window.innerHeight),
    ).toBe(true);

    // A keyboard takes the lower half, and iOS pans down to the caret: the
    // page follows what can be seen, its header at the top of it.
    const seen = { top: Math.round(height / 3), height: Math.round(height / 2) };
    await move(seen.height, seen.top);
    const main = (await page.locator("main").boundingBox())!;
    expect(Math.abs(main.y - seen.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(main.height - seen.height)).toBeLessThanOrEqual(1);
    const button = (await save.boundingBox())!;
    expect(button.y).toBeGreaterThanOrEqual(seen.top);
    expect(button.y + button.height).toBeLessThanOrEqual(seen.top + seen.height);

    // The caret going down a line: iOS pans on, the keyboard as it was.
    await move(seen.height, seen.top + 40);
    expect(
      Math.abs((await page.locator("main").boundingBox())!.y - (seen.top + 40)),
    ).toBeLessThanOrEqual(1);
    // What is written stays inside what is seen, and the page itself never scrolls.
    const field = (await page.getByLabel("即席メモ").boundingBox())!;
    expect(field.y + field.height).toBeLessThanOrEqual(seen.top + 40 + seen.height + 1);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test("what a share sheet sends arrives once: the title on its line, the link below", async ({
    page,
  }) => {
    await signUp(page);
    const link = "https://example.com/a";
    const query = new URLSearchParams({ title: "記事", text: `記事 ${link}`, url: link });
    await page.goto(`/quick?${query}`);
    await expect(page.getByLabel("即席メモ")).toHaveValue(`記事\n${link}`);

    await page.getByRole("button", { name: "保存" }).click();
    await expect(page).toHaveURL(/\/app\?n=/);
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("記事");
    await expect(editor(page).locator('[data-content-type="paragraph"]').first()).toHaveText(link);
  });
});
