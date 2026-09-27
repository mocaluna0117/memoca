"use client";

import { useSyncExternalStore } from "react";

/** The part of the window that can be seen, in CSS pixels from the top of the page. */
export type VisibleArea = { height: number; top: number };

let last: VisibleArea | null = null;

function read(): VisibleArea | null {
  const viewport = window.visualViewport;
  // Zoomed in, what is seen is a part of the page by choice: left as it is.
  if (!viewport || viewport.scale > 1.01) return null;
  if (!last || last.height !== viewport.height || last.top !== viewport.offsetTop) {
    last = { height: viewport.height, top: viewport.offsetTop };
  }
  return last;
}

function subscribe(onChange: () => void): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  viewport.addEventListener("resize", onChange);
  viewport.addEventListener("scroll", onChange);
  return () => {
    viewport.removeEventListener("resize", onChange);
    viewport.removeEventListener("scroll", onChange);
  };
}

/**
 * The part of the window that can be seen: on a phone, what its on-screen
 * keyboard leaves. iOS does not make the page shorter for its keyboard; it
 * pans what is seen across the page instead, to where the caret is, and
 * anything pinned to the top of the page, a header say, is panned out of
 * sight. Sized and placed by this, it stays where it is seen. Null on the
 * server, where the browser does not tell, and while zoomed in.
 */
export function useVisibleArea(): VisibleArea | null {
  return useSyncExternalStore(subscribe, read, () => null);
}
