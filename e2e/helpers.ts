import { type Locator, type Page, expect } from "@playwright/test";

const PASSWORD = "memoca-e2e-password";
/** Longest client-side debounce (title 400ms, editor flush 500ms) plus margin. */
const DEBOUNCE_MS = 1_500;

/**
 * Each test gets its own account, so one test's notes can never make another
 * test pass or fail. Sign-up goes through the auth API because the only button
 * in the interface is Google, which cannot run unattended.
 *
 * Requires the Convex deployment to have ALLOW_PASSWORD_AUTH=true, which is
 * never set in production.
 */
export async function signUp(page: Page): Promise<string> {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@memoca.test`;
  await page.goto("/");
  const status = await page.evaluate(
    async ([address, password]) => {
      const res = await fetch("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: address, password, name: "E2E" }),
      });
      return res.status;
    },
    [email, PASSWORD],
  );
  expect(status, "sign-up should succeed").toBeLessThan(400);
  return email;
}

export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/");
  await page.evaluate(
    async ([address, password]) => {
      await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: address, password }),
      });
    },
    [email, PASSWORD],
  );
}

export async function openApp(page: Page): Promise<void> {
  await page.goto("/app");
  // A heading, not the sidebar entry of the same name: the sidebar is in the
  // DOM but hidden on a phone, and would match first.
  await expect(
    page.getByRole("heading", { name: "すべてのメモ" }).first(),
  ).toBeVisible({ timeout: 20_000 });
}

const isNarrow = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;

/**
 * The folder panel, scoped so queries cannot match the copy that is off screen.
 *
 * The sidebar is rendered twice: always-on for wide screens and inside a drawer
 * for phones. Both are in the DOM, so an unscoped lookup finds the hidden one
 * first and then waits forever for it to appear.
 */
export async function folderPanel(page: Page): Promise<Locator> {
  if (!isNarrow(page)) return page.locator("aside");

  // Match on the open state, not on visibility: Radix keeps the drawer mounted
  // while it animates out, so a plain visibility check can hand back an element
  // that is about to be removed.
  const open = page.locator('[role="dialog"][data-state="open"]');
  if ((await open.count()) === 0) {
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await showList(page);
    await page.getByRole("button", { name: "メニューを開く" }).first().click();
    await expect(open).toBeVisible();
    await settle(open);
  }
  return open;
}

/** Waits for every running animation inside an element to finish. */
async function settle(locator: Locator): Promise<void> {
  await locator.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

/** Closes the folder drawer if it is open. */
export async function hideFolders(page: Page): Promise<void> {
  if (!isNarrow(page)) return;
  const drawer = page.locator('[role="dialog"]');
  if ((await drawer.count()) > 0) {
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
  }
}

/** Leaves the editor so the note list is on screen again. */
export async function showList(page: Page): Promise<void> {
  if (!isNarrow(page)) return;
  const back = page.getByRole("button", { name: "戻る" });
  if (await back.isVisible().catch(() => false)) await back.click();
}

export function editor(page: Page) {
  return page.locator('[contenteditable="true"]').first();
}

/**
 * Waits until nothing is left to send.
 *
 * Local writes are debounced, so the indicator can briefly read "synced"
 * before the edit has even been queued. Requiring it to hold steady avoids
 * asserting on that gap.
 */
export async function waitForSynced(page: Page): Promise<void> {
  const badge = page
    .getByRole("status", { name: "同期済み" })
    .filter({ visible: true })
    .first();
  await page.waitForTimeout(DEBOUNCE_MS);
  await expect(badge).toBeVisible({ timeout: 25_000 });
  await page.waitForTimeout(800);
  await expect(badge).toBeVisible();
}

export async function createNote(page: Page, title: string, body?: string): Promise<void> {
  await showList(page);
  await page.getByRole("button", { name: "新しいメモ" }).first().click();
  const titleField = page.getByLabel("メモのタイトル");
  await expect(titleField).toBeVisible();
  await titleField.fill(title);
  if (body) {
    await editor(page).click();
    await page.keyboard.type(body);
  }
  // Give the debounced title write and the editor flush time to land locally.
  await page.waitForTimeout(DEBOUNCE_MS);
}
