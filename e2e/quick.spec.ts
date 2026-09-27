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

  test("however much is written, the header stays at the top as the page scrolls", async ({
    page,
  }) => {
    await signUp(page);
    await page.goto("/quick");
    await page
      .getByLabel("即席メモ")
      .fill(Array.from({ length: 60 }, (_, line) => `${line + 1} 行目`).join("\n"));
    // A page grows with what is written, and scrolls as a whole, to its end...
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement!.scrollHeight));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    // ...with the header, and its save button, still in view.
    const save = page.getByRole("button", { name: "保存" });
    expect(onScreen(page, (await save.boundingBox())!)).toBe(true);
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
