import { expect, type Page, test } from "@playwright/test";
import {
  createNote,
  folderPanel,
  hideFolders,
  openApp,
  showList,
  signIn,
  signUp,
  waitForSynced,
} from "./helpers";

/** Adds a top-level folder and names it, with the keyboard, as in VS Code. */
async function addFolder(page: Page, name: string) {
  const panel = await folderPanel(page);
  await panel.getByRole("button", { name: "フォルダを追加" }).click();
  await panel.getByRole("button", { name: "新しいフォルダ", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
  await expect(panel.getByRole("button", { name, exact: true })).toBeVisible();
  await hideFolders(page);
}

/** Opens a list from the sidebar (or the drawer): a folder, すべてのメモ or ピン留め. */
async function openList(page: Page, name: string) {
  const panel = await folderPanel(page);
  await panel
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .first()
    .click();
  await hideFolders(page);
}

/** A note's row in the list on screen. */
const row = (page: Page, name: string) =>
  page.locator("[data-note-row]").filter({ visible: true }).filter({ hasText: name });

/** The names in the list, top to bottom, those pinned marked 📌. */
const names = (page: Page) =>
  page
    .locator("[data-note-row]")
    .filter({ visible: true })
    .evaluateAll((rows) =>
      rows.map(
        (each) =>
          `${each.querySelector(".lucide-pin") ? "📌" : ""}${each.querySelector(".truncate")?.textContent}`,
      ),
    );

/** Pins or unpins a note by its row's menu (a right click). */
async function pinByMenu(page: Page, name: string, item: string | RegExp) {
  await row(page, name).click({ button: "right" });
  await page.getByRole("menuitem", { name: item, exact: true }).click();
}

test.describe("pinning, on a computer", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "a mouse");
  });

  test("a row's menu pins a note first among the pinned, several at once, and unpins them", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    for (const name of ["一", "二", "三", "四"]) await createNote(page, name);
    await pinByMenu(page, "一", "ピン留め");
    await expect.poll(() => names(page)).toEqual(["📌一", "四", "三", "二"]);
    await pinByMenu(page, "二", "ピン留め");
    await expect.poll(() => names(page)).toEqual(["📌二", "📌一", "四", "三"]);

    // Two chosen: pinned together, in their order, first.
    await row(page, "四").click({ modifiers: ["ControlOrMeta"] });
    await row(page, "三").click({ modifiers: ["ControlOrMeta"] });
    await pinByMenu(page, "三", "2 件をピン留め");
    await expect.poll(() => names(page)).toEqual(["📌四", "📌三", "📌二", "📌一"]);

    await pinByMenu(page, "二", "ピン留めを外す");
    await expect.poll(() => names(page)).toEqual(["📌四", "📌三", "📌一", "二"]);
    // Its row, drawn again unpinned, still has focus: the list's keys go on working.
    await expect(row(page, "二")).toBeFocused();

    // Two chosen anew (the two before no longer), pinned: unpinned together.
    await page.keyboard.press("Escape");
    await row(page, "四").click({ modifiers: ["ControlOrMeta"] });
    await row(page, "一").click({ modifiers: ["ControlOrMeta"] });
    await pinByMenu(page, "一", "2 件のピン留めを外す");
    await expect.poll(() => names(page)).toEqual(["📌三", "四", "二", "一"]);
    await page.keyboard.press("Escape");

    // By the keys: the row, drawn again pinned (or not), keeps focus.
    await row(page, "二").focus();
    await page.keyboard.press("Shift+F10");
    await page.getByRole("menuitem", { name: "ピン留め", exact: true }).click();
    await expect.poll(() => names(page)).toEqual(["📌二", "📌三", "四", "一"]);
    await expect(row(page, "二")).toBeFocused();
    await page.keyboard.press("Shift+F10");
    await page.getByRole("menuitem", { name: "ピン留めを外す", exact: true }).click();
    await expect.poll(() => names(page)).toEqual(["📌三", "四", "二", "一"]);
    await expect(row(page, "二")).toBeFocused();
  });

  test("the pinned are placed by hand, by a drag or Option and the arrows, whatever the list's order, on every device", async ({
    page,
    browser,
  }) => {
    const email = await signUp(page);
    await openApp(page);
    for (const name of ["一", "二", "三"]) await createNote(page, name);
    await pinByMenu(page, "一", "ピン留め");
    await pinByMenu(page, "二", "ピン留め");
    // Another device, open from before: it hears of each change as it comes.
    await waitForSynced(page);
    const other = await browser.newPage();
    await signIn(other, email);
    await openApp(other);
    await expect.poll(() => names(other), { timeout: 30_000 }).toEqual(["📌二", "📌一", "三"]);
    await expect(page.getByRole("button", { name: "並び順（更新順）" })).toBeVisible();
    await expect.poll(() => names(page)).toEqual(["📌二", "📌一", "三"]);

    // Dragged below the other.
    const from = (await row(page, "二").boundingBox())!;
    const to = (await row(page, "一").boundingBox())!;
    await page.mouse.move(from.x + 40, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + 40, to.y + to.height - 4, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => names(page)).toEqual(["📌一", "📌二", "三"]);

    // And back up, by the keys.
    await row(page, "二").focus();
    await page.keyboard.press("Alt+ArrowUp");
    await expect.poll(() => names(page)).toEqual(["📌二", "📌一", "三"]);
    await page.keyboard.press("Alt+ArrowDown");
    await expect.poll(() => names(page)).toEqual(["📌一", "📌二", "三"]);

    // Kept, and the same on the other device. (一 above 二 is not the order
    // the one pinned last first would give: it is the place that came.)
    await waitForSynced(page);
    await page.reload();
    await expect.poll(() => names(page), { timeout: 25_000 }).toEqual(["📌一", "📌二", "三"]);
    await expect.poll(() => names(other), { timeout: 30_000 }).toEqual(["📌一", "📌二", "三"]);
    await other.close();
  });

  test("ピン留め lists the pinned of every folder, in their order, and a note made there is pinned", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await addFolder(page, "仕事");
    await createNote(page, "仕事のメモ");
    await createNote(page, "ピンなし");
    await openList(page, "Inbox");
    await createNote(page, "受信のメモ");
    await pinByMenu(page, "受信のメモ", "ピン留め");
    // Pinned last, though written before: first among the pinned.
    await openList(page, "仕事");
    await pinByMenu(page, "仕事のメモ", "ピン留め");

    await openList(page, "ピン留め");
    await expect(page.getByRole("heading", { name: "ピン留め", level: 2 })).toBeVisible();
    await expect.poll(() => names(page)).toEqual(["📌仕事のメモ", "📌受信のメモ"]);
    // No order to choose: theirs.
    await expect(page.getByRole("button", { name: /^並び順/ })).toHaveCount(0);

    // Made here: pinned, first, in Inbox.
    await page.getByRole("button", { name: "新しいメモ" }).first().click();
    await page.getByLabel("メモのタイトル").fill("ここで作った");
    await expect
      .poll(() => names(page))
      .toEqual(["📌ここで作った", "📌仕事のメモ", "📌受信のメモ"]);
    await openList(page, "Inbox");
    await expect.poll(() => names(page)).toEqual(["📌ここで作った", "📌受信のメモ"]);

    // すべてのメモ: the pinned first there too, in their order.
    await openList(page, "すべてのメモ");
    await expect
      .poll(() => names(page))
      .toEqual(["📌ここで作った", "📌仕事のメモ", "📌受信のメモ", "ピンなし"]);

    // Unpinned in the pinned view: it leaves, focus on the row now in its place.
    await openList(page, "ピン留め");
    await row(page, "仕事のメモ").focus();
    await page.keyboard.press("Shift+F10");
    await page.getByRole("menuitem", { name: "ピン留めを外す", exact: true }).click();
    await expect.poll(() => names(page)).toEqual(["📌ここで作った", "📌受信のメモ"]);
    await expect(row(page, "受信のメモ")).toBeFocused();
  });

  test("ピン留め with none pinned says how to pin", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await openList(page, "ピン留め");
    await expect(page.getByText("ピン留めしたメモはありません")).toBeVisible();
    await expect(page.getByText(/メモのメニューの「ピン留め」で/)).toBeVisible();
  });
});

/** Holds a finger on something, still, and lets go. */
async function longPress(page: Page, name: string) {
  const box = (await row(page, name).boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const point = { x: box.x + 60, y: box.y + box.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(900);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

test("on a phone, a long press pins a note, and ピン留め in the drawer lists it", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "a finger");
  await signUp(page);
  await openApp(page);
  await createNote(page, "一");
  await createNote(page, "二");
  await showList(page);
  await longPress(page, "一");
  await page.getByRole("menuitem", { name: "ピン留め" }).click();
  await expect.poll(() => names(page)).toEqual(["📌一", "二"]);
  // Pinned, held down it is dragged among the pinned: let go, its menu.
  await longPress(page, "一");
  await expect(page.getByRole("menuitem", { name: "ピン留めを外す" })).toBeVisible();
  await page.keyboard.press("Escape");

  await openList(page, "ピン留め");
  await expect.poll(() => names(page)).toEqual(["📌一"]);
});
