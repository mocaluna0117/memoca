"use client";

import { useCallback, useSyncExternalStore } from "react";

/** One ticking clock for each period, shared by all who follow it. */
type Clock = { listeners: Set<() => void>; timer: ReturnType<typeof setInterval> | null; now: number };
const clocks = new Map<number, Clock>();

const floored = (period: number) => Math.floor(Date.now() / period) * period;

function clockOf(period: number): Clock {
  let clock = clocks.get(period);
  if (!clock) {
    clock = { listeners: new Set(), timer: null, now: floored(period) };
    clocks.set(period, clock);
  }
  return clock;
}

function tick(clock: Clock, period: number) {
  const now = floored(period);
  if (now === clock.now) return;
  clock.now = now;
  for (const listener of clock.listeners) listener();
}

/** Ticking while anyone follows it and the page is in sight; still otherwise. */
function run(clock: Clock, period: number) {
  const wanted = clock.listeners.size > 0 && document.visibilityState !== "hidden";
  if (wanted && clock.timer === null) {
    clock.timer = setInterval(() => tick(clock, period), period);
  } else if (!wanted && clock.timer !== null) {
    clearInterval(clock.timer);
    clock.timer = null;
  }
}

/**
 * The time, to the nearest `period` (ms), drawn again as it passes: for a
 * list whose rows say how long ago each note was changed ("3 分前"), which
 * otherwise said so only when the list was drawn for some other reason, and
 * went stale on a quiet screen. One timer for all who follow the same
 * period, stopped while the page is out of sight, and caught up as it
 * comes back.
 */
export function useClock(period: number): number {
  const subscribe = useCallback(
    (listener: () => void) => {
      const clock = clockOf(period);
      clock.listeners.add(listener);
      const onVisibility = () => {
        if (document.visibilityState !== "hidden") tick(clock, period);
        run(clock, period);
      };
      document.addEventListener("visibilitychange", onVisibility);
      tick(clock, period);
      run(clock, period);
      return () => {
        clock.listeners.delete(listener);
        document.removeEventListener("visibilitychange", onVisibility);
        run(clock, period);
      };
    },
    [period],
  );
  const snapshot = useCallback(() => clockOf(period).now, [period]);
  const onServer = useCallback(() => floored(period), [period]);
  return useSyncExternalStore(subscribe, snapshot, onServer);
}
