import { expect, type Page, test } from "@playwright/test";
import { quickField, quickText, signIn, signUp, waitForSynced, writeQuick } from "./helpers";
import { patchRow, readTable } from "./local-db";

/** The quick note's tabs, by their names, as the strip shows them. */
const tabNames = (page: Page) =>
  page.getByRole("tab").evaluateAll((tabs) => tabs.map((tab) => tab.textContent?.trim() ?? ""));

/** The account's key on this device, as its tabs are kept under it. */
async function userKey(page: Page): Promise<string> {
  await expect.poll(async () => (await readTable<{ key: string }>(page, "meta")).some((row) => row.key.startsWith("quickTabs:"))).toBe(true);
  const row = (await readTable<{ key: string }>(page, "meta")).find((each) => each.key.startsWith("quickTabs:"))!;
  return row.key.slice("quickTabs:".length);
}

test.describe("the quick note, the same on every device of the account", () => {
  test("what is written in a tab on one is there on the other, as it is written; closed on one, it goes from both", async ({
    page,
    context,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "two devices, typed on a computer's keyboard");
    test.slow();
    const email = await signUp(page);
    await page.goto("/quick?window=1");
    await writeQuick(quickField(page), "端末 A で書いた");
    await waitForSynced(page).catch(() => undefined);

    const fresh = await context.browser()!.newContext({
      baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
      viewport: page.viewportSize(),
    });
    const other = await fresh.newPage();
    await signIn(other, email);
    await other.goto("/quick?window=1");
    // The other's tab among this one's.
    await expect.poll(() => tabNames(other), { timeout: 30_000 }).toContain("端末 A で書いた");
    await other.getByRole("tab", { name: "端末 A で書いた" }).click();
    await expect.poll(() => quickText(quickField(other))).toBe("端末 A で書いた");

    // Written on there, as it is written: here too, in the tab shown.
    await quickField(other).locator(".bn-inline-content", { hasText: /^端末 A で書いた$/ }).click();
    // To the line's end (a Mac's End scrolls the page instead).
    await other.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
    await other.keyboard.press("Enter");
    await other.keyboard.insertText("端末 B で足した");
    await expect
      .poll(() => quickText(quickField(page)), { timeout: 30_000 })
      .toBe("端末 A で書いた\n端末 B で足した");

    // Closed here (another tab open, as the last one is not closed): gone there.
    await page.getByRole("button", { name: "新しいタブ" }).click();
    await page.getByRole("button", { name: "端末 A で書いた のタブを閉じる" }).click();
    await page.getByRole("button", { name: "保存せずに閉じる" }).click();
    await expect.poll(() => tabNames(page)).not.toContain("端末 A で書いた");
    await expect.poll(() => tabNames(other), { timeout: 30_000 }).not.toContain("端末 A で書いた");
    await fresh.close();
  });

  test("a draft this device kept of its own, from before, is a tab of the account's once it opens", async ({
    page,
  }) => {
    await signUp(page);
    await page.goto("/quick?window=1");
    const key = await userKey(page);
    // A draft as a version before kept it: on this device alone, its text only.
    await patchRow(page, "meta", "quickDraft:01a1c000-0000-7000-8000-000000000001", {
      key: "quickDraft:01a1c000-0000-7000-8000-000000000001",
      value: { text: "前から書いていた下書き", updatedAt: Date.now(), userKey: key },
    });
    await patchRow(page, "meta", `quickTabs:${key}`, {
      key: `quickTabs:${key}`,
      value: {
        userKey: key,
        ids: ["01a1c000-0000-7000-8000-000000000001"],
        active: "01a1c000-0000-7000-8000-000000000001",
      },
    });
    await page.reload();
    await expect.poll(() => quickText(quickField(page))).toBe("前から書いていた下書き");
    // Its note the account's now, and the device's own draft gone.
    await expect
      .poll(async () =>
        (await readTable<{ noteId: string }>(page, "notes")).some(
          (note) => note.noteId === "quick-tab-01a1c000-0000-7000-8000-000000000001",
        ),
      )
      .toBe(true);
    expect(
      (await readTable<{ key: string }>(page, "meta")).some((row) => row.key.startsWith("quickDraft:")),
    ).toBe(false);
  });
});
