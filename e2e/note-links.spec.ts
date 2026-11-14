import { expect, test } from "@playwright/test";
import { createNote, editor, openApp, signUp } from "./helpers";
import { linkNotes } from "./note-links-helpers";

test("a note links to another from [[, which opens it, and lists the note that links to it", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "typed on a computer's keyboard");
  await linkNotes(page);
});

test("[[ typed with the input method on, as 「「, opens the menu of notes too", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "typed on a computer's keyboard");
  await signUp(page);
  await openApp(page);
  await createNote(page, "行き先");
  await createNote(page, "出発");
  await editor(page).click();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "「「", selectionStart: 2, selectionEnd: 2 });
  await cdp.send("Input.insertText", { text: "「「" });
  await cdp.detach();
  await page.getByRole("option", { name: "行き先" }).click();
  await expect(editor(page).locator('a[data-inline-content-type="link"]')).toHaveText("行き先");
  await expect(editor(page)).not.toContainText("「");
});

test("「「 that opened the menu, closed with Esc: 「「 stays as it was typed, not [[", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "typed on a computer's keyboard");
  await signUp(page);
  await openApp(page);
  await createNote(page, "行き先");
  await createNote(page, "出発");
  await editor(page).click();
  await page.keyboard.type("引用は");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "「「", selectionStart: 2, selectionEnd: 2 });
  await cdp.send("Input.insertText", { text: "「「" });
  await cdp.detach();
  await expect(page.getByRole("option", { name: "行き先" })).toBeVisible();
  await page.keyboard.type("行");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("option", { name: "行き先" })).toHaveCount(0);
  await expect(editor(page)).toContainText("引用は「「行");
  await expect(editor(page)).not.toContainText("[[");
});

test("[[ with no note of that name: Enter is a new line, and what was typed stays", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "typed on a computer's keyboard");
  await signUp(page);
  await openApp(page);
  await createNote(page, "行き先");
  await createNote(page, "出発");
  await editor(page).click();
  await page.keyboard.type("前置き [[あとで書く");
  // Before: an item saying there was none took the Enter, and 「[[あとで書く」 with it.
  await page.keyboard.press("Enter");
  await page.keyboard.type("次の行");
  const lines = editor(page).locator(".bn-inline-content");
  await expect(lines.nth(0)).toHaveText("前置き [[あとで書く");
  await expect(lines.nth(1)).toHaveText("次の行");
  await expect(page.getByRole("listbox")).toHaveCount(0);
});
