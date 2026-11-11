import { type Page, expect, test } from "@playwright/test";
import {
  editor,
  folderPanel,
  openApp,
  quickField,
  setExplorerMode,
  signIn,
  signUp,
  waitForSynced,
  writeQuick,
} from "./helpers";
import { readTable } from "./local-db";

/**
 * The hands-on welcome (components/onboarding/guide) and 使い方, as someone
 * new meets them. The other tests turn the welcome off on their device
 * (helpers.ts noWelcome); these let it be.
 */

const welcomeOn = (page: Page) => page.evaluate(() => localStorage.removeItem("memoca:welcome-off"));
const card = (page: Page) => page.getByRole("region", { name: "はじめの案内" });

test("an account just made: done by hand, the quick note to the note's lines, once on every device", async ({
  page,
  context,
}, testInfo) => {
  test.slow();
  const phone = testInfo.project.name === "mobile";
  const email = await signUp(page);
  await welcomeOn(page);
  // The app's own default, as someone new has it.
  await setExplorerMode(page);
  await page.goto("/app");

  await expect(card(page)).toContainText("Memoca へようこそ", { timeout: 25_000 });
  await card(page).getByRole("button", { name: "やってみる" }).click();
  await expect(card(page)).toContainText("「即席メモ」を押してみましょう");

  // The quick note: on a phone in this tab, on a computer a window of its own.
  let quick = page;
  if (phone) {
    await page.locator('[data-mobile-nav] [data-guide="open-quick"]').click();
    await expect(page).toHaveURL(/\/quick/);
  } else {
    const opened = context.waitForEvent("page");
    await (await folderPanel(page)).getByRole("button", { name: "即席メモ" }).click();
    quick = await opened;
    // Meanwhile the notes' window says where the guide goes on.
    await expect(card(page)).toContainText("即席メモで何か書いて");
  }
  await expect(card(quick)).toContainText("「保存」を押してみましょう", { timeout: 15_000 });
  await expect(card(quick)).toContainText("できました");
  await writeQuick(quickField(quick), "はじめてのメモ");
  await quick.getByRole("button", { name: "保存", exact: true }).click();
  if (!phone) {
    await expect(card(quick)).toContainText("「メモを開く」で");
    await quick.getByRole("button", { name: "メモを開く" }).click();
    await expect(card(quick)).toContainText("続きは、Memoca のメモの画面です");
  }

  // The note saved, open: its lines.
  await expect(page.getByLabel("メモのタイトル")).toBeVisible({ timeout: 15_000 });
  await expect(card(page)).toContainText("「- 」（ハイフンと空白）");
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- 買うもの");
  await expect(card(page)).toContainText("「/」（スラッシュ）を打ってみましょう");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await expect(card(page)).toContainText("これで基本はおしまいです");
  await page.keyboard.press("Escape");
  await card(page).getByRole("button", { name: "閉じる" }).click();
  await expect(card(page)).toHaveCount(0);

  // Not again here.
  await waitForSynced(page);
  await page.goto("/app");
  await waitForSynced(page);
  await expect(card(page)).toHaveCount(0);

  // Nor on another device of the account (the server heard of it), which
  // makes no second note to try things in.
  const fresh = await context.browser()!.newContext({
    viewport: page.viewportSize() ?? undefined,
    isMobile: phone,
    hasTouch: phone,
  });
  const other = await fresh.newPage();
  await signIn(other, email);
  await welcomeOn(other);
  await other.goto("/app");
  await waitForSynced(other);
  await expect(card(other)).toHaveCount(0);
  const practice = (await readTable<{ title: string }>(other, "notes")).filter(
    (note) => note.title === "はじめに読むメモ",
  );
  expect(practice).toHaveLength(1);
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

  // And the guide again, from the settings: from its start.
  await page.goto("/app/settings");
  await page.getByRole("button", { name: "はじめの案内をもう一度見る" }).click();
  await expect(card(page)).toContainText("Memoca へようこそ");
  await card(page).getByRole("button", { name: "あとで" }).click();
  await expect(card(page)).toHaveCount(0);
});

test("an account from before the guide: offered it once, with no note made for it", async ({ page }) => {
  await signUp(page);
  // Its first days, before there was a guide.
  await openApp(page);
  await waitForSynced(page);

  await welcomeOn(page);
  await page.reload();
  await expect(card(page)).toContainText("Memoca へようこそ", { timeout: 25_000 });
  await card(page).getByRole("button", { name: "あとで" }).click();
  await expect(card(page)).toHaveCount(0);
  expect(
    (await readTable<{ title: string }>(page, "notes")).filter((note) => note.title === "はじめに読むメモ"),
  ).toHaveLength(0);

  await page.reload();
  await waitForSynced(page);
  await expect(card(page)).toHaveCount(0);
});

test("the desktop app's: its hotkey, its two windows, and Memoca's own hotkey set", async ({
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the desktop app, on a computer");
  test.slow();
  // Both of the app's windows, as it makes them: what each asked of it said,
  // its hotkeys a stand-in that keeps what it is given.
  await context.addInitScript(() => {
    const asked = window as unknown as { __asked: string[] };
    asked.__asked = [];
    let kept = {
      quick: "CmdOrCtrl+Shift+M",
      app: "CmdOrCtrl+Shift+M",
      quickDefault: "CmdOrCtrl+Shift+M",
      appDefault: "CmdOrCtrl+Shift+M",
    };
    Object.defineProperty(window, "memocaShell", {
      value: {
        platform: "macos",
        hide() {},
        openExternal() {},
        showQuick: () => asked.__asked.push("showQuick"),
        showApp: () => asked.__asked.push("showApp"),
        openApp: () => asked.__asked.push("openApp"),
        hotkeys: {
          get: async () => kept,
          set: async (which: "quick" | "app", keys: string) => {
            kept = { ...kept, [which]: keys };
            return kept;
          },
          recording: async () => undefined,
        },
      },
    });
  });
  const app = await context.newPage();
  await signUp(app);
  await welcomeOn(app);
  const asked = (page: Page) => page.evaluate(() => (window as unknown as { __asked: string[] }).__asked);

  // Not of itself (yet): from the settings.
  await app.goto("/app/settings");
  await expect(app.getByRole("heading", { name: "デスクトップ版のホットキー" })).toBeVisible({ timeout: 25_000 });
  await expect(card(app)).toHaveCount(0);
  await app.getByRole("button", { name: "はじめの案内をもう一度見る" }).click();
  await expect(card(app)).toContainText("デスクトップ版の即席メモの使い方");
  await card(app).getByRole("button", { name: "やってみる" }).click();
  expect(await asked(app)).toContain("showQuick");
  await expect(card(app)).toContainText("続きは即席メモの窓です");

  // The quick note's window.
  const quick = await context.newPage();
  await quick.goto("/quick?window=1");
  await expect(card(quick)).toContainText("ここが即席メモです", { timeout: 25_000 });
  await writeQuick(quickField(quick), "思いついたこと");
  await expect(card(quick)).toContainText("⇧⌘M を押すと、この窓が隠れます");
  // Put away by the hotkey, and out again.
  await quick.evaluate(() => {
    window.dispatchEvent(new Event("memoca-shell-hidden"));
    window.dispatchEvent(new Event("focus"));
  });
  await expect(card(quick)).toContainText("隠しても残っています");
  await quick.getByRole("button", { name: "保存", exact: true }).click();
  await expect(card(quick)).toContainText("Memoca 全体の窓が開きます");
  await quick.getByRole("button", { name: "Memoca を開く" }).click();
  await expect.poll(() => asked(quick)).toContain("showApp");
  await expect(card(quick)).toContainText("続きは Memoca 全体の窓です");

  // Memoca's own window: on to its hotkey, in the settings.
  await app.bringToFront();
  await expect(card(app)).toContainText("これが Memoca 全体の窓です");
  await card(app).getByRole("button", { name: "設定を開く" }).click();
  await expect(card(app)).toContainText("「変更」を押して");
  const row = app.locator('[data-guide="hotkey-app"]');
  await row.getByRole("button", { name: "変更" }).click();
  await app.keyboard.press("Meta+Shift+KeyK");
  await expect(card(app)).toContainText("これで基本はおしまいです");
  await expect(card(app)).toContainText("⇧⌘K で全体の窓");
  await card(app).getByRole("button", { name: "閉じる" }).click();
  await expect(card(app)).toHaveCount(0);
  await expect(card(quick)).toHaveCount(0);
  expect(await app.evaluate(() => localStorage.getItem("memoca:desktop-guide-done"))).toBe("1");
});
