import { expect, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, signUp } from "./helpers";

/** Each block of the note a line: its type and text, indented by how deep it is. */
const outline = (page: Page) =>
  editor(page).evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>(".bn-block-content")].map((content) => {
      let depth = 0;
      for (let at = content.parentElement; at && at !== root; at = at.parentElement) {
        if (at.classList.contains("bn-block-group")) depth += 1;
      }
      const type = content.dataset.contentType ?? "";
      const text = content.querySelector(".bn-inline-content")?.textContent ?? "";
      return `${"  ".repeat(Math.max(0, depth - 1))}${type}:${text}`;
    }),
  );

/** The block holding a line of text. */
const block = (page: Page, text: string) =>
  editor(page)
    .locator(".bn-block-content")
    .filter({ has: page.locator(".bn-inline-content", { hasText: new RegExp(`^${text}$`) }) })
    .first();

/** A new note starting with a toggle, its line saying `title`. */
async function toggleNote(page: Page, title: string) {
  await signUp(page);
  await openApp(page);
  await createNote(page, "トグル");
  await editor(page).click();
  await page.keyboard.type("/折りたたみリスト");
  await expect(page.getByRole("option", { name: /折りたたみリスト/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type(title);
}

/** Opens (or closes) the toggle on a line. */
async function flip(page: Page, text: string) {
  const wrapper = block(page, text).locator(".bn-toggle-wrapper");
  const open = await wrapper.getAttribute("data-show-children");
  await block(page, text).locator(".bn-toggle-button").click();
  await expect(wrapper).toHaveAttribute("data-show-children", open === "true" ? "false" : "true");
}

/** The caret to the end of a line: a click on its last character's right half. */
async function toEnd(page: Page, text: string) {
  const end = await block(page, text)
    .locator(".bn-inline-content")
    .evaluate((line) => {
      const range = document.createRange();
      range.selectNodeContents(line);
      const box = range.getBoundingClientRect();
      return { x: box.right - 2, y: box.top + box.height / 2 };
    });
  await page.mouse.click(end.x, end.y);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const selection = getSelection();
        return [selection?.anchorNode?.textContent, selection?.anchorOffset];
      }),
    )
    .toEqual([text, text.length]);
  // For the editor to take the caret from where the browser put it, which it
  // does on the browser's next selectionchange.
  await page.waitForTimeout(100);
}

/** A block's handle, in the side menu shown next to the block the pointer is over. */
const HANDLE = ".bn-side-menu [draggable='true']";

/**
 * Drags a block by its handle to a point `down` of the way down another's
 * line: over the line, or (`margin`) straight down the margin the handle is
 * in. `midway` runs while it is still dragged there.
 */
async function dragBlock(
  page: Page,
  moving: string,
  onto: string,
  down: number,
  { margin = false, midway }: { margin?: boolean; midway?: () => Promise<void> } = {},
) {
  await block(page, moving).hover();
  const handle = page.locator(HANDLE).first();
  await expect(handle).toBeVisible();
  const from = (await handle.boundingBox())!;
  const line = (await block(page, onto).locator(".bn-inline-content").boundingBox())!;
  const x = from.x + from.width / 2;
  await page.mouse.move(x, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(margin ? x : line.x + 40, line.y + line.height * down, { steps: 10 });
  await midway?.();
  await page.mouse.up();
}

test.describe("toggles", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "a mouse and a keyboard");
  });

  test("Enter in an open toggle's line starts a line inside it, and what was inside stays", async ({
    page,
  }) => {
    await toggleNote(page, "箱の見出し");
    await flip(page, "箱の見出し");
    await block(page, "箱の見出し").locator(".bn-toggle-add-block-button").click();
    await page.keyboard.type("中身の行");
    await toEnd(page, "箱の見出し");
    await page.keyboard.press("Enter");
    await page.keyboard.type("新しい行");
    await expect
      .poll(() => outline(page))
      .toEqual(["toggleListItem:箱の見出し", "  paragraph:新しい行", "  paragraph:中身の行"]);
  });

  test("Enter in a toggle's line is undone in one step", async ({ page }) => {
    await toggleNote(page, "箱の見出し");
    await flip(page, "箱の見出し");
    await block(page, "箱の見出し").locator(".bn-toggle-add-block-button").click();
    await page.keyboard.type("中身の行");
    await toEnd(page, "箱の見出し");
    // Apart from the typing before it, which would otherwise be undone with it.
    await page.waitForTimeout(700);
    await page.keyboard.press("Enter");
    await expect
      .poll(() => outline(page))
      .toEqual(["toggleListItem:箱の見出し", "  paragraph:", "  paragraph:中身の行"]);
    await page.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(() => outline(page))
      .toEqual(["toggleListItem:箱の見出し", "  paragraph:中身の行"]);
  });

  test("Enter in a closed toggle's line makes the next toggle after it, what was inside staying", async ({
    page,
  }) => {
    await toggleNote(page, "箱の見出し");
    await flip(page, "箱の見出し");
    await block(page, "箱の見出し").locator(".bn-toggle-add-block-button").click();
    await page.keyboard.type("中身の行");
    await flip(page, "箱の見出し");
    await toEnd(page, "箱の見出し");
    await page.keyboard.press("Enter");
    await page.keyboard.type("次の項目");
    await expect
      .poll(() => outline(page))
      .toEqual(["toggleListItem:箱の見出し", "  paragraph:中身の行", "toggleListItem:次の項目"]);
    // Still closed, and still holding it.
    await expect(block(page, "中身の行")).toBeHidden();
  });

  test("closed with the caret inside it, the caret comes to its line", async ({ page }) => {
    await toggleNote(page, "箱の見出し");
    await flip(page, "箱の見出し");
    await block(page, "箱の見出し").locator(".bn-toggle-add-block-button").click();
    await page.keyboard.type("中身の行");
    await flip(page, "箱の見出し");
    await page.keyboard.type("続き");
    await expect
      .poll(() => outline(page))
      .toEqual(["toggleListItem:箱の見出し続き", "  paragraph:中身の行"]);
  });

  test("a block dragged to an open toggle's line goes inside it, first", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "トグル");
    await editor(page).click();
    await page.keyboard.type("動かす行");
    await page.keyboard.press("Enter");
    await page.keyboard.type("もう一つの行");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/折りたたみリスト");
    await expect(page.getByRole("option", { name: /折りたたみリスト/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await page.keyboard.type("箱の見出し");
    await flip(page, "箱の見出し");

    // To the lower half of its line: in, though it has nothing inside yet,
    // its "add a block" button framed on the way, and not after.
    const add = block(page, "箱の見出し").locator(".bn-toggle-add-block-button");
    await dragBlock(page, "動かす行", "箱の見出し", 0.8, {
      midway: async () => {
        const frame = await page.locator(".memoca-toggle-drop").boundingBox();
        const button = (await add.boundingBox())!;
        expect(frame).toEqual(button);
      },
    });
    await expect
      .poll(() => outline(page))
      .toEqual(["paragraph:もう一つの行", "toggleListItem:箱の見出し", "  paragraph:動かす行"]);
    await expect(page.locator(".memoca-toggle-drop")).toHaveCount(0);
    // And another, first again, dragged down the margin its handle is in.
    await dragBlock(page, "もう一つの行", "箱の見出し", 0.8, { margin: true });
    await expect
      .poll(() => outline(page))
      .toEqual(["toggleListItem:箱の見出し", "  paragraph:もう一つの行", "  paragraph:動かす行"]);
  });

  test("a block dragged to a closed toggle's line goes after it, and all hidden inside it", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "トグル");
    await editor(page).click();
    await page.keyboard.type("動かす行");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/折りたたみリスト");
    await expect(page.getByRole("option", { name: /折りたたみリスト/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await page.keyboard.type("箱の見出し");
    await flip(page, "箱の見出し");
    await block(page, "箱の見出し").locator(".bn-toggle-add-block-button").click();
    await page.keyboard.type("中身の行");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("最後の行");
    await flip(page, "箱の見出し");
    await expect
      .poll(() => outline(page))
      .toEqual([
        "paragraph:動かす行",
        "toggleListItem:箱の見出し",
        "  paragraph:中身の行",
        "paragraph:最後の行",
      ]);

    await dragBlock(page, "動かす行", "箱の見出し", 0.8);
    await expect
      .poll(() => outline(page))
      .toEqual([
        "toggleListItem:箱の見出し",
        "  paragraph:中身の行",
        "paragraph:動かす行",
        "paragraph:最後の行",
      ]);
    await expect(block(page, "中身の行")).toBeHidden();
  });

  test("a block is still moved by its handle, and the handle still opens its menu", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "並べ替え");
    await editor(page).click();
    for (const line of ["一番目の行", "二番目の行", "三番目の行"]) {
      await page.keyboard.type(line);
      await page.keyboard.press("Enter");
    }
    await page.keyboard.press("Backspace");
    await dragBlock(page, "一番目の行", "三番目の行", 0.2);
    await expect
      .poll(() => outline(page))
      .toEqual(["paragraph:二番目の行", "paragraph:一番目の行", "paragraph:三番目の行"]);

    await block(page, "二番目の行").hover();
    await page.locator(HANDLE).first().click();
    await expect(page.getByRole("menuitem", { name: "削除" })).toBeVisible();
  });

  test("its line all selected and copied, it is copied with what is inside it", async ({
    page,
  }) => {
    await toggleNote(page, "箱の見出し");
    await flip(page, "箱の見出し");
    await block(page, "箱の見出し").locator(".bn-toggle-add-block-button").click();
    await page.keyboard.type("中身の行");
    await flip(page, "箱の見出し");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

    // The line selected from its end to its start.
    await toEnd(page, "箱の見出し");
    await page.keyboard.down("Shift");
    for (let i = 0; i < "箱の見出し".length; i += 1) await page.keyboard.press("ArrowLeft");
    await page.keyboard.up("Shift");
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("箱の見出し");
    await page.keyboard.press("ControlOrMeta+c");
    const plain = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      return (await item!.getType("text/plain")).text();
    });
    expect(plain.replace(/\r\n/g, "\n")).toBe("箱の見出し\n  中身の行");

    // Pasted into the note, it is the toggle again, with what is inside it.
    await toEnd(page, "箱の見出し");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("ControlOrMeta+v");
    await expect
      .poll(() => outline(page))
      .toEqual([
        "toggleListItem:箱の見出し",
        "  paragraph:中身の行",
        "toggleListItem:箱の見出し",
        "  paragraph:中身の行",
      ]);
  });

  test("its line all selected and cut, it goes with what is inside it", async ({ page }) => {
    await toggleNote(page, "箱の見出し");
    await flip(page, "箱の見出し");
    await block(page, "箱の見出し").locator(".bn-toggle-add-block-button").click();
    await page.keyboard.type("中身の行");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("後の行");
    await flip(page, "箱の見出し");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

    await toEnd(page, "箱の見出し");
    await page.keyboard.down("Shift");
    for (let i = 0; i < "箱の見出し".length; i += 1) await page.keyboard.press("ArrowLeft");
    await page.keyboard.up("Shift");
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe("箱の見出し");
    await page.keyboard.press("ControlOrMeta+x");
    await expect.poll(() => outline(page)).toEqual(["paragraph:後の行"]);
    const plain = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      return (await item!.getType("text/plain")).text();
    });
    expect(plain.replace(/\r\n/g, "\n")).toBe("箱の見出し\n  中身の行");
  });
});
