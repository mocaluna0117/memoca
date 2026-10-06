"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * How the sidebar shows a folder's notes: inside the folder, in the tree, as
 * VS Code's explorer shows files ("explorer"); or in a list beside the
 * sidebar, as Memoca did at first ("list").
 */
export type SidebarMode = "explorer" | "list";

export const SIDEBAR_MODES: readonly { value: SidebarMode; label: string }[] = [
  { value: "explorer", label: "フォルダの中に表示" },
  { value: "list", label: "横の一覧に表示" },
];

/** Where this device keeps it. */
export const SIDEBAR_MODE_KEY = "memoca:sidebar-mode";

const listeners = new Set<() => void>();

function read(): SidebarMode {
  try {
    return localStorage.getItem(SIDEBAR_MODE_KEY) === "list" ? "list" : "explorer";
  } catch {
    // Storage refused (a private window, say): as it starts.
    return "explorer";
  }
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // Another tab of the app set it.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * The sidebar's mode on this device, and a way to set it. Kept on the device,
 * as the panes' widths are: a phone and a wide screen may well want each its
 * own.
 */
export function useSidebarMode(): [SidebarMode, (mode: SidebarMode) => void] {
  const mode = useSyncExternalStore(subscribe, read, () => "explorer" as const);
  const set = useCallback((next: SidebarMode) => {
    try {
      localStorage.setItem(SIDEBAR_MODE_KEY, next);
    } catch {
      // Refused: it stays as it was.
    }
    for (const listener of listeners) listener();
  }, []);
  return [mode, set];
}
