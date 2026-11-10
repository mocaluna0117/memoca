import { expect, type Page, test } from "@playwright/test";
import { signIn, signUp } from "./helpers";

/** The Todo's editor. */
const todo = (page: Page) => page.getByLabel("Todo", { exact: true });

async function openTodo(page: Page) {
  await page.getByRole("button", { name: "Todo を開く" }).click();
  await expect(todo(page)).toBeVisible();
}

/** The item of this text's due button: its due, or its calendar. */
const dueButton = (page: Page, text: string) =>
  todo(page)
    .locator(":scope > .bn-block-group > .bn-block-outer", {
      has: page.locator(".bn-inline-content", { hasText: new RegExp(`^${text}$`) }),
    })
    .locator(":scope > .bn-block > .todo-due");

/** The bell's popover, opened. */
async function openBell(page: Page) {
  await page.getByRole("button", { name: "期日の通知" }).click();
  const bell = page.getByRole("dialog", { name: "期日の通知" });
  await expect(bell).toBeVisible();
  return bell;
}

test.describe("the Todo's reminders", () => {
  test("the times chosen on one device, and an item's own, are the other's too", async ({ page, context }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "two devices, with a pointer over the items");
    test.slow();
    const email = await signUp(page);
    await page.goto("/quick?window=1");
    await openTodo(page);
    await todo(page).click();
    await page.keyboard.type("書類を提出");

    // Its due, and none of its reminders.
    await todo(page).locator(".bn-inline-content", { hasText: /^書類を提出$/ }).hover();
    await dueButton(page, "書類を提出").click();
    const picker = page.getByRole("dialog", { name: "期日" });
    await picker.getByRole("button", { name: "明日" }).click();
    const row = picker.getByRole("group", { name: "通知" });
    await expect(row.getByRole("button", { name: "いつもどおり" })).toHaveAttribute("aria-pressed", "true");
    await row.getByRole("button", { name: "通知しない" }).click();
    await picker.getByRole("button", { name: "完了" }).click();
    await expect(picker).toBeHidden();

    // The account's: not the evening before.
    const bell = await openBell(page);
    await bell.getByRole("checkbox", { name: /前日の夜 21:00/ }).uncheck();
    await expect(bell.getByRole("checkbox", { name: /当日の朝 9:00/ })).toBeChecked();
    await page.keyboard.press("Escape");

    const fresh = await context.browser()!.newContext({
      baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
      viewport: page.viewportSize(),
    });
    const other = await fresh.newPage();
    await signIn(other, email);
    await other.goto("/quick?window=1");
    await openTodo(other);
    await expect(todo(other).locator(".bn-inline-content", { hasText: /^書類を提出$/ })).toBeVisible({ timeout: 30_000 });
    const otherBell = await openBell(other);
    await expect(otherBell.getByRole("checkbox", { name: /前日の夜 21:00/ })).not.toBeChecked({ timeout: 30_000 });
    await expect(otherBell.getByRole("checkbox", { name: /当日の朝 9:00/ })).toBeChecked();
    await other.keyboard.press("Escape");

    await dueButton(other, "書類を提出").click();
    const otherPicker = other.getByRole("dialog", { name: "期日" });
    await expect(otherPicker.getByRole("group", { name: "通知" }).getByRole("button", { name: "通知しない" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Times of its own, from the account's: a day alone has no hour before.
    await otherPicker.getByRole("button", { name: "時刻を選ぶ" }).click();
    await expect(otherPicker.getByRole("button", { name: "当日 9:00" })).toHaveAttribute("aria-pressed", "true");
    await expect(otherPicker.getByRole("button", { name: "前日 21:00" })).toHaveAttribute("aria-pressed", "false");
    await expect(otherPicker.getByRole("button", { name: "1 時間前" })).toBeDisabled();
    await fresh.close();
  });

  test("a reminder touched opens the Todo", async ({ page }, testInfo) => {
    await signUp(page);
    await page.goto(testInfo.project.name === "desktop" ? "/quick?window=1&todo=1" : "/quick?todo=1");
    await expect(page.getByRole("tab", { name: "Todo" })).toHaveAttribute("aria-selected", "true");
    await expect(todo(page)).toBeVisible();
    // Read once: not in the address, to open it again on a reload.
    await expect.poll(() => new URL(page.url()).searchParams.has("todo")).toBe(false);
  });

  test("the bell says why a device cannot have them, and the times can still be chosen", async ({ page }) => {
    await signUp(page);
    await page.goto("/quick?window=1");
    await openTodo(page);
    const bell = await openBell(page);
    // Headless, with no push service: a reason, not a switch that fails.
    await expect(bell.getByRole("checkbox", { name: /期日の時刻ちょうど/ })).toBeChecked();
    await bell.getByRole("checkbox", { name: /期日の時刻ちょうど/ }).uncheck();
    await expect(bell.getByRole("checkbox", { name: /期日の時刻ちょうど/ })).not.toBeChecked();
  });
});
