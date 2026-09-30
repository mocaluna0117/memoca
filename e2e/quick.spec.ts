import { expect, type Page, test } from "@playwright/test";
import { editor, openApp, showList, signUp, waitForSynced } from "./helpers";
import { onScreen } from "./image-helpers";
import { readTable } from "./local-db";
import { createVaultInSettings, enterVaultPassword } from "./vault-helpers";

/** Whether this device holds a draft of the quick note. */
const hasDraft = async (page: Page) =>
  (await readTable<{ key: string }>(page, "meta")).some((row) => row.key === "quickDraft");

test.describe("the quick note", () => {
  test("all of it goes in the body, and its first line stands in for a title where notes are listed", async ({
    page,
  }, testInfo) => {
    await signUp(page);
    await page.goto("/quick");
    await page.getByLabel("即席メモ").fill("買い物\n\n牛乳\n卵");
    await page.getByRole("button", { name: "保存" }).click();

    await expect(page).toHaveURL(/\/app\?n=/);
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("");
    // A paragraph a line, as the editor makes them: the first line too.
    const paragraphs = editor(page).locator('[data-content-type="paragraph"]');
    await expect(paragraphs.nth(0)).toHaveText("買い物");
    await expect(paragraphs.nth(2)).toHaveText("牛乳");
    await expect(paragraphs.nth(3)).toHaveText("卵");

    // Listed by its first line, not as 無題のメモ, and not said twice in the row.
    await showList(page);
    const row = page.locator("[data-note-row]").filter({ hasText: "買い物" });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).not.toContainText("無題のメモ");
    expect((await row.textContent())!.split("買い物")).toHaveLength(2);
    // And so found by ⌘K, where there is a keyboard to open it with.
    if (testInfo.project.name === "desktop") {
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByPlaceholder("メモを検索、または操作を入力").fill("牛乳");
      await expect(page.getByRole("option", { name: /買い物/ })).toBeVisible();
    }
  });

  test("a long first line is set apart, cut short in the list, offered when renaming, and names it in the trash", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "renaming in the list is by the keyboard");
    const thought =
      "明日の打ち合わせで山田さんに見積もりの件を確認する、あと資料も持っていくこと、会議室の予約も忘れずに済ませておく";
    const standIn = thought.slice(0, 60);
    await signUp(page);
    await page.goto("/quick");
    await page.getByLabel("即席メモ").fill(thought);
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page).toHaveURL(/\/app\?n=/);
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("");
    await expect(editor(page).locator('[data-content-type="paragraph"]').first()).toHaveText(
      thought,
    );

    // In the list: lighter than a title given, and cut short with … rather
    // than widening the list.
    const row = page.locator("[data-note-row]").filter({ hasText: standIn.slice(0, 10) });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByText(standIn, { exact: true })).toHaveClass(/text-foreground\/70/);
    const viewport = page.locator('[data-scroll="list"] [data-slot="scroll-area-viewport"]');
    expect(await viewport.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );

    // Renamed: the field is empty, with the first line as its hint.
    await row.focus();
    await page.keyboard.press("Enter");
    const field = page.getByRole("textbox", { name: "メモ名" });
    await expect(field).toHaveValue("");
    await expect(field).toHaveAttribute("placeholder", standIn);
    await page.keyboard.press("Escape");

    // In the trash, named by it too, and set apart.
    await page.getByRole("button", { name: "メモの操作" }).click();
    await page.getByRole("menuitem", { name: "削除" }).click();
    await page.goto("/app/trash");
    await expect(page.getByText(standIn, { exact: true })).toHaveClass(/text-foreground\/70/, {
      timeout: 20_000,
    });
  });

  test("locked, it keeps its first line as its title, sealed, so the list still tells it apart", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "one run is enough: the lock is the same on a phone",
    );
    test.slow();
    await signUp(page);
    await openApp(page);
    await createVaultInSettings(page);
    await page.goto("/quick");
    await page.getByLabel("即席メモ").fill("秘密の買い物\n牛乳");
    await page.getByRole("button", { name: "保存" }).click();
    await expect(page).toHaveURL(/\/app\?n=/);
    await waitForSynced(page);

    await page.getByRole("button", { name: "メモの操作" }).click();
    await page.getByRole("menuitem", { name: "ロックする", exact: true }).click();
    await enterVaultPassword(page, "ロックする");
    await expect(page.getByText("メモをロックしました")).toBeVisible({ timeout: 30_000 });

    // Its title now, as the note shows it, and as the list does: not a stand-in.
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("秘密の買い物", {
      timeout: 20_000,
    });
    const row = page.locator("[data-note-row]").filter({ hasText: "秘密の買い物" });
    await expect(row).toBeVisible();
    await expect(row).not.toContainText("無題のメモ");
    await expect(row.getByText("秘密の買い物", { exact: true })).toHaveClass(/font-medium/);
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
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("");
    const paragraphs = editor(page).locator('[data-content-type="paragraph"]');
    await expect(paragraphs.nth(0)).toHaveText("記事");
    await expect(paragraphs.nth(1)).toHaveText(link);
  });
});
