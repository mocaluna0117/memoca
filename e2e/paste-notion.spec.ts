import { expect, test } from "@playwright/test";
import { createNote, editor, openApp, signUp } from "./helpers";

test("Notion's lines and images pasted: a line in each image's place, said so", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "pasted with a keyboard's");
  await signUp(page);
  await openApp(page);
  await createNote(page, "Notion から");
  await editor(page).click();
  // As Notion puts a selection of a line, two images and a line on the
  // clipboard: its images by its own references, which only Notion reads.
  await editor(page).evaluate((root) => {
    const data = new DataTransfer();
    data.setData(
      "text/html",
      [
        "<p>上の行</p>",
        '<img src="attachment:979e4c8e-de6a-45f9-967a-1d00c8ab8123:image.png" alt="image.png">',
        '<img src="attachment:0b291910-b31a-4fb6-81b0-02bd81dc7624:image.png" alt="image.png">',
        "<p>下の行</p>",
      ].join(""),
    );
    data.setData("text/plain", "上の行\n\n下の行");
    root.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });

  const lines = editor(page).locator(".bn-block-content");
  await expect(lines.filter({ hasText: "（Notion の画像：image.png）" })).toHaveCount(2);
  await expect(lines.filter({ hasText: "上の行" })).toHaveCount(1);
  await expect(lines.filter({ hasText: "下の行" })).toHaveCount(1);
  await expect(editor(page).locator('[data-content-type="image"]')).toHaveCount(0);
  await expect(
    page.getByText("画像 2 枚は Notion から一緒にはコピーされないため、目印の行にしました"),
  ).toBeVisible();
});
