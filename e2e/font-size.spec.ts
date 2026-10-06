import { test } from "@playwright/test";
import { makeTextLarger } from "./font-size-helpers";

test("text selected is made larger from the toolbar, and stays so once the note opens again", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "selected with a computer's keyboard");
  await makeTextLarger(page);
});
