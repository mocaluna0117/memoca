import { expect, test } from "@playwright/test";
import { editor, signUp } from "./helpers";

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
