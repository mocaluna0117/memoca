"use client";

import { useSyncExternalStore } from "react";

/** The part of the window that can be seen, in CSS pixels from the top of the page. */
export type VisibleArea = { height: number; top: number };

let last: VisibleArea | null = null;
/** The window's own height, as the page is laid out in it, read with the rest. */
let layout = 0;
/** The viewport it was read from, and whether it has said it moved since. */
let readFrom: VisualViewport | null = null;
let stale = true;

/**
 * What is seen, read again only once the viewport has said it moved: read,
 * it has the browser lay the page out first, which a key just typed has
 * left to do, and React reads it each time what uses it is drawn.
 */
function read(): VisibleArea | null {
  const viewport = window.visualViewport;
  if (!stale && viewport === readFrom) return last;
  stale = false;
  readFrom = viewport;
  // Zoomed in, what is seen is a part of the page by choice: left as it is.
  if (!viewport || viewport.scale > 1.01) return (last = null);
  layout = document.documentElement.clientHeight;
  if (!last || last.height !== viewport.height || last.top !== viewport.offsetTop) {
    last = { height: viewport.height, top: viewport.offsetTop };
  }
  return last;
}

/** The window's height as the page is laid out in it, read when what is seen last was. */
export function layoutHeight(): number {
  return layout;
}

function subscribe(onChange: () => void): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  // Read again from now: it may have moved while nothing followed it.
  stale = true;
  const moved = () => {
    stale = true;
    onChange();
  };
  viewport.addEventListener("resize", moved);
  viewport.addEventListener("scroll", moved);
  return () => {
    viewport.removeEventListener("resize", moved);
    viewport.removeEventListener("scroll", moved);
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
