"use client";

import { useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * Reads a browser-only value without a hydration mismatch and without an
 * effect that sets state on mount. The server snapshot is what renders on the
 * server and during hydration; the real value takes over immediately after.
 */
export function useClientValue<T>(read: () => T, serverValue: T): T {
  return useSyncExternalStore(noopSubscribe, read, () => serverValue);
}

function subscribeToMedia(query: string) {
  return (onChange: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  };
}

export function useMediaQuery(query: string, serverValue = false): boolean {
  return useSyncExternalStore(
    subscribeToMedia(query),
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}
