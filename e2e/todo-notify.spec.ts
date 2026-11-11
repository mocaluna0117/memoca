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

  test("in the desktop app, the account's reminders are handed to it, and one clicked opens the Todo", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the desktop app's window, with a pointer over the items");
    test.slow();
    await signUp(page);
    // The app's window, as its shell makes it (0.4.10 on): its reminders a
    // stand-in that keeps what it is handed, and this computer's choice
    // across loads, as the app's settings do.
    await page.addInitScript(() => {
      const KEY = "e2e:shell-reminders";
      const shown = window as unknown as { __handed: { title: string }[][] };
      shown.__handed = [];
      Object.defineProperty(window, "memocaShell", {
        value: {
          platform: "macos",
          hide() {},
          openExternal() {},
          reminders: {
            state: async () => localStorage.getItem(KEY) ?? "off",
            turnOn: async () => {
              localStorage.setItem(KEY, "on");
              return "on";
            },
            turnOff: async () => localStorage.setItem(KEY, "off"),
            set: (list: { title: string }[]) => shown.__handed.push(list),
          },
        },
      });
    });
    await page.goto("/quick?window=1");
    await openTodo(page);
    await todo(page).click();
    await page.keyboard.type("書類を提出");
    await todo(page).locator(".bn-inline-content", { hasText: /^書類を提出$/ }).hover();
    await dueButton(page, "書類を提出").click();
    const picker = page.getByRole("dialog", { name: "期日" });
    await picker.getByRole("button", { name: "明日" }).click();
    await picker.getByRole("button", { name: "完了" }).click();
    await expect(picker).toBeHidden();

    const bell = await openBell(page);
    await expect(bell.getByText("このパソコンで通知を受け取る")).toBeVisible();
    await bell.getByRole("switch").click();
    await expect(bell.getByRole("switch")).toBeChecked();
    await page.keyboard.press("Escape");

    // Sent by this device, kept by the server, and handed to the app as the server has them.
    const handed = () =>
      page.evaluate(() => {
        const last = (window as unknown as { __handed: { title: string }[][] }).__handed.at(-1);
        return last ? [...new Set(last.map((each) => each.title))] : null;
      });
    await expect.poll(handed, { timeout: 30_000 }).toEqual(["書類を提出"]);

    // Opened again: this computer's choice kept, and the list handed over again, the Todo not open.
    // (The bell's tip, out as it has the focus back, put away first.)
    await todo(page).click();
    await page.getByRole("button", { name: "新しいタブ" }).click();
    await expect(page.getByRole("tab", { name: "Todo" })).toHaveAttribute("aria-selected", "false");
    await page.reload();
    await expect.poll(handed, { timeout: 30_000 }).toEqual(["書類を提出"]);

    // One clicked: the app tells the page, and the Todo is shown.
    await page.evaluate(() => window.dispatchEvent(new Event("memoca-shell-open-todo")));
    await expect(page.getByRole("tab", { name: "Todo" })).toHaveAttribute("aria-selected", "true");
    await expect(todo(page)).toBeVisible();
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
