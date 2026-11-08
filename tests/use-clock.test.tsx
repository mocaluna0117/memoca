import { act, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useClock } from "@/lib/hooks/use-clock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const seen: number[] = [];
let draws = 0;

function Clock({ period = 10_000 }: { period?: number }) {
  const now = useClock(period);
  // Noted once drawn, not while drawing.
  useEffect(() => {
    draws += 1;
    seen.push(now);
  });
  return null;
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  seen.length = 0;
  draws = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setVisibility("visible");
  vi.useRealTimers();
});

test("gives the time to the period, and draws again as each period passes", async () => {
  await act(() => root.render(<Clock />));
  expect(seen.at(-1)).toBe(1_000_000);
  await act(() => vi.advanceTimersByTime(10_000));
  expect(seen.at(-1)).toBe(1_010_000);
  const drawn = draws;
  await act(() => vi.advanceTimersByTime(3_000));
  expect(draws).toBe(drawn);
});

test("stops while the page is out of sight, and catches up as it comes back", async () => {
  await act(() => root.render(<Clock />));
  await act(() => setVisibility("hidden"));
  const drawn = draws;
  await act(() => vi.advanceTimersByTime(30_000));
  expect(draws).toBe(drawn);
  await act(() => setVisibility("visible"));
  expect(seen.at(-1)).toBe(1_030_000);
});

test("two following the same period share one timer", async () => {
  const spy = vi.spyOn(globalThis, "setInterval");
  await act(() =>
    root.render(
      <>
        <Clock />
        <Clock />
      </>,
    ),
  );
  expect(spy).toHaveBeenCalledTimes(1);
});
