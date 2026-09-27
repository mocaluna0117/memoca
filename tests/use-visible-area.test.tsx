import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type VisibleArea, useVisibleArea } from "@/lib/hooks/use-visible-area";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The browser's visual viewport, as a test moves it: a keyboard coming up, iOS panning. */
type Viewport = EventTarget & { height: number; offsetTop: number; scale: number };

let viewport: Viewport;
let root: Root;
let host: HTMLDivElement;
let seen: (VisibleArea | null)[];

function Probe() {
  seen.push(useVisibleArea());
  return null;
}

beforeEach(async () => {
  viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
  Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
  seen = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Probe />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
});

const move = (change: Partial<Viewport>, event = "resize") =>
  act(async () => {
    Object.assign(viewport, change);
    viewport.dispatchEvent(new Event(event));
  });

describe("the part of the window that can be seen", () => {
  test("is all of it, until a keyboard comes up and takes the foot", async () => {
    expect(seen.at(-1)).toEqual({ height: 800, top: 0 });
    await move({ height: 430 });
    expect(seen.at(-1)).toEqual({ height: 430, top: 0 });
  });

  test("follows where iOS pans to, to show the caret", async () => {
    await move({ height: 430, offsetTop: 260 }, "scroll");
    expect(seen.at(-1)).toEqual({ height: 430, top: 260 });
  });

  test("follows a pan alone, the keyboard staying as it was: the caret going down a line", async () => {
    await move({ height: 430, offsetTop: 260 }, "scroll");
    await move({ offsetTop: 300 }, "scroll");
    expect(seen.at(-1)).toEqual({ height: 430, top: 300 });
  });

  test("lets go of the viewport once nothing uses it", async () => {
    const letGo = vi.spyOn(viewport, "removeEventListener");
    await act(async () => root.unmount());
    expect(letGo.mock.calls.map(([event]) => event).sort()).toEqual(["resize", "scroll"]);
    root = createRoot(host);
  });

  test("is not followed while zoomed in", async () => {
    await move({ height: 300, offsetTop: 100, scale: 2 });
    expect(seen.at(-1)).toBeNull();
  });

  test("the same, it is the same, so what uses it is not drawn again for nothing", async () => {
    const before = seen.length;
    await move({});
    expect(seen.length).toBe(before);
  });
});
