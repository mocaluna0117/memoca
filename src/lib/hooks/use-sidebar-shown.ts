"use client";

import { useCallback, useSyncExternalStore } from "react";

/** Where this device keeps it: "hidden" when the sidebar is put away. */
export const SIDEBAR_SHOWN_KEY = "memoca:sidebar-shown";

const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_SHOWN_KEY) !== "hidden";
  } catch {
    // Storage refused (a private window, say): shown, as it starts.
    return true;
  }
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // Another tab of the app put it away or brought it back.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * Whether the sidebar is shown on a computer's screen, and a way to put it
 * away or bring it back. Kept on the device, as the panes' widths are; a
 * phone has its drawer instead. The server's page, and the first render,
 * have it shown.
 */
export function useSidebarShown(): [boolean, (shown: boolean) => void] {
  const shown = useSyncExternalStore(subscribe, read, () => true);
  const set = useCallback((next: boolean) => {
    try {
      if (next) localStorage.removeItem(SIDEBAR_SHOWN_KEY);
      else localStorage.setItem(SIDEBAR_SHOWN_KEY, "hidden");
    } catch {
      // Refused: it stays as it was.
    }
    for (const listener of listeners) listener();
  }, []);
  return [shown, set];
}

/**
 * Whether a key press is the one that puts the sidebar away or brings it
 * back: ⌘\ (Ctrl+\ elsewhere), as Notion has it. On a Japanese keyboard the
 * key is ¥ (IntlYen). Not while a word is being written with the input
 * method.
 */
export function isSidebarKey(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false;
  return event.code === "Backslash" || event.code === "IntlYen" || event.key === "\\";
}
