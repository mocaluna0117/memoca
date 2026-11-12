import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { QuickTabs, type QuickTab } from "@/components/notes/quick-tabs";
import { QuickTips } from "@/components/notes/quick-tip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

const tabs: QuickTab[] = Array.from({ length: 12 }, (_, at) => ({
  id: `t${at}`,
  text: `タブ${at + 1}`,
  images: 0,
  unsaved: false,
}));

beforeEach(async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <QuickTips>
        <QuickTabs
          tabs={tabs}
          active="t0"
          onShow={() => {}}
          onOpen={() => {}}
          onClose={() => {}}
          onOpenTodo={() => {}}
        />
      </QuickTips>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

/** The strip, as wide as `shown` with tabs `wide` across (jsdom lays nothing out). */
function strip(shown: number, wide: number) {
  const element = host.querySelector<HTMLElement>('[role="tablist"]')!;
  Object.defineProperty(element, "clientWidth", { value: shown, configurable: true });
  Object.defineProperty(element, "scrollWidth", { value: wide, configurable: true });
  let left = 0;
  Object.defineProperty(element, "scrollLeft", {
    configurable: true,
    get: () => left,
    set: (value: number) => {
      left = Math.max(0, Math.min(wide - shown, value));
    },
  });
  return element;
}
const turn = (element: HTMLElement, init: WheelEventInit) => {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  element.dispatchEvent(event);
  return event;
};

describe("the quick note's tabs, more than fit", () => {
  test("a mouse's wheel turned over them scrolls them sideways, and not the page", () => {
    const element = strip(300, 1000);
    const down = turn(element, { deltaY: 100 });
    expect(element.scrollLeft).toBe(100);
    expect(down.defaultPrevented).toBe(true);
    turn(element, { deltaY: -40 });
    expect(element.scrollLeft).toBe(60);
  });

  test("a wheel that counts in lines (Firefox's) goes as far as one in pixels", () => {
    const element = strip(300, 1000);
    turn(element, { deltaY: 3, deltaMode: 1 });
    expect(element.scrollLeft).toBe(48);
  });

  test("a sideways swipe, Shift with the wheel, and the end of the tabs are left to the browser", () => {
    const element = strip(300, 1000);
    expect(turn(element, { deltaX: 80, deltaY: 10 }).defaultPrevented).toBe(false);
    expect(turn(element, { deltaY: 100, shiftKey: true }).defaultPrevented).toBe(false);
    expect(element.scrollLeft).toBe(0);
    // At the start already: nothing to scroll back to.
    expect(turn(element, { deltaY: -100 }).defaultPrevented).toBe(false);
  });

  test("all of them fitting, the wheel is left as it is", () => {
    const element = strip(1000, 1000);
    expect(turn(element, { deltaY: 100 }).defaultPrevented).toBe(false);
    expect(element.scrollLeft).toBe(0);
  });
});
