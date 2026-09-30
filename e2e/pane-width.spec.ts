import { expect, type Page, test } from "@playwright/test";
import { createNote, folderPanel, openApp, signUp } from "./helpers";

const SIDEBAR = "サイドバーの幅";
const LIST = "メモ一覧の幅";

const edge = (page: Page, name: string) => page.getByRole("separator", { name });

/** The width on the screen of the pane an edge is the edge of. */
const paneWidth = (page: Page, name: string) =>
  edge(page, name).evaluate((it) => Math.round(it.parentElement!.getBoundingClientRect().width));

/** The width kept on this device, if one is. */
const kept = (page: Page, key: string) => page.evaluate((key) => localStorage.getItem(key), key);

/** Drags an edge sideways by `dx`, from its middle. */
async function drag(page: Page, name: string, dx: number) {
  const box = (await edge(page, name).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
}

test.describe("the widths of the sidebar and the note list", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "a computer's screen, set with a mouse");
  });

  test("are set by dragging their edge, and kept on this device", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    expect(await paneWidth(page, SIDEBAR)).toBe(256);
    expect(await paneWidth(page, LIST)).toBe(320);

    await drag(page, SIDEBAR, 64);
    await drag(page, LIST, 80);
    expect(await paneWidth(page, SIDEBAR)).toBe(320);
    expect(await paneWidth(page, LIST)).toBe(400);

    // Opening a note leaves the list as wide.
    await createNote(page, "幅");
    expect(await paneWidth(page, LIST)).toBe(400);

    await page.reload();
    await expect(edge(page, SIDEBAR)).toBeVisible();
    expect(await paneWidth(page, SIDEBAR)).toBe(320);
    expect(await paneWidth(page, LIST)).toBe(400);

    // No narrower or wider than each allows.
    await drag(page, SIDEBAR, -500);
    expect(await paneWidth(page, SIDEBAR)).toBe(200);
    await drag(page, LIST, -500);
    expect(await paneWidth(page, LIST)).toBe(240);

    // A double click puts it back as it started, for good.
    await edge(page, SIDEBAR).dblclick();
    expect(await paneWidth(page, SIDEBAR)).toBe(256);
    expect(await kept(page, "memoca:width:sidebar")).toBeNull();
    await page.reload();
    await expect(edge(page, SIDEBAR)).toBeVisible();
    expect(await paneWidth(page, SIDEBAR)).toBe(256);
    expect(await paneWidth(page, LIST)).toBe(240);
  });

  test("a click on the edge, not a drag, changes nothing", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await drag(page, LIST, 2);
    expect(await paneWidth(page, LIST)).toBe(320);
    expect(await kept(page, "memoca:width:list")).toBeNull();
  });

  test("are set with the keyboard too", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    const list = edge(page, LIST);
    await list.focus();
    await page.keyboard.press("ArrowRight");
    expect(await paneWidth(page, LIST)).toBe(336);
    await expect(list).toHaveAttribute("aria-valuenow", "336");
    await page.keyboard.press("Shift+ArrowLeft");
    expect(await paneWidth(page, LIST)).toBe(272);
    await page.keyboard.press("Home");
    expect(await paneWidth(page, LIST)).toBe(240);
    // As wide as this window lets it be: 36% of 1280.
    await page.keyboard.press("End");
    const widest = String(Math.round(1280 * 0.36));
    expect(String(await paneWidth(page, LIST))).toBe(widest);
    await expect(list).toHaveAttribute("aria-valuenow", widest);
    await expect(list).toHaveAttribute("aria-valuemax", widest);
    await page.keyboard.press("Enter");
    expect(await paneWidth(page, LIST)).toBe(320);
  });

  test("a narrow window keeps room for the note, and the widths set for a wider one", async ({
    page,
  }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "狭い窓");
    const note = () =>
      page
        .locator(`section:right-of(#note-list-pane)`)
        .first()
        .evaluate((it) => Math.round(it.getBoundingClientRect().width));
    // Set as wide as they go, in a window wide enough for it.
    await page.setViewportSize({ width: 1600, height: 720 });
    await drag(page, SIDEBAR, 400);
    await drag(page, LIST, 400);
    expect(await kept(page, "memoca:width:sidebar")).toBe("400");
    expect(await kept(page, "memoca:width:list")).toBe("560");

    await page.setViewportSize({ width: 900, height: 720 });
    // Their width as they start at the least, and no more than the window allows.
    expect(await paneWidth(page, SIDEBAR)).toBe(256);
    expect(await paneWidth(page, LIST)).toBe(324);
    expect(await note()).toBeGreaterThanOrEqual(318);
    await expect(edge(page, LIST)).toHaveAttribute("aria-valuenow", "324");

    // Wider, while as wide as it can be here: the width set stays.
    await edge(page, LIST).focus();
    await page.keyboard.press("ArrowRight");
    await drag(page, LIST, 40);
    expect(await kept(page, "memoca:width:list")).toBe("560");
    // And shown as set, once there is room for it.
    await page.setViewportSize({ width: 1600, height: 720 });
    expect(await paneWidth(page, LIST)).toBe(560);
    await page.setViewportSize({ width: 900, height: 720 });
    // Narrower: from what is shown.
    await drag(page, LIST, -20);
    expect(await paneWidth(page, LIST)).toBe(304);

    await page.setViewportSize({ width: 1280, height: 720 });
    expect(await paneWidth(page, SIDEBAR)).toBe(Math.round(1280 * 0.28));
    expect(await paneWidth(page, LIST)).toBe(304);
  });

  test("a long folder name is cut short with …, the folder's menu in sight", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    await drag(page, SIDEBAR, -500);
    const panel = await folderPanel(page);
    await panel.getByRole("button", { name: "フォルダを追加" }).click();
    await panel.getByRole("button", { name: "新しいフォルダ", exact: true }).focus();
    await page.keyboard.press("Enter");
    const name = "とても長いフォルダの名前がサイドバーの幅に収まらない";
    await page.keyboard.type(name);
    await page.keyboard.press("Enter");
    const menu = panel.getByRole("button", { name: `${name} の操作` });
    await expect(menu).toBeAttached();
    const sidebar = (await page.locator("#sidebar-pane").boundingBox())!;
    const box = (await menu.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(sidebar.x + sidebar.width);
  });

  test("the note list's scroll bar is still the scroll bar, next to the edge", async ({ page }) => {
    await signUp(page);
    await openApp(page);
    const hits = await page.evaluate(() => {
      const list = document.getElementById("note-list-pane")!.getBoundingClientRect();
      const sidebar = document.getElementById("sidebar-pane")!.getBoundingClientRect();
      const at = (x: number, y: number) =>
        document.elementFromPoint(x, y)?.closest('[role="separator"]') !== null;
      // Where each pane's scroll bar is: the 10 pixels inside its right edge,
      // short of its border.
      const inside = (box: DOMRect) =>
        [2, 4, 6, 8, 10].map((dx) => at(box.right - dx, box.top + box.height / 2));
      return {
        list: inside(list),
        sidebar: inside(sidebar),
        edge: at(list.right + 2, list.top + list.height / 2),
      };
    });
    expect(hits.list).toEqual([false, false, false, false, false]);
    expect(hits.sidebar).toEqual([false, false, false, false, false]);
    expect(hits.edge).toBe(true);
  });
});

test("a phone has no edges to drag", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "a phone's screen");
  await signUp(page);
  await openApp(page);
  // The list is on the screen; its edge is not.
  await expect(page.locator("#note-list-pane")).toBeVisible();
  await expect(edge(page, LIST)).toBeHidden();
});
