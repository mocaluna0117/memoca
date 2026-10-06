import { expect, type Page } from "@playwright/test";
import { createNote, editor, openApp, signUp, waitForSynced } from "./helpers";

/**
 * A note made to link to another from [[: the link opens that note here,
 * and that note lists the one linking to it, which opens it again.
 */
export async function linkNotes(page: Page) {
  await signUp(page);
  await openApp(page);
  await createNote(page, "行き先のメモ");
  await editor(page).click();
  await page.keyboard.type("ここに着く");
  await waitForSynced(page);

  await createNote(page, "出発のメモ");
  await editor(page).click();
  await page.keyboard.type("詳しくは ");
  await page.keyboard.type("[[");
  await page.keyboard.type("行き先");
  await page.getByRole("option", { name: "行き先のメモ" }).click();
  const link = editor(page).locator('a[data-inline-content-type="link"]');
  await expect(link).toHaveText("行き先のメモ");
  await expect(link).toHaveAttribute("href", /\/app\?n=/);
  await waitForSynced(page);

  // A click opens it here, not in another window.
  await link.click();
  await expect(page.getByLabel("メモのタイトル")).toHaveValue("行き先のメモ");
  await expect(page).toHaveURL(/\/app\?.*n=/);
  const backlinks = page.getByRole("region", { name: "このメモへのリンク" });
  await expect(backlinks.getByRole("button", { name: "出発のメモ" })).toBeVisible();
  await backlinks.getByRole("button", { name: "出発のメモ" }).click();
  await expect(page.getByLabel("メモのタイトル")).toHaveValue("出発のメモ");
}
