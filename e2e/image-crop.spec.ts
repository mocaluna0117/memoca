import { expect, type Locator, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, signIn, signUp, waitForSynced } from "./helpers";
import {
  QUADRANTS,
  centre,
  corners,
  drag,
  hits,
  natural,
  near,
  noteImages,
  onScreen,
  pasteHtml,
  pasteImage,
  raiseKeyboard,
  uploadsDrained,
} from "./image-helpers";
import { readTable } from "./local-db";
import { createVaultInSettings, enterVaultPassword } from "./vault-helpers";

type AttachmentRow = {
  attachmentId: string;
  status: string;
  locked: boolean;
  width: number | null;
  height: number | null;
  wrappedKey?: unknown;
};

const attachments = (page: Page) => readTable<AttachmentRow>(page, "attachments");
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;
/** A finger on a phone, the mouse on a computer. */
const press = (page: Page, target: Locator) => (isPhone(page) ? target.tap() : target.click());

/** Selects the image and opens the crop dialog from the toolbar that appears over it. */
async function openCrop(page: Page, image: Locator): Promise<Locator> {
  await press(page, image);
  await press(page, page.getByRole("button", { name: "トリミング", exact: true }));
  const dialog = page.getByRole("dialog", { name: "画像をトリミング" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".ReactCrop img")).toBeVisible();
  // Only the dialog's own opening zoom: the crop outline's marching ants
  // never finish, so settle() on the whole subtree would wait forever.
  await dialog.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
  return dialog;
}

/** Drags the crop's bottom-right corner to the middle of the image, keeping its top-left quarter. */
async function keepTopLeftQuarter(page: Page, dialog: Locator): Promise<void> {
  const handle = dialog.locator(".ReactCrop__drag-handle.ord-se");
  const picture = dialog.locator(".ReactCrop img");
  await drag(page, centre((await handle.boundingBox())!), centre((await picture.boundingBox())!));
  await dialog.getByRole("button", { name: "トリミングする" }).click();
  await expect(dialog).toHaveCount(0);
}

/**
 * Every given handle, and both buttons, are inside the window and are what a
 * press where they are drawn lands on. Polled: the box sizes the image to
 * the room it has, after the window changes.
 *
 * Moves the crop a step first, since a disabled トリミングする takes no
 * presses at all; by the keyboard, because a preset would hide the edge
 * handles.
 */
async function expectInReach(page: Page, dialog: Locator, handles: string[]): Promise<void> {
  await dialog.getByLabel("左上の角。矢印キーで範囲を変えられます").focus();
  await page.keyboard.press("ArrowRight");
  await expect(dialog.getByRole("button", { name: "トリミングする" })).toBeEnabled();
  const targets: [string, Locator][] = [
    ...handles.map((ord): [string, Locator] => [
      `handle ${ord}`,
      dialog.locator(`.ReactCrop__drag-handle.ord-${ord}`),
    ]),
    ...["キャンセル", "トリミングする"].map((name): [string, Locator] => [
      name,
      dialog.getByRole("button", { name, exact: true }),
    ]),
  ];
  for (const [label, target] of targets) {
    await expect
      .poll(
        async () => {
          const box = await target.boundingBox();
          return box !== null && onScreen(page, box) && (await hits(target, centre(box)));
        },
        { message: `${label} can be pressed` },
      )
      .toBe(true);
  }
}

/** The shown image is the top-left quarter of the 400 x 300 original: about 200 x 150, all red. */
async function expectTopLeftQuarter(image: Locator): Promise<{ w: number; h: number }> {
  await expect.poll(async () => (await natural(image)).w, { timeout: 20_000 }).toBeLessThan(400);
  const size = await natural(image);
  expect(Math.abs(size.w - 200), `width ${size.w}`).toBeLessThanOrEqual(2);
  expect(Math.abs(size.h - 150), `height ${size.h}`).toBeLessThanOrEqual(2);
  expect(size.w / size.h).toBeCloseTo(4 / 3, 1);
  for (const colour of await corners(image))
    expect(near(colour, QUADRANTS.red), `${colour}`).toBe(true);
  return size;
}

test.describe("trimming an image", () => {
  test("keeps the chosen part as a new file, can be undone, and survives a reload", async ({
    page,
  }) => {
    test.slow();
    const email = await signUp(page);
    await openApp(page);
    await createNote(page, "トリミング");
    const image = await pasteImage(page);
    await expect.poll(async () => (await attachments(page)).length).toBe(1);
    const [original] = await attachments(page);

    // The dialog offers the shapes and a way back to the whole image.
    let dialog = await openCrop(page, image);
    for (const label of ["自由", "1:1", "4:3", "16:9", "リセット", "キャンセル"]) {
      await expect(dialog.getByRole("button", { name: label, exact: true })).toBeVisible();
    }
    // Nothing trimmed yet, so nothing to apply.
    const apply = dialog.getByRole("button", { name: "トリミングする" });
    await expect(apply).toBeDisabled();
    // A shape makes the largest box of that shape.
    await dialog.getByRole("button", { name: "1:1", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "1:1", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const square = (await dialog.locator(".ReactCrop__crop-selection").boundingBox())!;
    expect(Math.abs(square.width - square.height)).toBeLessThanOrEqual(1);
    await expect(apply).toBeEnabled();
    await dialog.getByRole("button", { name: "リセット" }).click();
    await expect(apply).toBeDisabled();
    // The corners move with the arrow keys too.
    await dialog.getByLabel("左上の角。矢印キーで範囲を変えられます").focus();
    await page.keyboard.press("ArrowRight");
    await expect(apply).toBeEnabled();
    await dialog.getByRole("button", { name: "リセット" }).click();
    await keepTopLeftQuarter(page, dialog);

    const size = await expectTopLeftQuarter(noteImages(page).first());
    await expect(page.locator('[data-content-type="image"]')).toHaveCount(1);
    await expect.poll(async () => (await attachments(page)).length).toBe(2);
    const first = (await attachments(page)).find(
      (row) => row.attachmentId !== original!.attachmentId,
    )!;
    expect(first).toMatchObject({ width: size.w, height: size.h, locked: false });

    // 元に戻す puts the original back; it was never deleted.
    await page.getByRole("button", { name: "元に戻す" }).click();
    await expect.poll(() => natural(noteImages(page).first())).toEqual({ w: 400, h: 300 });
    const whole = await corners(noteImages(page).first());
    const expected = [QUADRANTS.red, QUADRANTS.blue, QUADRANTS.yellow, QUADRANTS.green];
    expect(
      whole.every((colour, i) => near(colour, expected[i]!)),
      `${whole.join(" / ")}`,
    ).toBe(true);
    await expect(page.locator('[data-content-type="image"]')).toHaveCount(1);

    // The same crop again, this time kept.
    dialog = await openCrop(page, noteImages(page).first());
    await keepTopLeftQuarter(page, dialog);
    const kept = await expectTopLeftQuarter(noteImages(page).first());
    const ids = (await attachments(page)).map((row) => row.attachmentId);
    expect(ids).toHaveLength(3);
    expect(ids).toContain(original!.attachmentId);

    await uploadsDrained(page);
    await waitForSynced(page);
    await page.reload();
    await expect.poll(() => natural(noteImages(page).first()), { timeout: 30_000 }).toEqual(kept);
    await expectTopLeftQuarter(noteImages(page).first());
    await expect(page.locator('[data-content-type="image"]')).toHaveCount(1);
    await expect
      .poll(async () => (await attachments(page)).map((row) => row.status))
      .toEqual(["committed", "committed", "committed"]);

    // Another browser gets it from the server, not from this one's cache.
    const url = page.url();
    const fresh = await page
      .context()
      .browser()!
      .newContext({
        baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
        viewport: page.viewportSize(),
      });
    const other = await fresh.newPage();
    await signIn(other, email);
    await other.goto(url);
    await expect.poll(() => natural(noteImages(other).first()), { timeout: 45_000 }).toEqual(kept);
    await fresh.close();
  });

  test("a locked note's crop is uploaded encrypted and never cached in plaintext", async ({
    page,
  }) => {
    test.slow();
    await signUp(page);
    await openApp(page);
    await createVaultInSettings(page);
    // A full navigation closes the vault; locking asks for it again.
    await openApp(page);
    await createNote(page, "秘密の画像");
    await pasteImage(page);
    await uploadsDrained(page);
    await waitForSynced(page);

    // The caret under the image puts away the toolbar floating over it, which
    // on a phone covers the note's header.
    const body = (await editor(page).boundingBox())!;
    await editor(page).click({ position: { x: body.width / 2, y: body.height - 8 } });
    await page.getByRole("button", { name: "メモの操作" }).filter({ visible: true }).click();
    await page.getByRole("menuitem", { name: "ロックする", exact: true }).click();
    await enterVaultPassword(page, "ロックする");
    await expect(page.getByText("メモをロックしました")).toBeVisible({ timeout: 30_000 });
    await waitForSynced(page);
    const [original] = await attachments(page);
    await expect.poll(async () => (await attachments(page))[0]?.locked).toBe(true);

    // Shown decrypted again, then trimmed while the vault is open.
    await expect
      .poll(() => natural(noteImages(page).first()), { timeout: 30_000 })
      .toEqual({ w: 400, h: 300 });
    const dialog = await openCrop(page, noteImages(page).first());
    await keepTopLeftQuarter(page, dialog);
    const kept = await expectTopLeftQuarter(noteImages(page).first());

    await uploadsDrained(page);
    await waitForSynced(page);
    const rows = await attachments(page);
    expect(rows).toHaveLength(2);
    const cropped = rows.find((row) => row.attachmentId !== original!.attachmentId)!;
    // What the server sent back: a locked row with its own wrapped key.
    await expect
      .poll(async () => {
        const row = (await attachments(page)).find((r) => r.attachmentId === cropped.attachmentId);
        return { status: row?.status, locked: row?.locked, key: row?.wrappedKey };
      })
      .toEqual({ status: "committed", locked: true, key: { ct: "[bytes]", iv: "[bytes]" } });
    // No plaintext copy of either file stays on the device.
    expect(await readTable(page, "blobs")).toEqual([]);

    // After a reload the vault is closed; opening it decrypts the crop from the server.
    await page.reload();
    await page
      .getByRole("button", { name: "金庫を開く", exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await enterVaultPassword(page, "開く");
    await expect.poll(() => natural(noteImages(page).first()), { timeout: 30_000 }).toEqual(kept);
    await expectTopLeftQuarter(noteImages(page).first());
    expect(await readTable(page, "blobs")).toEqual([]);

    // The locked original, pasted into a note that is not locked, shows there
    // while the vault is open. A crop made there would be stored in
    // plaintext, so it is refused.
    await createNote(page, "ロックしていないメモ");
    await pasteHtml(page, `<img src="memoca://att/${original!.attachmentId}" alt="コピー">`);
    const copy = noteImages(page).first();
    await expect.poll(() => natural(copy), { timeout: 30_000 }).toEqual({ w: 400, h: 300 });
    await press(page, copy);
    await press(page, page.getByRole("button", { name: "トリミング", exact: true }));
    await expect(
      page.getByText("この画像はロックしたメモのものなので", { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole("dialog", { name: "画像をトリミング" })).toHaveCount(0);
    expect(await readTable(page, "pendingUploads")).toEqual([]);
    expect(await attachments(page)).toHaveLength(2);
  });

  test("a width set by hand shrinks with the crop at once, and ⌘Z takes the crop back in one step", async ({
    page,
  }) => {
    test.skip(isPhone(page), "BlockNote's resize handles need a hovering mouse, and ⌘Z a keyboard.");
    test.slow();
    await signUp(page);
    await openApp(page);
    await createNote(page, "幅");
    const image = await pasteImage(page);
    const shown = async () => Math.round((await noteImages(page).first().boundingBox())!.width);
    const full = await shown();

    // BlockNote's own handle, on the image's right edge while the mouse is over it.
    await image.hover();
    const handle = page.locator('[data-content-type="image"] .bn-resize-handle').last();
    await expect(handle).toBeVisible();
    const from = centre((await handle.boundingBox())!);
    await drag(page, from, { x: from.x - 100, y: from.y });
    await expect.poll(shown).toBe(full - 100);

    // Half the width is kept, so the block is half as wide: straight away in
    // this editor, not only once the note is opened again.
    await keepTopLeftQuarter(page, await openCrop(page, image));
    await expectTopLeftQuarter(noteImages(page).first());
    const half = Math.round((full - 100) / 2);
    await expect.poll(shown).toBe(half);

    // One undo brings back the original at its old width.
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => natural(noteImages(page).first())).toEqual({ w: 400, h: 300 });
    await expect.poll(shown).toBe(full - 100);
    // 元に戻す then has nothing left to do, and does not claim it failed.
    await page.getByRole("button", { name: "元に戻す" }).click();
    await page.waitForTimeout(500);
    await expect(page.getByText("元に戻せませんでした", { exact: false })).toHaveCount(0);
    expect(await natural(noteImages(page).first())).toEqual({ w: 400, h: 300 });

    // Redo puts the crop back, and it is what the note keeps. Focus only: a
    // click under the image would add a paragraph, and with it clear redo.
    await editor(page).focus();
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expectTopLeftQuarter(noteImages(page).first());
    await expect.poll(shown).toBe(half);
    await uploadsDrained(page);
    await waitForSynced(page);
    await page.reload();
    await expect
      .poll(() => natural(noteImages(page).first()), { timeout: 30_000 })
      .toEqual({ w: 200, h: 150 });
    await expect.poll(shown).toBe(half);
  });

  test("a tall image fits a short laptop screen, with every handle and button in reach", async ({
    page,
  }) => {
    test.skip(isPhone(page), "The phone's own case is the sideways test below.");
    await page.setViewportSize({ width: 1280, height: 650 });
    await signUp(page);
    await openApp(page);
    await createNote(page, "縦長");
    const image = await pasteImage(page, { width: 1200, height: 1600, name: "tall.png" });
    const dialog = await openCrop(page, image);
    await expectInReach(page, dialog, ["nw", "n", "ne", "e", "se", "s", "sw", "w"]);

    await dialog.getByRole("button", { name: "1:1", exact: true }).click();
    await dialog.getByRole("button", { name: "トリミングする" }).click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() => natural(noteImages(page).first()), { timeout: 20_000 })
      .toEqual({ w: 1200, h: 1200 });
  });

  test("on a phone turned sideways the dialog fills the screen, and its buttons stay in reach", async ({
    page,
  }) => {
    test.skip(!isPhone(page), "Needs a phone's touch screen; a computer's short screen is the test above.");
    await signUp(page);
    await openApp(page);
    await createNote(page, "横向き");
    const image = await pasteImage(page);
    const dialog = await openCrop(page, image);

    // About what is left of a Pixel 7 on its side, under the address bar.
    await page.setViewportSize({ width: 915, height: 356 });
    await expect
      .poll(async () => Object.values((await dialog.boundingBox())!).map(Math.round))
      .toEqual([0, 0, 915, 356]);
    // On a touch screen the crop box keeps only its corners.
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await expectInReach(page, dialog, ["nw", "ne", "se", "sw"]);
    // A thumb that lands a little inside a corner still takes the corner,
    // rather than moving the whole box.
    for (const [ord, dx, dy] of [
      ["nw", 1, 1],
      ["ne", -1, 1],
      ["se", -1, -1],
      ["sw", 1, -1],
    ] as const) {
      const handle = dialog.locator(`.ReactCrop__drag-handle.ord-${ord}`);
      const middle = centre((await handle.boundingBox())!);
      expect(await hits(handle, { x: middle.x + 16 * dx, y: middle.y + 16 * dy }), ord).toBe(true);
    }

    await dialog.getByRole("button", { name: "1:1", exact: true }).tap();
    await dialog.getByRole("button", { name: "トリミングする" }).tap();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() => natural(noteImages(page).first()), { timeout: 20_000 })
      .toEqual({ w: 300, h: 300 });
  });

  test("the block bar above a phone's keyboard offers only what keeps an image", async ({
    page,
  }) => {
    test.skip(!isPhone(page), "The bar is for phones, where it sits above the on-screen keyboard.");
    // A small phone: narrower than BlockNote's toolbar for an image.
    await page.setViewportSize({ width: 360, height: 740 });
    await signUp(page);
    await openApp(page);
    await createNote(page, "キーボード", "本文");
    const image = await pasteImage(page);
    await raiseKeyboard(page);
    const bar = page.getByRole("toolbar", { name: "ブロックの操作" });
    const labels = () =>
      bar.getByRole("button").evaluateAll((buttons) => buttons.map((b) => b.ariaLabel));

    // Turning an image into a heading or a list would drop it.
    await image.tap();
    await expect(bar).toBeVisible();
    await expect
      .poll(labels)
      .toEqual(["トリミング", "上へ移動", "下へ移動", "ブロックを削除"]);

    // BlockNote's toolbar over the image, one button longer for トリミング,
    // scrolls within the screen instead of making the page wider.
    const floating = page.locator(".bn-formatting-toolbar");
    await expect(floating.getByRole("button", { name: "トリミング" })).toBeVisible();
    await expect(floating.locator("xpath=..")).toHaveCSS("opacity", "1");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
    const placed = (await floating.boundingBox())!;
    expect(placed.x >= 0 && placed.x + placed.width <= 360, JSON.stringify(placed)).toBe(true);

    // Text keeps the text actions, and there is nothing to trim. The caret
    // goes up from the keyboard: BlockNote's toolbar over the image covers
    // the line above it.
    await page.keyboard.press("ArrowUp");
    await expect(bar.getByRole("button", { name: "大見出し" })).toBeVisible();
    await expect(bar.getByRole("button", { name: "トリミング" })).toHaveCount(0);

    // Off the first tap's spot: two taps this close together are a double
    // tap to the editor, which does not select the image. Straight on to the
    // bar: it must not move while BlockNote's toolbar opens.
    await image.tap({ position: { x: 24, y: 24 } });
    await bar.getByRole("button", { name: "トリミング", exact: true }).tap();
    const dialog = page.getByRole("dialog", { name: "画像をトリミング" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".ReactCrop img")).toBeVisible();
    await dialog.getByRole("button", { name: "キャンセル" }).tap();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('[data-content-type="image"]')).toHaveCount(1);
  });
});
