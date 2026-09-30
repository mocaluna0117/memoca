import { expect, type Page, test } from "@playwright/test";
import {
  createNote,
  editor,
  folderPanel,
  hideFolders,
  openApp,
  showList,
  signUp,
  waitForSynced,
} from "./helpers";
import { patchRow, readTable } from "./local-db";
import { createVaultInSettings, enterVaultPassword } from "./vault-helpers";

/** The notes of the list, by the name each row shows, top first. */
const listed = (page: Page) =>
  page
    .locator("[data-note-row]")
    .evaluateAll((rows) =>
      rows.map((row) => row.querySelector("span > span:last-child")?.textContent ?? ""),
    );

/** Opens the Inbox's own list, where notes can be placed by hand. */
async function openInbox(page: Page) {
  const panel = await folderPanel(page);
  await panel.getByRole("button", { name: "Inbox", exact: true }).click();
  await hideFolders(page);
  await showList(page);
  await expect(page.getByRole("heading", { name: "Inbox" }).first()).toBeVisible();
}

/** Chooses how the list is ordered. */
async function orderBy(page: Page, label: string) {
  await page
    .getByRole("button", { name: /^並び順/ })
    .first()
    .click();
  await page.getByRole("menuitemradio", { name: label }).click();
  await expect(page.getByRole("button", { name: `並び順（${label}）` }).first()).toBeVisible();
}

/** Three notes, made in turn: いちご, あんず, うめ; then いちご written in, last. */
async function threeNotes(page: Page) {
  await signUp(page);
  await openApp(page);
  await openInbox(page);
  for (const title of ["いちご", "あんず", "うめ"]) await createNote(page, title);
  await showList(page);
  await page.locator("[data-note-row]", { hasText: "いちご" }).click();
  await editor(page).click();
  await page.keyboard.type("書き足し");
  await waitForSynced(page);
  await showList(page);
}

test.describe("the order of a folder's notes", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "chosen and dragged with a mouse");
  });

  test("is chosen: last changed, last made, or by name", async ({ page }) => {
    await threeNotes(page);
    await expect.poll(() => listed(page)).toEqual(["いちご", "うめ", "あんず"]);
    await orderBy(page, "作成順");
    await expect.poll(() => listed(page)).toEqual(["うめ", "あんず", "いちご"]);
    await orderBy(page, "タイトル順");
    await expect.poll(() => listed(page)).toEqual(["あんず", "いちご", "うめ"]);
    // Kept for the folder, on this device.
    await page.reload();
    await expect
      .poll(() => listed(page), { timeout: 25_000 })
      .toEqual(["あんず", "いちご", "うめ"]);
    // All notes are ordered on their own, and not by hand.
    await (await folderPanel(page)).getByRole("button", { name: "すべてのメモ" }).click();
    await page
      .getByRole("button", { name: /^並び順/ })
      .first()
      .click();
    await expect(page.getByRole("menuitemradio", { name: "手動" })).toHaveCount(0);
    await expect(page.getByRole("menuitemradio", { name: "更新順" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test("is set by hand: dragged, or moved with Option and the arrows, and kept", async ({
    page,
  }) => {
    await threeNotes(page);
    await orderBy(page, "手動");
    // As made: the newest first.
    await expect.poll(() => listed(page)).toEqual(["うめ", "あんず", "いちご"]);

    // The last dragged to the top.
    const last = (await page.locator("[data-note-row]", { hasText: "いちご" }).boundingBox())!;
    const first = (await page.locator("[data-note-row]", { hasText: "うめ" }).boundingBox())!;
    await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2);
    await page.mouse.down();
    await page.mouse.move(first.x + first.width / 2, first.y + 4, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => listed(page)).toEqual(["いちご", "うめ", "あんず"]);

    // Down one with the keys, still focused after.
    const top = page.locator("[data-note-row]", { hasText: "いちご" });
    await top.focus();
    await page.keyboard.press("Alt+ArrowDown");
    await expect.poll(() => listed(page)).toEqual(["うめ", "いちご", "あんず"]);
    await expect(top).toBeFocused();
    // And a screen reader is told where it went.
    await expect(
      page.locator('[aria-live="polite"]', { hasText: "いちごを 3 件中 2 番目に移動しました。" }),
    ).toHaveCount(1);

    // A new note goes first.
    await createNote(page, "かき");
    await showList(page);
    await expect.poll(() => listed(page)).toEqual(["かき", "うめ", "いちご", "あんず"]);

    await waitForSynced(page);
    await page.reload();
    await expect
      .poll(() => listed(page), { timeout: 25_000 })
      .toEqual(["かき", "うめ", "いちご", "あんず"]);
  });
});

test.describe("more of the order of a folder's notes", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "chosen and dragged with a mouse");
  });

  test("by name, a locked note by its title with the vault open, and as locked with it closed", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createVaultInSettings(page);
    await openApp(page);
    await openInbox(page);
    for (const title of ["あめ", "いちご", "うめ"]) await createNote(page, title);
    await page.locator("[data-note-row]", { hasText: "あめ" }).click();
    await waitForSynced(page);
    await page.getByRole("button", { name: "メモの操作" }).click();
    await page.getByRole("menuitem", { name: "ロックする", exact: true }).click();
    await enterVaultPassword(page, "ロックする");
    await expect(page.getByText("メモをロックしました")).toBeVisible({ timeout: 30_000 });
    await showList(page);
    await orderBy(page, "タイトル順");
    // Its title decrypted: あめ, first, where as locked it would be last.
    await expect.poll(() => listed(page)).toEqual(["あめ", "いちご", "うめ"]);
    // The vault closed with the page: shown as locked, and ordered as that.
    await page.reload();
    await expect
      .poll(() => listed(page), { timeout: 25_000 })
      .toEqual(["いちご", "うめ", "ロックされたメモ"]);
  });

  test("pinned notes stay above the others, and a note dragged down goes below the one it is let go on", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await openInbox(page);
    for (const title of ["いち", "に", "さん", "し"]) await createNote(page, title);
    for (const title of ["いち", "に"]) {
      await showList(page);
      await page.locator("[data-note-row]", { hasText: new RegExp(`^${title}`) }).click();
      await page.getByRole("button", { name: "メモの操作" }).click();
      await page.getByRole("menuitem", { name: "ピン留め", exact: true }).click();
    }
    await showList(page);
    await orderBy(page, "手動");
    await expect.poll(() => listed(page)).toEqual(["に", "いち", "し", "さん"]);

    const drag = async (moving: string, onto: string) => {
      const from = (await page
        .locator("[data-note-row]", { hasText: new RegExp(`^${moving}`) })
        .boundingBox())!;
      const to = (await page
        .locator("[data-note-row]", { hasText: new RegExp(`^${onto}`) })
        .boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height - 4, { steps: 12 });
      await page.mouse.up();
    };
    // A pinned note dragged down among the others: the last of the pinned,
    // not among them.
    await drag("に", "さん");
    await expect.poll(() => listed(page)).toEqual(["いち", "に", "し", "さん"]);
    // Down among the others: below the one it is let go on.
    await drag("し", "さん");
    await expect.poll(() => listed(page)).toEqual(["いち", "に", "さん", "し"]);
  });

  test("moved between two that share a key, it goes there, and they are told apart", async ({
    page,
  }) => {
    await threeNotes(page);
    await orderBy(page, "手動");
    await expect.poll(() => listed(page)).toEqual(["うめ", "あんず", "いちご"]);
    // Two sharing a key, as two devices making a note at once leave them.
    const notes = await readTable<{ noteId: string; title: string; sortKey: string }>(
      page,
      "notes",
    );
    const byTitle = (title: string) => notes.find((note) => note.title === title)!;
    await patchRow(page, "notes", byTitle("あんず").noteId, { sortKey: byTitle("うめ").sortKey });
    await page.reload();
    await expect.poll(() => listed(page), { timeout: 25_000 }).toHaveLength(3);
    const [top, second] = await listed(page);
    // いちご, last, up one: between the two.
    const last = page.locator("[data-note-row]", { hasText: "いちご" });
    await last.focus();
    await page.keyboard.press("Alt+ArrowUp");
    await expect.poll(() => listed(page)).toEqual([top, "いちご", second]);
    // Each its own key now, in the order shown.
    await expect
      .poll(async () => {
        const rows = await readTable<{ title: string; sortKey: string }>(page, "notes");
        const keys = [top!, "いちご", second!].map(
          (title) => rows.find((row) => row.title === title)!.sortKey,
        );
        return new Set(keys).size === 3 && [...keys].sort().join() === keys.join();
      })
      .toBe(true);
  });
});

test("on a phone, a note held down and dragged moves", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "a finger on a phone");
  await threeNotes(page);
  await orderBy(page, "手動");
  await expect.poll(() => listed(page)).toEqual(["うめ", "あんず", "いちご"]);
  const last = (await page.locator("[data-note-row]", { hasText: "いちご" }).boundingBox())!;
  const first = (await page.locator("[data-note-row]", { hasText: "うめ" }).boundingBox())!;
  const x = last.x + last.width / 2;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", y: number) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y }],
    });
  await touch("touchStart", last.y + last.height / 2);
  // Held past the time a swipe would open the folder drawer, before it moves.
  await page.waitForTimeout(800);
  for (let step = 1; step <= 12; step += 1) {
    const y = last.y + last.height / 2 + ((first.y + 4 - (last.y + last.height / 2)) * step) / 12;
    await touch("touchMove", y);
  }
  await touch("touchEnd", first.y + 4);
  await cdp.detach();
  await expect.poll(() => listed(page)).toEqual(["いちご", "うめ", "あんず"]);
});
