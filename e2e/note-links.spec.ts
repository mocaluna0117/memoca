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
