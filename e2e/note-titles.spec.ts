import { expect, test } from "@playwright/test";
import { createNote, editor, openApp, setExplorerMode, signUp, waitForSynced } from "./helpers";

test.describe("a name of its own in its folder", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the sidebar beside the note");
  });

  test("typed as another's there: numbered once the title is left, not while typing", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "会議");
    await createNote(page, "会議");
    const title = page.getByLabel("メモのタイトル");
    // Still being typed: as typed.
    await expect(title).toHaveValue("会議");
    await editor(page).click();
    await expect(title).toHaveValue("会議 (2)");
    await waitForSynced(page);

    // Kept after a reload: written, not just shown.
    await page.reload();
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("会議 (2)", { timeout: 20_000 });
  });

  test("moved into a folder with one of its name: numbered", async ({ page }) => {
    await signUp(page);
    await setExplorerMode(page);
    await openApp(page);
    const aside = page.locator("aside");
    await aside.getByRole("button", { name: "フォルダを追加" }).click();
    await aside.getByRole("button", { name: "新しいフォルダ に新しいメモ" }).click();
    await page.getByLabel("メモのタイトル").fill("予定");
    await editor(page).click();

    // One of that name in Inbox, moved into the folder.
    await createNote(page, "予定");
    await editor(page).click();
    await page.getByRole("button", { name: "メモの操作" }).click();
    await page.getByRole("menuitem", { name: "移動", exact: true }).click();
    await page.getByRole("dialog").getByRole("option", { name: /新しいフォルダ/ }).click();
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("予定 (2)");
  });
});
