import { type Page, expect, test } from "@playwright/test";
import { editor, folderPanel, openApp, setExplorerMode, signIn, signUp, waitForSynced } from "./helpers";

/**
 * The welcome (components/onboarding/welcome-tour) and 使い方, as someone new
 * meets them. The other tests turn the welcome off on their device
 * (helpers.ts noWelcome); these let it be.
 */

const welcomeOn = (page: Page) => page.evaluate(() => localStorage.removeItem("memoca:welcome-off"));
const welcome = (page: Page) => page.getByRole("dialog", { name: "Memoca へようこそ" });

async function toLastCard(page: Page) {
  for (let card = 0; card < 3; card++) await page.getByRole("button", { name: "つぎへ" }).click();
  await expect(page.getByRole("dialog", { name: "どの端末でも、同じメモ" })).toBeVisible();
}

test("an account just made: the welcome, its note to try things in, once on every device", async ({
  page,
  context,
}) => {
  test.slow();
  const email = await signUp(page);
  await welcomeOn(page);
  // The app's own default, as someone new has it.
  await setExplorerMode(page);
  await page.goto("/app");

  await expect(welcome(page)).toBeVisible({ timeout: 25_000 });
  // The note, made as the account's sync starts, is said once it is there.
  await expect(welcome(page)).toContainText("練習用のメモ「はじめに読むメモ」を用意しました", {
    timeout: 15_000,
  });
  await toLastCard(page);
  await page.getByRole("button", { name: "練習用のメモを開く" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("メモのタイトル")).toHaveValue("はじめに読むメモ");
  await expect(editor(page)).toContainText("やってみよう");
  await expect(editor(page)).toContainText("「- 」（ハイフンと空白）");

  // Not again here.
  await waitForSynced(page);
  await page.reload();
  await waitForSynced(page);
  await expect(welcome(page)).toHaveCount(0);

  // Nor on another device of the account (the server heard of it), which
  // makes no second note to try things in.
  const fresh = await context.browser()!.newContext({
    viewport: page.viewportSize() ?? undefined,
    isMobile: (page.viewportSize()?.width ?? 1280) < 768,
    hasTouch: (page.viewportSize()?.width ?? 1280) < 768,
  });
  const other = await fresh.newPage();
  await signIn(other, email);
  await welcomeOn(other);
  await other.goto("/app");
  await waitForSynced(other);
  await expect(welcome(other)).toHaveCount(0);
  await fresh.close();

  // 使い方, from the sidebar's row of pages.
  await (await folderPanel(page)).getByRole("link", { name: "使い方" }).click();
  // The page's own heading (a phone's bar above says it too).
  await expect(page.getByRole("heading", { level: 1, name: "使い方" }).last()).toBeVisible();
  const contents = page.getByRole("navigation", { name: "目次" });
  await expect(contents.getByRole("link")).toHaveCount(13);
  await contents.getByRole("link", { name: "かんたんな書き方" }).click();
  await expect(page).toHaveURL(/#notation$/);
  await expect(page.getByRole("heading", { name: "かんたんな書き方" })).toBeInViewport();

  // And the welcome again, from the settings.
  await page.goto("/app/settings");
  await page.getByRole("button", { name: "はじめの案内をもう一度見る" }).click();
  await expect(welcome(page)).toBeVisible();
  await page.getByRole("button", { name: "とばす" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("an account from before the welcome: shown it once, with no note made for it", async ({ page }) => {
  await signUp(page);
  // Its first days, before there was a welcome.
  await openApp(page);
  await waitForSynced(page);

  await welcomeOn(page);
  await page.reload();
  await expect(welcome(page)).toBeVisible({ timeout: 25_000 });
  await expect(welcome(page)).not.toContainText("練習用のメモ");
  await toLastCard(page);
  await expect(page.getByRole("button", { name: "練習用のメモを開く" })).toHaveCount(0);
  await page.getByRole("button", { name: "はじめる" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.reload();
  await waitForSynced(page);
  await expect(welcome(page)).toHaveCount(0);
});
