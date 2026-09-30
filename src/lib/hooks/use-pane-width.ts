"use client";

import { useCallback, useSyncExternalStore } from "react";

/** A pane whose width can be set by dragging its edge, on a computer's screen. */
export type Pane = {
  /** The pane's element's id. */
  id: string;
  /** Where this device keeps its width. */
  key: string;
  /** Its width until one is set, in CSS pixels. */
  initial: number;
  min: number;
  max: number;
  /**
   * How much of the window it may take, beyond its initial width: a narrow
   * window keeps room for the note, whatever width is set.
   */
  share: number;
};

export const SIDEBAR: Pane = {
  id: "sidebar-pane",
  key: "memoca:width:sidebar",
  initial: 256,
  min: 200,
  max: 400,
  share: 0.28,
};
export const NOTE_LIST: Pane = {
  id: "note-list-pane",
  key: "memoca:width:list",
  initial: 320,
  min: 240,
  max: 560,
  share: 0.36,
};

/** Keeps a width within what the pane allows. */
export const clampWidth = (pane: Pane, width: number) =>
  Math.round(Math.min(pane.max, Math.max(pane.min, width)));

/** The widest a pane is shown in a window this wide, whatever width is set. */
export const widestIn = (pane: Pane, windowWidth: number) =>
  Math.min(pane.max, Math.max(pane.initial, windowWidth * pane.share));

const listeners = new Set<() => void>();

function stored(pane: Pane): number {
  try {
    const value = Number(localStorage.getItem(pane.key));
    return value ? clampWidth(pane, value) : pane.initial;
  } catch {
    // Storage refused (a private window, say): the width as it starts.
    return pane.initial;
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
 * A pane's width, as set on this device, and a way to set it (or, with
 * null, to go back to the width it starts at). Kept in this browser only: a
 * phone and a computer have different room. The server's page, and the
 * first render, have the width it starts at.
 */
export function usePaneWidth(pane: Pane): [number, (width: number | null) => void] {
  const width = useSyncExternalStore(
    subscribe,
    () => stored(pane),
    () => pane.initial,
  );
  const set = useCallback(
    (next: number | null) => {
      try {
        if (next === null) localStorage.removeItem(pane.key);
        else localStorage.setItem(pane.key, String(clampWidth(pane, next)));
      } catch {
        // Refused: it stays as it was.
      }
      for (const listener of listeners) listener();
    },
    [pane],
  );
  return [width, set];
}
