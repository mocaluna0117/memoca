import { expect, type Locator, type Page } from "@playwright/test";
import { editor } from "./helpers";
import { readTable } from "./local-db";

type Point = { x: number; y: number };
export type Rgb = [number, number, number];

/** Top-left red, top-right blue, bottom-left green, bottom-right yellow. */
export const QUADRANTS = {
  red: [255, 0, 0],
  blue: [0, 0, 255],
  green: [0, 255, 0],
  yellow: [255, 255, 0],
};

/** The images in the note body, not the one inside the crop dialog. */
export const noteImages = (page: Page) =>
  page.locator('[data-content-type="image"] img.bn-visual-media');

/**
 * Pastes a generated image whose four quadrants are different colours, so a
 * crop shows in the pixels and not just the size. Goes through the editor's
 * own paste handling, as a screenshot pasted from the clipboard would.
 */
export async function pasteImage(
  page: Page,
  { width = 400, height = 300, name = "e2e.png" } = {},
): Promise<Locator> {
  await editor(page).click();
  await editor(page).evaluate(
    async (target, options) => {
      const canvas = document.createElement("canvas");
      canvas.width = options.width;
      canvas.height = options.height;
      const context = canvas.getContext("2d")!;
      const halfWidth = options.width / 2;
      const halfHeight = options.height / 2;
      const fills: [string, number, number][] = [
        ["#ff0000", 0, 0],
        ["#0000ff", halfWidth, 0],
        ["#00ff00", 0, halfHeight],
        ["#ffff00", halfWidth, halfHeight],
      ];
      for (const [fill, x, y] of fills) {
        context.fillStyle = fill;
        context.fillRect(x, y, halfWidth, halfHeight);
      }
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((result) => resolve(result!), "image/png"),
      );
      const data = new DataTransfer();
      data.items.add(new File([blob], options.name, { type: "image/png" }));
      target.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    },
    { width, height, name },
  );
  const image = noteImages(page).last();
  await expect.poll(() => natural(image), { timeout: 20_000 }).toEqual({ w: width, h: height });
  return image;
}

/** Pastes HTML into the note, as copying a block out of another note does. */
export async function pasteHtml(page: Page, html: string): Promise<void> {
  await editor(page).click();
  await editor(page).evaluate((target, markup) => {
    const data = new DataTransfer();
    data.setData("text/html", markup);
    target.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, html);
}

/**
 * Makes the page see an on-screen keyboard covering the bottom of the
 * window, through the visual viewport the app reads it from. The phones
 * Playwright emulates never raise one.
 */
export async function raiseKeyboard(page: Page, covered = 300): Promise<void> {
  await page.evaluate((height) => {
    const viewport = window.visualViewport!;
    Object.defineProperty(viewport, "height", {
      configurable: true,
      get: () => window.innerHeight - height,
    });
    viewport.dispatchEvent(new Event("resize"));
  }, covered);
}

/** Whether a press at this point would land on the element, and not on something over it. */
export const hits = (target: Locator, point: Point) =>
  target.evaluate((element, { x, y }) => {
    const hit = document.elementFromPoint(x, y);
    return hit !== null && (hit === element || element.contains(hit));
  }, point);

/** Whether the whole box is inside the window. */
export const onScreen = (page: Page, box: { x: number; y: number; width: number; height: number }) => {
  const { width, height } = page.viewportSize()!;
  return box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height;
};

export const natural = (image: Locator) =>
  image.evaluate((element: HTMLImageElement) => ({
    w: element.naturalWidth,
    h: element.naturalHeight,
  }));

/**
 * The colour just inside each corner, clockwise from the top left. Only for
 * an image shown from a blob: URL, which is same-origin; a server URL would
 * taint the canvas.
 */
export const corners = (image: Locator) =>
  image.evaluate((element: HTMLImageElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(element, 0, 0);
    // A few pixels in: lossy encoding softens the very edge.
    const at = (x: number, y: number) =>
      Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3)) as [number, number, number];
    const right = canvas.width - 4;
    const bottom = canvas.height - 4;
    return [at(3, 3), at(right, 3), at(right, bottom), at(3, bottom)];
  });

/** Close enough to a colour after lossy encoding. */
export function near(actual: number[], expected: number[]): boolean {
  return actual.every((channel, i) => Math.abs(channel - expected[i]!) <= 40);
}

/**
 * Drags from one point to another: with the mouse on a computer, with a
 * finger on a phone, through Chromium's real touch input so that
 * touch-action and pointer capture behave as on a device.
 */
export async function drag(page: Page, from: Point, to: Point, { steps = 12 } = {}) {
  const touch = (page.viewportSize()?.width ?? 1280) < 768;
  if (!touch) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps });
    await page.mouse.up();
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps },
      ],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

export const centre = (box: { x: number; y: number; width: number; height: number }): Point => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

/** Waits until every staged file has been uploaded. */
export async function uploadsDrained(page: Page): Promise<void> {
  await expect
    .poll(async () => (await readTable(page, "pendingUploads")).length, { timeout: 45_000 })
    .toBe(0);
}
