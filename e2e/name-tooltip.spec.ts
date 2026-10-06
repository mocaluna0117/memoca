import { expect, test } from "@playwright/test";
import { openApp, setExplorerMode, signUp } from "./helpers";

const LONG = "とても長い名前のメモで、サイドバーの幅には収まりきらないので途中で切れてしまうもの";

test.describe("a name cut short", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "a pointer to rest on a name");
  });

  test("is shown whole once the pointer has rested on it a moment; one not cut, never", async ({ page }) => {
    await signUp(page);
    await setExplorerMode(page);
    await openApp(page);
    const aside = page.locator("aside");

    await aside.getByRole("button", { name: "メモを追加" }).click();
    await page.getByLabel("メモのタイトル").fill(LONG);
    const row = aside.locator("[data-tree-note]").filter({ hasText: LONG });
    await expect(row).toBeVisible();

    const tooltip = page.locator('[data-slot="tooltip-content"]').filter({ hasText: LONG });
    await row.getByText(LONG).hover();
    // Not at once,
    await page.waitForTimeout(500);
    await expect(tooltip).toHaveCount(0);
    // but a moment later.
    await expect(tooltip).toBeVisible({ timeout: 2_000 });

    // Away from it, gone; a name shown whole has none.
    // In steps, as a mouse goes: the tooltip closes on the pointer moving on
    // past the name, not on its leaving it alone.
    await page.mouse.move(800, 600, { steps: 5 });
    await expect(tooltip).toHaveCount(0);
    await aside.getByText("Inbox").hover();
    await page.waitForTimeout(1_500);
    await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
  });
});
