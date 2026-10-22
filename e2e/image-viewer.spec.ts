import { expect, type Locator, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, signUp, waitForSynced } from "./helpers";
import { centre, drag, natural, noteImages, pasteImage, uploadsDrained } from "./image-helpers";
import { readTable } from "./local-db";
import { createVaultInSettings, enterVaultPassword } from "./vault-helpers";

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;

/** The viewer of the image pasted as e2e.png. */
const viewer = (page: Page) => page.getByRole("dialog", { name: "e2e.png" });
const shownIn = (dialog: Locator) => dialog.getByRole("img", { name: "e2e.png" });

/** Whether the whole box is inside the window. */
const inWindow = (page: Page, box: { x: number; y: number; width: number; height: number }) => {
  const { width, height } = page.viewportSize()!;
  return (
    box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1
  );
};

/** Two taps of a finger, as quickly as a person makes them. */
async function doubleTap(page: Page, target: Locator) {
  const point = centre((await target.boundingBox())!);
  await page.touchscreen.tap(point.x, point.y);
  await page.touchscreen.tap(point.x, point.y);
}

/** Locks the open note (as pdf-preview.spec.ts does). */
async function lockTheNote(page: Page) {
  const body = (await editor(page).boundingBox())!;
  await editor(page).click({ position: { x: body.width / 2, y: body.height - 8 } });
  await page.getByRole("button", { name: "メモの操作" }).filter({ visible: true }).click();
  await page.getByRole("menuitem", { name: "ロックする", exact: true }).click();
  await enterVaultPassword(page, "ロックする");
  await expect(page.getByText("メモをロックしました")).toBeVisible({ timeout: 30_000 });
  await waitForSynced(page);
}

test.describe("an image in a note, double-clicked", () => {
  test("opens over the whole window, fitted, at its own size at a click, and closes with Esc, × or a click beside it", async ({
    page,
  }) => {
    test.skip(isPhone(page), "a finger's double tap: below");
    test.slow();
    await signUp(page);
    await openApp(page);
    await createNote(page, "写真");
    // Larger than the window, which it is made to fit.
    const image = await pasteImage(page, { width: 1600, height: 1200 });

    await image.dblclick();
    const dialog = viewer(page);
    await expect(dialog).toBeVisible();
    const shown = shownIn(dialog);
    await expect.poll(() => natural(shown)).toEqual({ w: 1600, h: 1200 });
    const fitted = (await shown.boundingBox())!;
    expect(inWindow(page, fitted)).toBe(true);
    expect(fitted.width).toBeLessThan(1600);
    // The focus is in the viewer, and kept there.
    await expect(dialog.getByRole("button", { name: "閉じる" })).toBeFocused();
    for (let i = 0; i < 5; i += 1) await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

    // A click shows it at its own size, and another fits it again.
    await shown.click();
    await expect.poll(async () => Math.round((await shown.boundingBox())!.width)).toBe(1600);
    await shown.click();
    await expect
      .poll(async () => Math.round((await shown.boundingBox())!.width))
      .toBe(Math.round(fitted.width));

    // ダウンロード saves the file the note holds, under its name.
    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "ダウンロード" }).click();
    expect((await download).suggestedFilename()).toMatch(/^e2e\.(png|webp)$/);

    // Esc closes, and the keyboard is back in the note.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(editor(page)).toBeFocused();

    await image.dblclick();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "閉じる" }).click();
    await expect(dialog).toBeHidden();

    // A click beside the image, on the backdrop.
    await image.dblclick();
    await expect(dialog).toBeVisible();
    const { height } = page.viewportSize()!;
    await page.mouse.click(8, height - 8);
    await expect(dialog).toBeHidden();
  });

  test("leaves BlockNote's own clicks as they were", async ({ page }) => {
    test.skip(isPhone(page), "a hovering mouse and a double-click");
    test.slow();
    await signUp(page);
    await openApp(page);
    await createNote(page, "写真", "前の行 です");
    await page.keyboard.press("Enter");
    const image = await pasteImage(page);
    const dialog = viewer(page);

    // One click chooses the image, with BlockNote's toolbar over it.
    await image.click();
    await expect(page.getByRole("button", { name: "トリミング", exact: true })).toBeVisible();
    await page.waitForTimeout(600);
    await expect(dialog).toHaveCount(0);

    // A caption, set from that toolbar, is not the image.
    await page.getByRole("button", { name: "キャプションを編集" }).click();
    await page.getByPlaceholder("キャプションを編集").fill("海の写真");
    await page.keyboard.press("Enter");
    const caption = page.locator('[data-content-type="image"] figcaption');
    await expect(caption).toHaveText("海の写真");
    await caption.dblclick();
    await page.waitForTimeout(600);
    await expect(dialog).toHaveCount(0);

    // A word double-clicked is chosen, as before.
    const line = page
      .locator('[data-content-type="paragraph"]')
      .filter({ hasText: "前の行" })
      .first();
    await line.getByText("前の行 です").dblclick({ position: { x: 4, y: 8 } });
    await expect.poll(() => page.evaluate(() => getSelection()?.toString() ?? "")).not.toBe("");
    await expect(dialog).toHaveCount(0);

    // The resize handle still resizes, and opens nothing.
    const before = (await noteImages(page).first().boundingBox())!.width;
    await image.hover();
    const handle = page.locator('[data-content-type="image"] .bn-resize-handle').last();
    await expect(handle).toBeVisible();
    const grip = centre((await handle.boundingBox())!);
    await drag(page, grip, { x: grip.x - before / 2, y: grip.y });
    await expect
      .poll(async () => Math.round((await noteImages(page).first().boundingBox())!.width))
      .toBeLessThan(Math.round(before) - 50);
    await expect(dialog).toHaveCount(0);
  });

  test("in a locked note, shows the image decrypted here", async ({ page }) => {
    test.skip(isPhone(page), "the lock is the same on a phone");
    test.slow();
    await signUp(page);
    await openApp(page);
    await createVaultInSettings(page);
    await openApp(page);
    await createNote(page, "秘密の写真");
    await lockTheNote(page);
    await pasteImage(page);
    await uploadsDrained(page);
    // From the server, as another device would show it: decrypted here.
    await page.reload();
    await page
      .getByRole("button", { name: "金庫を開く", exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await enterVaultPassword(page, "開く");
    const image = noteImages(page).first();
    await expect.poll(() => natural(image), { timeout: 30_000 }).toEqual({ w: 400, h: 300 });

    await image.dblclick();
    const shown = shownIn(viewer(page));
    await expect.poll(() => natural(shown)).toEqual({ w: 400, h: 300 });
    expect(await shown.getAttribute("src")).toMatch(/^blob:/);
    // Nothing of it kept on the device in plaintext.
    expect(await readTable(page, "blobs")).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(viewer(page)).toBeHidden();
  });
});

test.describe("an image in a note, on a phone", () => {
  test("opens at a double tap, not at a tap or a scroll", async ({ page }) => {
    test.skip(!isPhone(page), "a finger");
    test.slow();
    await signUp(page);
    await openApp(page);
    await createNote(page, "写真");
    const image = await pasteImage(page);
    const dialog = viewer(page);

    // A tap chooses it, as before.
    await image.tap();
    await page.waitForTimeout(600);
    await expect(dialog).toHaveCount(0);

    // A finger drawn over it scrolls, and opens nothing.
    const middle = centre((await image.boundingBox())!);
    await drag(page, middle, { x: middle.x, y: middle.y - 80 });
    await drag(page, middle, { x: middle.x, y: middle.y - 80 });
    await page.waitForTimeout(600);
    await expect(dialog).toHaveCount(0);

    await doubleTap(page, image);
    await expect(dialog).toBeVisible();
    await expect.poll(() => natural(shownIn(dialog))).toEqual({ w: 400, h: 300 });
    expect(inWindow(page, (await shownIn(dialog).boundingBox())!)).toBe(true);
    await dialog.getByRole("button", { name: "閉じる" }).tap();
    await expect(dialog).toBeHidden();
  });
});
