import { expect, test } from "@playwright/test";
import { caretIn, caretInLastLine, outline, writeNote } from "./block-select-helpers";
import { raiseKeyboard } from "./image-helpers";

test.describe("blocks on a phone", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "a phone's bar above its keyboard");
  });

  test("the bar's 複製 and コピー act on the caret's block, pasted back as one", async ({
    page,
  }) => {
    await writeNote(page);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const bar = page.getByRole("toolbar", { name: "ブロックの操作" });
    await caretIn(page, "卵");
    await raiseKeyboard(page);
    await bar.getByRole("button", { name: "ブロックを複製" }).click();
    await expect
      .poll(() => outline(page))
      .toEqual([
        "bulletListItem:牛乳",
        "bulletListItem:卵",
        "bulletListItem:卵",
        "paragraph:メモの行",
        "paragraph:",
      ]);

    await caretIn(page, "牛乳");
    await bar.getByRole("button", { name: "ブロックをコピー" }).click();
    await expect(page.getByText("ブロックをコピーしました")).toBeVisible();
    await caretInLastLine(page);
    await page.keyboard.press("ControlOrMeta+v");
    await expect
      .poll(() => outline(page))
      .toEqual([
        "bulletListItem:牛乳",
        "bulletListItem:卵",
        "bulletListItem:卵",
        "paragraph:メモの行",
        "bulletListItem:牛乳",
      ]);
  });
});
