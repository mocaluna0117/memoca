"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect } from "react";

/** The quick note's own window, as the web app opens it: one, reused. */
const QUICK_WINDOW = {
  url: "/quick?window=1",
  name: "memoca-quick",
  features: "popup,width=380,height=460",
};

/** From this width a window of its own: a phone's browser would open a tab. */
const WIDE = "(min-width: 768px)";

/**
 * Opens the quick note: in a small window of its own on a computer, or as a
 * page here where there is no room for one, or the browser will not open one.
 * A window already open is brought forward as it is, not loaded again: what
 * is being written in it stays where it is.
 */
export function useOpenQuickNote(): () => void {
  const router = useRouter();
  return useCallback(() => {
    // Asked for by name with no address: the one already open, or a new blank one.
    const opened = window.matchMedia(WIDE).matches
      ? window.open("", QUICK_WINDOW.name, QUICK_WINDOW.features)
      : null;
    if (!opened) {
      router.push("/quick");
      return;
    }
    if (!isQuickNote(opened)) opened.location.replace(QUICK_WINDOW.url);
    opened.focus();
  }, [router]);
}

/** Whether a window of ours shows the quick note already. */
function isQuickNote(target: Window): boolean {
  try {
    return target.location.pathname === "/quick";
  } catch {
    return false;
  }
}

/** Whether a key pressed here is being typed into something. */
const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * Q opens the quick note from anywhere in the app, but for while something
 * is being typed, or a dialog is open.
 */
export function QuickNoteShortcut() {
  const openQuickNote = useOpenQuickNote();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "q" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.isComposing || event.repeat || typing(event.target)) return;
      // One still on its way out after closing counts for nothing.
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
        )
      )
        return;
      event.preventDefault();
      openQuickNote();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openQuickNote]);
  return null;
}
