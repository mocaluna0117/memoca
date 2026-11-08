import { expect, type Page } from "@playwright/test";
import { createNote, editor, openApp, signUp, waitForSynced } from "./helpers";

/**
 * Text selected made larger from the toolbar's 文字の大きさ, as on a
 * computer's keyboard, and still so once the note opens again.
 */
export async function makeTextLarger(page: Page) {
  await signUp(page);
  await openApp(page);
  await createNote(page, "大きさ");
  await editor(page).click();
  await page.keyboard.type("ふつう大きい");
  // The last three characters selected, as a drag over them would.
  for (let step = 0; step < 3; step += 1) await page.keyboard.press("Shift+ArrowLeft");

  await page.locator('[data-test="fontSize"]').click();
  await page.getByRole("menuitemcheckbox", { name: "大", exact: true }).click();
  const sized = editor(page).locator('[data-style-type="fontSize"]');
  await expect(sized).toHaveText("大きい");
  await expect(sized).toHaveCSS("font-size", "20px");

  await waitForSynced(page);
  await page.reload();
  await expect(editor(page).locator('[data-style-type="fontSize"]')).toHaveText("大きい", {
    timeout: 20_000,
  });
}
