"use client";

import { useEffect } from "react";
import { layerOpen } from "@/lib/ui/unstick-pointer";

/**
 * Whether an Esc puts Memoca's own window away, in the desktop app, as the
 * quick note's Esc does: one nothing else took. Not one closing a layer
 * (Radix's dialogs and menus take it, and say so: defaultPrevented), nor
 * one stopping something of the page's that says so (choosing notes, a
 * rename, the find bar), nor one of an input method choosing a word, nor
 * one with a modifier held or held down.
 */
export function escapeHidesWindow(event: KeyboardEvent, root: ParentNode = document): boolean {
  if (event.key !== "Escape" || event.defaultPrevented || event.repeat) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  return !layerOpen(root);
}

/**
 * In the desktop app's window for the whole of Memoca: Esc puts it away,
 * kept as it is for the next time (desktop/src-tauri/src/app_window.rs).
 * Heard last, on the window as the key bubbles up, after the page's own.
 * Nothing in a browser, or in an app before 0.4.17.
 */
export function useEscapeHidesWindow() {
  useEffect(() => {
    const shell = window.memocaShell;
    if (!shell?.hideWindow) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!escapeHidesWindow(event)) return;
      event.preventDefault();
      shell.hideWindow?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
