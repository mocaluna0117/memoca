"use client";

import { useEffect } from "react";
import { newBuildOut } from "@/lib/build";
import { SHELL_HIDDEN } from "@/lib/quick/shell";
import { flushAll } from "@/lib/sync/docs";

/** How often a window kept hidden asks again whether a new version of the site is out. */
export const HIDDEN_CHECK_MS = 60 * 60 * 1000;

/**
 * Memoca's own window in the desktop shell is hidden, not closed, when
 * closed (desktop/src-tauri/src/app_window.rs), and so never loaded again
 * of itself: a new version of the site is loaded out of sight, when it is
 * put away and every hour it stays so, what is being written saved first.
 * Not while it is out again, or in use.
 */
export function useShellRefresh() {
  useEffect(() => {
    const here = window;
    let hidden = false;
    let checking = false;
    const check = async () => {
      if (!hidden || checking) return;
      checking = true;
      try {
        await flushAll();
        // Not under someone looking at it: brought out by the shell, a window
        // the system did not make the active one has no focus, and has not
        // been told it is out (no focus event), but is seen.
        if (
          (await newBuildOut()) &&
          hidden &&
          !here.document.hasFocus() &&
          here.document.visibilityState === "hidden"
        ) {
          here.location.reload();
        }
      } finally {
        checking = false;
      }
    };
    const onHidden = () => {
      hidden = true;
      void check();
    };
    const onShown = () => {
      hidden = false;
    };
    const onVisible = () => {
      if (here.document.visibilityState === "visible") onShown();
    };
    here.addEventListener(SHELL_HIDDEN, onHidden);
    here.addEventListener("focus", onShown);
    here.document.addEventListener("visibilitychange", onVisible);
    const timer = here.setInterval(() => void check(), HIDDEN_CHECK_MS);
    return () => {
      here.removeEventListener(SHELL_HIDDEN, onHidden);
      here.removeEventListener("focus", onShown);
      here.document.removeEventListener("visibilitychange", onVisible);
      here.clearInterval(timer);
    };
  }, []);
}
