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

/**
 * A note with an open toggle of `inside` lines, then `after` lines after it,
 * the caret at the end of the last.
 */
async function longToggle(page: Page, inside: number, after: number) {
  await toggleNote(page, "箱の見出し");
  await flip(page, "箱の見出し");
  await block(page, "箱の見出し").locator(".bn-toggle-add-block-button").click();
  for (let i = 1; i <= inside; i += 1) {
    if (i > 1) await page.keyboard.press("Enter");
    await page.keyboard.type(`中身${i}`);
  }
  // Out of it: an empty line inside it, Enter again.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  for (let i = 1; i <= after; i += 1) {
    if (i > 1) await page.keyboard.press("Enter");
    await page.keyboard.type(`後${i}`);
  }
  await expect.poll(async () => (await outline(page)).length).toBe(1 + inside + after);
}

/**
 * How far below the bottom of the note's header a line's top is on the
 * screen: within a pixel of 0 for one kept just below it.
 */
const belowHeader = (page: Page, text: string) =>
  block(page, text).evaluate((line) => {
    const header = document.querySelector(".memoca-note-pane > header")!;
    return Math.round(line.getBoundingClientRect().top - header.getBoundingClientRect().bottom);
  });

/** A line's background, and the editor's. */
const backgrounds = (page: Page, text: string) =>
  block(page, text).evaluate((line) => [
    getComputedStyle(line).backgroundColor,
    getComputedStyle(line.closest(".bn-editor")!).backgroundColor,
  ]);

/** Where the caret's line is: its top against the bottom of a line, and whether it is on the screen. */
const caretLine = (page: Page, above: string) =>
  block(page, above).evaluate((line) => {
    const node = getSelection()!.anchorNode!;
    // Its text's line: where the caret is, empty or not.
    const caret = (node instanceof Element ? node : node.parentElement!)
      .closest(".bn-block-content")!
      .querySelector(".bn-inline-content")!
      .getBoundingClientRect();
    return {
      below: Math.round(caret.top - line.getBoundingClientRect().bottom),
      onScreen: caret.bottom <= window.innerHeight,
    };
  });

test("an open toggle's line stays at the top as what is inside it is scrolled past, its ▼ closing it there", async ({
  page,
}) => {
  await longToggle(page, 40, 40);
  // At the top of the note, it is where it is, below the editor's margin.
  await page.evaluate(() => {
    document.querySelector('[data-scroll="note"]')!.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await expect.poll(() => belowHeader(page, "箱の見出し")).toBeGreaterThan(4);
  // Halfway down what is inside it: just below the header (the page's on a
  // phone, the note's own on a computer), over what scrolls under it.
  await block(page, "中身20").evaluate((line) => line.scrollIntoView({ block: "center" }));
  await expect
    .poll(async () => Math.abs(await belowHeader(page, "箱の見出し")))
    .toBeLessThanOrEqual(1);
  // Over what scrolls under it, as the editor is.
  const [line, under] = await backgrounds(page, "箱の見出し");
  expect(line).not.toBe("rgba(0, 0, 0, 0)");
  expect(line).toBe(under);
  const button = block(page, "箱の見出し").locator(".bn-toggle-button");
  const box = (await button.boundingBox())!;
  expect(
    await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest(".bn-toggle-button") !== null,
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    ),
  ).toBe(true);
  // Past its end, it goes on up with it.
  await block(page, "後20").evaluate((line) => line.scrollIntoView({ block: "center" }));
  await expect.poll(() => belowHeader(page, "箱の見出し")).toBeLessThan(-100);

  // Closed by its ▼ from there: back in view, at the top, not out of sight above.
  await block(page, "中身20").evaluate((line) => line.scrollIntoView({ block: "center" }));
  await expect
    .poll(async () => Math.abs(await belowHeader(page, "箱の見出し")))
    .toBeLessThanOrEqual(1);
  await button.click();
  await expect(block(page, "箱の見出し").locator(".bn-toggle-wrapper")).toHaveAttribute(
    "data-show-children",
    "false",
  );
  await expect
    .poll(async () => Math.abs(await belowHeader(page, "箱の見出し")))
    .toBeLessThanOrEqual(1);
  await expect(block(page, "後1")).toBeInViewport();
});

test("⌘/Ctrl+Enter anywhere inside a toggle closes it, and in its line opens it again", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "a keyboard");
  await longToggle(page, 40, 40);
  const lines = await outline(page);
  await block(page, "中身30").evaluate((line) => line.scrollIntoView({ block: "center" }));
  await toEnd(page, "中身30");
  await page.keyboard.press("ControlOrMeta+Enter");
  const wrapper = block(page, "箱の見出し").locator(".bn-toggle-wrapper");
  await expect(wrapper).toHaveAttribute("data-show-children", "false");
  // In view, and the caret at the end of its line, nothing else changed.
  await expect
    .poll(async () => Math.abs(await belowHeader(page, "箱の見出し")))
    .toBeLessThanOrEqual(1);
  await page.keyboard.type("続き");
  await expect
    .poll(() => outline(page))
    .toEqual(["toggleListItem:箱の見出し続き", ...lines.slice(1)]);

  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(block(page, "箱の見出し続き").locator(".bn-toggle-wrapper")).toHaveAttribute(
    "data-show-children",
    "true",
  );
  await expect(block(page, "中身1")).toBeVisible();
  expect(await outline(page)).toEqual(["toggleListItem:箱の見出し続き", ...lines.slice(1)]);
});

/**
 * A note with an open toggle 外 holding an open toggle 内 of 40 lines, then
 * lines after each.
 */
async function nestedToggles(page: Page) {
  await toggleNote(page, "外");
  await flip(page, "外");
  await block(page, "外").locator(".bn-toggle-add-block-button").click();
  await page.keyboard.type("/折りたたみリスト");
  await expect(page.getByRole("option", { name: /折りたたみリスト/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type("内");
  await flip(page, "内");
  await block(page, "内").locator(".bn-toggle-add-block-button").click();
  const type = async (prefix: string, count: number) => {
    for (let i = 1; i <= count; i += 1) {
      if (i > 1) await page.keyboard.press("Enter");
      await page.keyboard.type(`${prefix}${i}`);
    }
    // Out of the toggle it is in: an empty line, Enter again.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
  };
  await type("内の中", 40);
  await type("外の後", 10);
  await type("後", 40);
  await expect
    .poll(async () => (await outline(page)).slice(0, 3))
    .toEqual(["toggleListItem:外", "  toggleListItem:内", "    paragraph:内の中1"]);
}

/** Where a line's top is, against the bottom of another's, on the screen. */
const belowLine = (page: Page, text: string, above: string) =>
  editor(page).evaluate(
    (root, [text, above]) => {
      const line = (of: string) =>
        [...root.querySelectorAll(".bn-block-content")].find(
          (content) => content.querySelector(".bn-inline-content")?.textContent === of,
        )!;
      return Math.round(
        line(text).getBoundingClientRect().top - line(above).getBoundingClientRect().bottom,
      );
    },
    [text, above],
  );

/** Whether a toggle's ▼ is what is there to be pressed, on the screen. */
const pressable = (page: Page, text: string) =>
  block(page, text)
    .locator(".bn-toggle-button")
    .evaluate((button) => {
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return hit?.closest(".bn-toggle-button") === button;
    });

test("one open toggle inside another stays below the other's line, both ▼ in reach, and is not hidden under it closed", async ({
  page,
}) => {
  await nestedToggles(page);
  await block(page, "内の中20").evaluate((line) => line.scrollIntoView({ block: "center" }));
  await expect.poll(async () => Math.abs(await belowHeader(page, "外"))).toBeLessThanOrEqual(1);
  await expect.poll(async () => Math.abs(await belowLine(page, "内", "外"))).toBeLessThanOrEqual(1);
  expect(await pressable(page, "外")).toBe(true);
  expect(await pressable(page, "内")).toBe(true);

  await block(page, "内").locator(".bn-toggle-button").click();
  await expect(block(page, "内").locator(".bn-toggle-wrapper")).toHaveAttribute(
    "data-show-children",
    "false",
  );
  await expect.poll(() => belowLine(page, "内", "外")).toBeGreaterThanOrEqual(0);
  expect(await pressable(page, "内")).toBe(true);
  expect(await pressable(page, "外")).toBe(true);
});

test("the caret moved up by the keys under a line kept at the top is brought out from under it", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "a keyboard");
  await longToggle(page, 40, 5);
  await block(page, "中身30").evaluate((line) => line.scrollIntoView({ block: "center" }));
  await toEnd(page, "中身30");
  await expect
    .poll(async () => Math.abs(await belowHeader(page, "箱の見出し")))
    .toBeLessThanOrEqual(1);
  /** Where the caret's top is, against the bottom of the toggle's line. */
  const caretBelow = () =>
    block(page, "箱の見出し").evaluate((line) => {
      const range = getSelection()!.getRangeAt(0);
      const caret = range.getClientRects()[0] ?? range.getBoundingClientRect();
      return Math.round(caret.top - line.getBoundingClientRect().bottom);
    });
  for (let i = 0; i < 20; i += 1) {
    await page.keyboard.press("ArrowUp");
    await expect.poll(caretBelow).toBeGreaterThanOrEqual(0);
  }
  // Up as far as 中身10, and kept in sight all the way.
  await page.keyboard.press("End");
  await page.keyboard.type("ここ");
  await expect(block(page, "中身10ここ")).toBeVisible();
});

test("a line made inside a toggle scrolled up out of sight comes into sight, not under its line", async ({
  page,
}) => {
  await longToggle(page, 40, 40);
  await block(page, "中身20").evaluate((line) => line.scrollIntoView({ block: "center" }));
  await toEnd(page, "中身20");
  // Past its end: it, and the caret in it, up out of sight.
  await block(page, "後30").evaluate((line) => line.scrollIntoView({ block: "center" }));
  await expect.poll(() => belowHeader(page, "箱の見出し")).toBeLessThan(-100);
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await caretLine(page, "箱の見出し")).below)
    .toBeGreaterThanOrEqual(0);
  expect((await caretLine(page, "箱の見出し")).onScreen).toBe(true);
  await expect
    .poll(async () => Math.abs(await belowHeader(page, "箱の見出し")))
    .toBeLessThanOrEqual(1);
});

test("while something is dragged over the note, the lines kept at the top are let go", async ({
  page,
}) => {
  await longToggle(page, 40, 5);
  await block(page, "中身20").evaluate((line) => line.scrollIntoView({ block: "center" }));
  await expect
    .poll(async () => Math.abs(await belowHeader(page, "箱の見出し")))
    .toBeLessThanOrEqual(1);
  const position = () =>
    block(page, "箱の見出し").evaluate((line) => getComputedStyle(line).position);
  // As the browser has a drag over it: dropped on a line kept at the top, a
  // block would go by where its toggle starts, out of sight above.
  const dragOver = () =>
    block(page, "中身20").evaluate((line) =>
      line.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true })),
    );
  await dragOver();
  await expect.poll(position).toBe("static");
  await page.evaluate(() => document.dispatchEvent(new DragEvent("dragend", { bubbles: true })));
  await expect.poll(position).toBe("sticky");
  // Gone with no word of it (dragged out of the window): back by itself.
  await dragOver();
  await expect.poll(position).toBe("static");
  await expect.poll(position).toBe("sticky");
});

test("a toggle kept at the top inside a coloured block keeps the block's colour", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "a mouse");
  await signUp(page);
  await openApp(page);
  await createNote(page, "色");
  await editor(page).click();
  await page.keyboard.type("親");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/折りたたみリスト");
  await expect(page.getByRole("option", { name: /折りたたみリスト/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type("子トグル");
  // Inside 親.
  await page.keyboard.press("Tab");
  await flip(page, "子トグル");
  await block(page, "子トグル").locator(".bn-toggle-add-block-button").click();
  for (let i = 1; i <= 40; i += 1) {
    if (i > 1) await page.keyboard.press("Enter");
    await page.keyboard.type(`子の中${i}`);
  }
  await expect
    .poll(async () => (await outline(page)).slice(0, 3))
    .toEqual(["paragraph:親", "  toggleListItem:子トグル", "    paragraph:子の中1"]);

  // 親 made grey, by its handle's menu.
  await block(page, "親").evaluate((line) => line.scrollIntoView({ block: "center" }));
  await block(page, "親").hover();
  await page.locator(HANDLE).first().click();
  await page.getByRole("menuitem", { name: "色を変更" }).click();
  // The second グレー: 背景色's, after 文字色's.
  await page
    .getByRole("menu", { name: "色を変更" })
    .getByRole("menuitemcheckbox", { name: "グレー" })
    .last()
    .click();
  await expect(block(page, "親")).toHaveAttribute("data-background-color", "gray");
  await page.keyboard.press("Escape");

  await block(page, "子の中20").evaluate((line) => line.scrollIntoView({ block: "center" }));
  await expect
    .poll(async () => Math.abs(await belowHeader(page, "子トグル")))
    .toBeLessThanOrEqual(1);
  const grey = await block(page, "親").evaluate(
    (line) => getComputedStyle(line.parentElement!).backgroundColor,
  );
  const [line, editorBackground] = await backgrounds(page, "子トグル");
  expect(grey).not.toBe(editorBackground);
  expect(line).toBe(grey);
});
