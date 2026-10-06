import { expect, test } from "@playwright/test";
import { createNote, editor, openApp, signUp, waitForSynced } from "./helpers";

test("a note is put back as it was, from its history, on every device", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "typed on a computer's keyboard");
  await signUp(page);
  await openApp(page);
  await createNote(page, "履歴");
  await editor(page).click();
  await page.keyboard.type("最初に書いたこと");
  await waitForSynced(page);
  // Sent, and heard back: what the next edit's version is made from.
  await page.waitForTimeout(1_500);
  await page.keyboard.press("Enter");
  await page.keyboard.type("あとで足したこと");
  await waitForSynced(page);

  await page.getByRole("button", { name: "メモの操作" }).click();
  await page.getByRole("menuitem", { name: "変更履歴" }).click();
  const versions = page.getByRole("list", { name: "残っている版" }).getByRole("button");
  await expect(versions).toHaveCount(1, { timeout: 15_000 });
  await versions.first().click();
  await expect(page.getByTestId("version-text")).toHaveText("最初に書いたこと");
  await page.getByRole("button", { name: "この版に戻す" }).click();
  await expect(page.getByText("この版に戻しました")).toBeVisible();

  await expect(editor(page)).toHaveText("最初に書いたこと");
  await waitForSynced(page);
  await page.reload();
  await expect(editor(page)).toHaveText("最初に書いたこと", { timeout: 20_000 });

  // What it was just before is kept too, to undo the restore.
  await page.getByRole("button", { name: "メモの操作" }).click();
  await page.getByRole("menuitem", { name: "変更履歴" }).click();
  await expect(versions).toHaveCount(2, { timeout: 15_000 });
  await versions.first().click();
  await expect(page.getByTestId("version-text")).toHaveText("最初に書いたこと\nあとで足したこと");
});
