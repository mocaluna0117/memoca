import type { Page } from "@playwright/test";

export type Point = { x: number; y: number };

type SwipeOptions = {
  steps?: number;
  /** Time between moves as the page sees it. */
  stepMs?: number;
  /** How long the finger rests at `to` before it lifts. */
  holdMs?: number;
  /** false: the finger stays down at `to`; the returned function lifts it. */
  release?: boolean;
};

/**
 * Drags one finger from `from` to `to` through Chromium's own touch input, so
 * the page sees real touch and pointer events and scrolls natively when
 * nothing stops it. `page.touchscreen` can only tap.
 *
 * Every event carries its own timestamp, so the speed and timing the page
 * measures are the ones asked for here, however slowly a busy machine
 * delivers them.
 */
export async function swipe(
  page: Page,
  from: Point,
  to: Point,
  { steps = 12, stepMs = 16, holdMs = 0, release = true }: SwipeOptions = {},
): Promise<() => Promise<void>> {
  const cdp = await page.context().newCDPSession(page);
  const start = Date.now() / 1_000;
  const touch = (
    type: "touchStart" | "touchMove" | "touchEnd",
    touchPoints: Point[],
    atMs: number,
  ) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints, timestamp: start + atMs / 1_000 });

  await touch("touchStart", [from], 0);
  for (let i = 1; i <= steps; i += 1) {
    const at = {
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
    };
    await touch("touchMove", [at], i * stepMs);
    // Real time too, so the page gets frames to draw in between.
    await page.waitForTimeout(8);
  }
  const lift = async () => {
    await touch("touchEnd", [], steps * stepMs + holdMs);
    await cdp.detach();
  };
  if (release) await lift();
  return lift;
}
