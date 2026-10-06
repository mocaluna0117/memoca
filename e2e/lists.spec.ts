import { test } from "@playwright/test";
import { createNote, openApp, signUp } from "./helpers";
import { typeAList } from "./list-helpers";

test("a list typed on a computer's keyboard: Tab kept in the note, ・ kept in an item, - taken back alone", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "typed on a computer's keyboard");
  await signUp(page);
  await openApp(page);
  await createNote(page, "リスト");
  await typeAList(page);
});
