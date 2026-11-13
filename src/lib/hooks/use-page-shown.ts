"use client";

import { useSyncExternalStore } from "react";

const subscribe = (listener: () => void) => {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};
const shown = () => document.visibilityState !== "hidden";

/**
 * Whether the page is in sight: not a window put away (the desktop app's
 * two windows are kept loaded, hidden, while the other is used), nor a tab
 * behind another. Drawn again as it changes.
 */
export function usePageShown(): boolean {
  return useSyncExternalStore(subscribe, shown, () => true);
}
