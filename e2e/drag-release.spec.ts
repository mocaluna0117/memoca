import { expect, type Page, test } from "@playwright/test";
import { createNote, folderPanel, openApp, setExplorerMode, signUp, waitForSynced } from "./helpers";

/** A note's row in the sidebar's tree on screen, by its name. */
const treeNote = (page: Page, name: string) =>
  page.locator("[data-tree-note]").filter({ visible: true }).filter({ hasText: name });

/** Shown only while something is being dragged. */
const dragging = (page: Page) => page.getByText("いちばん上の階層へ移動");

/**
 * The button let go of where the page never hears it, as the Mac desktop
 * app's web view, made the key window by that very click, can do: the
 * mouseup kept from the document (where dnd-kit listens) by a listener on
 * the window, which sees it first.
 */
async function releaseUnheard(page: Page) {
  await page.evaluate(() => {
    const swallow = (event: Event) => {
      event.stopImmediatePropagation();
      removeEventListener("mouseup", swallow, true);
    };
    addEventListener("mouseup", swallow, true);
  });
  await page.mouse.up();
}

test.describe("a drag whose release was never heard", () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "a mouse");
    await signUp(page);
    await setExplorerMode(page);
    await openApp(page);
    await createNote(page, "ひとつ目");
    await createNote(page, "ふたつ目");
    await waitForSynced(page);
    await folderPanel(page);
    await expect(treeNote(page, "ふたつ目")).toBeVisible();
  });

  test("a click on a note: the pointer moved after it drags nothing", async ({ page }) => {
    const box = (await treeNote(page, "ふたつ目").boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    await page.mouse.down();
    await releaseUnheard(page);
    // Moved on, the button up: not a drag, the row left where it was.
    await page.mouse.move(box.x + 300, box.y + 200, { steps: 10 });
    await page.waitForTimeout(300);
    await expect(dragging(page)).toHaveCount(0);
    await expect(treeNote(page, "ふたつ目")).toBeVisible();
  });

  test("a drag under way: the pointer moved after it ends the drag, dropped nowhere", async ({
    page,
  }) => {
    const box = (await treeNote(page, "ふたつ目").boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + box.height / 2 + 30, { steps: 5 });
    await expect(dragging(page)).toBeVisible();
    await releaseUnheard(page);
    await page.mouse.move(box.x + 300, box.y + 200, { steps: 10 });
    await expect(dragging(page)).toHaveCount(0);
    // The next click is a click again: the note opens.
    await treeNote(page, "ひとつ目").click();
    await expect(page.getByLabel("メモのタイトル")).toHaveValue("ひとつ目");
    await expect(dragging(page)).toHaveCount(0);
  });

  test("a drag under way when the window loses focus ends", async ({ page }) => {
    const box = (await treeNote(page, "ふたつ目").boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + box.height / 2 + 30, { steps: 5 });
    await expect(dragging(page)).toBeVisible();
    // Another app, or another of Memoca's windows, made the key window.
    await page.evaluate(() => dispatchEvent(new Event("blur")));
    await expect(dragging(page)).toHaveCount(0);
    await page.mouse.up();
  });
});
