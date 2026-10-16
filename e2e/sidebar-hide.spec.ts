import { expect, test } from "@playwright/test";
import { createNote, editor, openApp, signUp } from "./helpers";

test.describe("the sidebar put away", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "a computer's screen; a phone has its drawer");
  });

  test("by its button, leaves a rail to bring it back, on this device after a reload too", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    const sidebar = page.locator("#sidebar-pane");
    const hide = page.getByRole("button", { name: "サイドバーを閉じる" });
    const show = page.getByRole("button", { name: /^サイドバーを開く/ });
    await expect(sidebar).toBeVisible();
    await expect(show).toHaveCount(0);

    await hide.click();
    await expect(sidebar).toBeHidden();
    // Focus goes to the rail's button, not out of the page.
    await expect(show).toBeFocused();

    await page.reload();
    await expect(show).toBeVisible();
    await expect(sidebar).toBeHidden();

    // Settings too has the way back.
    await page.goto("/app/settings");
    await show.click();
    await expect(sidebar).toBeVisible();
    await expect(hide).toBeFocused();
    await expect(show).toHaveCount(0);
  });

  test("by ⌘\\, while writing in a note too, which keeps the caret", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "書きかけ");
    await editor(page).click();
    const sidebar = page.locator("#sidebar-pane");

    await page.keyboard.press("ControlOrMeta+Backslash");
    await expect(sidebar).toBeHidden();
    await page.keyboard.type("続き");
    await expect(editor(page)).toContainText("続き");

    await page.keyboard.press("ControlOrMeta+Backslash");
    await expect(sidebar).toBeVisible();
  });
});
