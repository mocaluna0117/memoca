import { expect, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, signUp } from "./helpers";
import { noteImages, pasteImage, raiseKeyboard } from "./image-helpers";

/** Each block of the note a line: its type and text. */
const kinds = (page: Page) =>
  editor(page)
    .locator("[data-content-type]")
    .evaluateAll((found) =>
      found.map((block) => `${block.getAttribute("data-content-type")}:${block.textContent}`),
    );

/** A note starting with an image, and a line below it. */
async function imageFirst(page: Page) {
  await signUp(page);
  await openApp(page);
  await createNote(page, "画像が先頭");
  await pasteImage(page);
  await page.keyboard.press("Enter");
  await page.keyboard.type("下の行");
  await expect.poll(() => kinds(page)).toEqual(["image:", "paragraph:下の行"]);
}

test.describe("a line above an image at the top of a note", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "a mouse and a keyboard");
  });

  test("↑ with the image selected, then typing: the line, made only once typed in", async ({
    page,
  }) => {
    await imageFirst(page);
    await noteImages(page).first().click();
    await page.keyboard.press("ArrowUp");
    // Moving there changes nothing; ↑ again neither.
    await page.keyboard.press("ArrowUp");
    expect(await kinds(page)).toEqual(["image:", "paragraph:下の行"]);
    await page.keyboard.type("上の行");
    await expect
      .poll(() => kinds(page))
      .toEqual(["paragraph:上の行", "image:", "paragraph:下の行"]);
  });

  test("↑ held from the line below changes nothing", async ({ page }) => {
    await imageFirst(page);
    for (let i = 0; i < 5; i += 1) await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(300);
    expect(await kinds(page)).toEqual(["image:", "paragraph:下の行"]);
  });

  test("a word begun with the input method there goes in a line above", async ({ page }) => {
    await imageFirst(page);
    await noteImages(page).first().click();
    await page.keyboard.press("ArrowUp");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "うえ", selectionStart: 2, selectionEnd: 2 });
    // While it is still being written: in the line, already, a block of its
    // own (not inside the image's).
    await expect.poll(() => kinds(page)).toEqual(["paragraph:うえ", "image:", "paragraph:下の行"]);
    expect(
      await editor(page).evaluate((root) =>
        [...root.querySelectorAll(".bn-block-outer")].map(
          (block) => block.querySelectorAll(":scope > .bn-block > .bn-block-content").length,
        ),
      ),
    ).toEqual([1, 1, 1]);
    await cdp.send("Input.insertText", { text: "上" });
    await cdp.detach();
    await expect.poll(() => kinds(page)).toEqual(["paragraph:上", "image:", "paragraph:下の行"]);
  });

  test("a click in the margin above it", async ({ page }) => {
    await imageFirst(page);
    const image = (await noteImages(page).first().boundingBox())!;
    // Between the top of BlockNote's frame and the editor's: the margin above.
    const [frame, top] = await editor(page).evaluate((root) => [
      root.closest(".bn-container")!.getBoundingClientRect().top,
      root.getBoundingClientRect().top,
    ]);
    // The frame's padding is that margin: there has to be one to click.
    expect(top! - frame!).toBeGreaterThan(4);
    await page.mouse.click(image.x + 20, (frame! + top!) / 2);
    await page.keyboard.type("上の行");
    await expect
      .poll(() => kinds(page))
      .toEqual(["paragraph:上の行", "image:", "paragraph:下の行"]);
  });

  test("a drag begun in the margin makes no line", async ({ page }) => {
    await imageFirst(page);
    const image = (await noteImages(page).first().boundingBox())!;
    const [frame, top] = await editor(page).evaluate((root) => [
      root.closest(".bn-container")!.getBoundingClientRect().top,
      root.getBoundingClientRect().top,
    ]);
    const y = (frame! + top!) / 2;
    // Down into the note, and along the margin itself.
    for (const to of [
      { x: image.x + 60, y: image.y + image.height + 20 },
      { x: image.x + 160, y },
    ]) {
      await page.mouse.move(image.x + 20, y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await page.mouse.up();
    }
    await page.waitForTimeout(300);
    expect(await kinds(page)).toEqual(["image:", "paragraph:下の行"]);
  });

  test("Enter with the caret just before it (← from it selected)", async ({ page }) => {
    await imageFirst(page);
    await noteImages(page).first().click();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    await page.keyboard.type("上の行");
    await expect
      .poll(() => kinds(page))
      .toEqual(["paragraph:上の行", "image:", "paragraph:下の行"]);
  });

  test("its toolbar, over the margin above it, works as it does, with no line made", async ({
    page,
  }) => {
    await imageFirst(page);
    await noteImages(page).first().click();
    await page.getByRole("button", { name: "トリミング" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await kinds(page)).toEqual(["image:", "paragraph:下の行"]);
  });

  test("Enter in the title that commits a word being written with the input method stays there", async ({
    page,
  }) => {
    await imageFirst(page);
    const title = page.getByLabel("メモのタイトル");
    await title.click();
    // As Chrome says it (composing), and as Safari does (keyCode 229 alone).
    for (const composing of [true, false]) {
      await title.evaluate((field, composing) => {
        const event = new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
          isComposing: composing,
        });
        Object.defineProperty(event, "keyCode", { value: 229 });
        field.dispatchEvent(event);
      }, composing);
    }
    await expect(title).toBeFocused();
    expect(await kinds(page)).toEqual(["image:", "paragraph:下の行"]);
  });

  test("Enter in the title: down to a new first line above it, or to the first line", async ({
    page,
  }) => {
    await imageFirst(page);
    await page.getByLabel("メモのタイトル").click();
    await page.keyboard.press("Enter");
    await page.keyboard.type("上の行");
    await expect
      .poll(() => kinds(page))
      .toEqual(["paragraph:上の行", "image:", "paragraph:下の行"]);
    // Once there is a line first: the caret at its start, no new line.
    await page.getByLabel("メモのタイトル").click();
    await page.keyboard.press("Enter");
    await page.keyboard.type("先頭");
    await expect
      .poll(() => kinds(page))
      .toEqual(["paragraph:先頭上の行", "image:", "paragraph:下の行"]);
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("画像が先頭");
  });
});

test("on a phone, Enter in the title makes a line above an image at the top", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "a phone's keyboard");
  await imageFirst(page);
  await page.getByLabel("メモのタイトル").click();
  await page.keyboard.press("Enter");
  await page.keyboard.type("上の行");
  await expect.poll(() => kinds(page)).toEqual(["paragraph:上の行", "image:", "paragraph:下の行"]);
});

test("on a phone, 上に行を追加 in the bar puts a line above the image", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "a phone's bar above its keyboard");
  await imageFirst(page);
  await noteImages(page).first().click();
  await raiseKeyboard(page);
  await page
    .getByRole("toolbar", { name: "ブロックの操作" })
    .getByRole("button", { name: "上に行を追加" })
    .click();
  await page.keyboard.type("上の行");
  await expect.poll(() => kinds(page)).toEqual(["paragraph:上の行", "image:", "paragraph:下の行"]);
});
