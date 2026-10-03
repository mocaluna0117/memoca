import { expect, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, signUp } from "./helpers";
import { noteImages, pasteImage } from "./image-helpers";

/** Each block a line: its type and text. */
const kinds = (page: Page) =>
  editor(page)
    .locator("[data-content-type]")
    .evaluateAll((found) =>
      found.map((block) => `${block.getAttribute("data-content-type")}:${block.textContent}`),
    );

type Copied = { own: string; html: string; plain: string };

/**
 * What the next copy puts on the clipboard, as the editor writes it: the
 * listener is in place before this returns, and `done` resolves once the
 * copy is made.
 */
async function nextCopy(page: Page): Promise<{ done: Promise<Copied> }> {
  await page.evaluate(() => {
    (window as unknown as { copied: Promise<Copied> }).copied = new Promise((resolve) =>
      window.addEventListener(
        "copy",
        (event) =>
          resolve({
            own: event.clipboardData!.getData("blocknote/html"),
            html: event.clipboardData!.getData("text/html"),
            plain: event.clipboardData!.getData("text/plain"),
          }),
        { once: true },
      ),
    );
  });
  return { done: page.evaluate(() => (window as unknown as { copied: Promise<Copied> }).copied) };
}

/** Pastes what a copy gave, as the browser would from the clipboard. */
async function paste(page: Page, types: Record<string, string>) {
  await editor(page).evaluate((root, types) => {
    const data = new DataTransfer();
    for (const [type, value] of Object.entries(types)) data.setData(type, value);
    root.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, types);
}

/** Whether an image looks selected. */
const looksSelected = (page: Page) =>
  page.locator('[data-content-type="image"].memoca-selected-media');

/** A note with an open toggle: a line, then six tall images in a row inside it. */
async function imagesInToggle(page: Page) {
  await signUp(page);
  await openApp(page);
  await createNote(page, "トグル");
  await editor(page).click();
  await page.keyboard.type("/折りたたみリスト");
  await expect(page.getByRole("option", { name: /折りたたみリスト/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type("箱");
  const box = editor(page)
    .locator(".bn-block-content")
    .filter({ has: page.locator(".bn-inline-content", { hasText: /^箱$/ }) })
    .first();
  await box.locator(".bn-toggle-button").click();
  await box.locator(".bn-toggle-add-block-button").click();
  await page.keyboard.type("中の上");
  await page.keyboard.press("Enter");
  // Six tall images in a row inside the toggle, taller together than the screen.
  await editor(page).evaluate((target) => {
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 500;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#3366cc";
    context.fillRect(0, 0, 600, 500);
    const url = canvas.toDataURL("image/png");
    const data = new DataTransfer();
    data.setData("text/html", Array.from({ length: 6 }, () => `<img src="${url}">`).join(""));
    target.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(noteImages(page)).toHaveCount(6, { timeout: 30_000 });
}

test.describe("an image selected with Shift and the arrow keys", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "a computer's keyboard");
  });

  test("at the end of a note, Shift+↓ takes it, and it is copied with the text", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "画像");
    await editor(page).click();
    await page.keyboard.type("上の行");
    await pasteImage(page);
    expect(await kinds(page)).toEqual(["paragraph:上の行", "image:"]);

    await editor(page).getByText("上の行").click();
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(looksSelected(page)).toHaveCount(1);
    const copied = await nextCopy(page);
    await page.keyboard.press("ControlOrMeta+c");
    const { own, html } = await copied.done;
    expect(html).toContain("<img");
    expect(own).toContain('data-content-type="image"');

    // Pasted into another note, the image comes with the text.
    await createNote(page, "貼り付け先");
    await editor(page).click();
    await paste(page, { "blocknote/html": own, "text/html": html });
    await expect(noteImages(page)).toHaveCount(1);
    await expect.poll(() => kinds(page)).toContain("image:");
  });

  test("at the top of a note, Shift+↑ takes it, and back down lets it go", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "画像");
    await pasteImage(page);
    await page.keyboard.press("Enter");
    await page.keyboard.type("下の行");
    expect((await kinds(page)).slice(-1)).toEqual(["paragraph:下の行"]);
    const first = (await kinds(page))[0];
    // A paste into the empty first line leaves the image first, or after it.
    test.skip(first !== "image:", "the image is not first");

    await page.keyboard.press("Shift+ArrowUp");
    await page.keyboard.press("Shift+ArrowUp");
    await expect(looksSelected(page)).toHaveCount(1);
    await page.keyboard.press("Shift+ArrowDown");
    await expect(looksSelected(page)).toHaveCount(0);
  });

  test("between lines, it is taken as the browser takes it, and shown selected", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "画像");
    await editor(page).click();
    await page.keyboard.type("上の行");
    await pasteImage(page);
    await page.keyboard.press("Enter");
    await page.keyboard.type("下の行");
    await editor(page).getByText("上の行").click();
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(looksSelected(page)).toHaveCount(1);
    const copied = await nextCopy(page);
    await page.keyboard.press("ControlOrMeta+c");
    const { html, plain } = await copied.done;
    expect(html).toContain("<img");
    expect(plain.replace(/\r\n/g, "\n")).toContain("下の行");
  });

  test("⌘A takes an image at the end too, and ↓ then lets go", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "画像");
    await editor(page).click();
    await page.keyboard.type("一行目");
    await pasteImage(page);
    await editor(page).getByText("一行目").click();
    await expect
      .poll(() => page.evaluate(() => getSelection()?.anchorNode?.textContent))
      .toBe("一行目");
    await page.waitForTimeout(100);
    await page.keyboard.press("ControlOrMeta+a");
    await expect(looksSelected(page)).toHaveCount(1);
    const copied = await nextCopy(page);
    await page.keyboard.press("ControlOrMeta+c");
    expect((await copied.done).html).toContain("<img");
    await page.keyboard.press("ArrowDown");
    await expect(looksSelected(page)).toHaveCount(0);
  });

  test("typed over with the input method, the image selected goes with the text", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "画像");
    await editor(page).click();
    await page.keyboard.type("一行目");
    await pasteImage(page);
    await editor(page).getByText("一行目").click();
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await expect(looksSelected(page)).toHaveCount(1);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "あ", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.insertText", { text: "亜" });
    await cdp.detach();
    await expect(noteImages(page)).toHaveCount(0);
    await expect(editor(page)).toContainText("亜");
  });

  test("in a table, Shift+↓ still selects cells, as the table has it", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "表");
    await editor(page).click();
    await page.keyboard.type("/表");
    await expect(page.getByRole("option", { name: /表/ }).first()).toBeVisible();
    await page.keyboard.press("Enter");
    await pasteImage(page);
    const cells = editor(page).locator("td, th");
    await cells.first().click();
    // The caret in the first cell, and the editor with it, before the keys.
    await expect
      .poll(() =>
        page.evaluate(() => !!getSelection()?.anchorNode?.parentElement?.closest("td, th")),
      )
      .toBe(true);
    await page.waitForTimeout(100);
    // From the first row down to the next: cells, not the text down to the image.
    await page.keyboard.press("Shift+ArrowDown");
    await expect(editor(page).locator(".selectedCell")).toHaveCount(2);
    await expect(looksSelected(page)).toHaveCount(0);
  });

  test("an image copied alone is on the clipboard as an image, for other apps", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "画像");
    await editor(page).click();
    await page.keyboard.type("上の行");
    await pasteImage(page);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await noteImages(page).first().click();
    await page.keyboard.press("ControlOrMeta+c");
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const [item] = await navigator.clipboard.read();
          if (!item?.types.includes("image/png")) return null;
          const bitmap = await createImageBitmap(await item.getType("image/png"));
          return [bitmap.width, bitmap.height];
        }),
      )
      .toEqual([400, 300]);
  });

  test("an image copied alone, pasted back into Memoca, is the same image, not a new one", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "画像");
    await editor(page).click();
    await page.keyboard.type("上の行");
    await pasteImage(page);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const src = await editor(page)
      .locator('[data-content-type="image"]')
      .first()
      .getAttribute("data-url");
    await noteImages(page).first().click();
    await page.keyboard.press("ControlOrMeta+c");
    // Once the image itself is on the clipboard, and nothing else.
    await expect
      .poll(() => page.evaluate(async () => (await navigator.clipboard.read())[0]?.types.join(",")))
      .toBe("image/png");
    // Pasted on the line above, not over the image still selected.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ControlOrMeta+v");
    await expect(noteImages(page)).toHaveCount(2);
    const urls = await editor(page)
      .locator('[data-content-type="image"]')
      .evaluateAll((found) => found.map((block) => block.getAttribute("data-url")));
    expect(urls).toEqual([src, src]);
  });

  test("an image copied alone does not take the place of a copy made straight after it", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "画像");
    await editor(page).click();
    await page.keyboard.type("上の行");
    await pasteImage(page);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await noteImages(page).first().click();
    await page.keyboard.press("ControlOrMeta+c");
    // At once, before the image is ready: the line above, copied.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+c");
    await page.waitForTimeout(1500);
    const types = await page.evaluate(async () => (await navigator.clipboard.read())[0]?.types);
    expect(types).not.toContain("image/png");
    expect(types).toContain("text/plain");
  });

  for (const where of ["past the image", "over the image"] as const) {
    test(`a drag with the mouse let go of ${where} at the end takes the image`, async ({
      page,
    }) => {
      await signUp(page);
      await openApp(page);
      await createNote(page, "画像");
      await editor(page).click();
      await page.keyboard.type("上の行");
      await pasteImage(page);
      // The caret back on the line, so the image's toolbar is not over it.
      await page.keyboard.press("ArrowUp");
      await expect(page.locator(".bn-formatting-toolbar")).toHaveCount(0);
      const line = (await editor(page).getByText("上の行").boundingBox())!;
      const image = (await noteImages(page).first().boundingBox())!;
      await page.mouse.move(line.x + 1, line.y + line.height / 2);
      await page.mouse.down();
      const end =
        where === "past the image"
          ? { x: image.x + image.width / 2, y: image.y + image.height + 40 }
          : { x: image.x + image.width / 2, y: image.y + image.height / 2 };
      await page.mouse.move(end.x, end.y, { steps: 10 });
      await page.mouse.up();
      await expect(looksSelected(page)).toHaveCount(1);
      const copied = await nextCopy(page);
      await page.keyboard.press("ControlOrMeta+c");
      const { html } = await copied.done;
      expect(html).toContain("上の行");
      expect(html).toContain("<img");
    });
  }
  test("images in a row in an open toggle, taken one a press, each scrolled to, not past", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await imagesInToggle(page);
    await editor(page).getByText("中の上").click();
    await page.keyboard.press("End");
    const images = editor(page).locator('[data-content-type="image"]');
    for (let taken = 1; taken <= 6; taken += 1) {
      await page.keyboard.press("Shift+ArrowDown");
      await expect(looksSelected(page)).toHaveCount(taken);
      // The image just taken is what is on the screen: the note was thrown
      // down to the toggle's foot by the first press.
      await page.waitForTimeout(500);
      const shown = await images.nth(taken - 1).evaluate((image) => {
        const box = image.getBoundingClientRect();
        return box.bottom > 0 && box.top < window.innerHeight;
      });
      expect(shown, `image ${taken} on the screen`).toBe(true);
      if (taken + 1 < 6) {
        const next = await images
          .nth(taken + 1)
          .evaluate((image) => image.getBoundingClientRect().top > window.innerHeight);
        expect(next, `image ${taken + 2} still below`).toBe(true);
      }
    }
  });

  test("an image clicked in an open toggle, Shift+↓ takes it and the next, staying in the toggle", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await imagesInToggle(page);
    const images = editor(page).locator('[data-content-type="image"]');
    await images.nth(2).locator("img").click();
    await page.keyboard.press("Shift+ArrowDown");
    await expect(looksSelected(page)).toHaveCount(2);
    await page.keyboard.press("Shift+ArrowDown");
    await expect(looksSelected(page)).toHaveCount(3);
    // Not up to the toggle's line: the images from the one clicked on.
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selected).not.toContain("箱");
    for (const nth of [2, 3, 4]) {
      await expect(images.nth(nth)).toHaveClass(/memoca-selected-media/);
    }
  });
});
