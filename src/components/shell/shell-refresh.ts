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
        if ((await newBuildOut()) && hidden && !here.document.hasFocus()) {
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
    here.addEventListener(SHELL_HIDDEN, onHidden);
    here.addEventListener("focus", onShown);
    const timer = here.setInterval(() => void check(), HIDDEN_CHECK_MS);
    return () => {
      here.removeEventListener(SHELL_HIDDEN, onHidden);
      here.removeEventListener("focus", onShown);
      here.clearInterval(timer);
    };
  }, []);
}
