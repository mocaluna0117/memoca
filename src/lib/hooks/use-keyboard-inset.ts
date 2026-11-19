"use client";

import { useEffect, useState } from "react";

/** Less of the window covered than this is no keyboard (a browser's bar, say). */
const KEYBOARD_MIN = 40;

/** The on-screen keyboard, as a page laid out under it has to take it. */
export type Keyboard = {
  /**
   * How tall it is: 0 with none up. As long as it is up this stays as it
   * is, however what is seen is moved: what a page leaves room for, and
   * whether a bar for it is shown, goes by this.
   */
  height: number;
  /**
   * How much of the bottom of the window (the layout viewport, which
   * `position: fixed` goes by) it covers now: where a bar sits on it. Less
   * as iOS moves what is seen down the window, scrolled past the page's end.
   */
  covered: number;
};

const NONE: Keyboard = { height: 0, covered: 0 };

/**
 * The keyboard, from the window's height and what of it is seen (the
 * visual viewport: its height and how far down the window it is). iOS does
 * not make the window shorter for its keyboard: what is seen is shorter,
 * and is moved down the window as the page is scrolled to its end.
 *
 * The keyboard's height was once read as what it covers, which goes down as
 * what is seen moves: the page's room for it went with it, the page grew
 * shorter under the finger, iOS moved what is seen back up, and the room
 * grew again. A note scrolled with the keyboard up shook and went no
 * further down (2026-11-19).
 */
export function keyboardOf(windowHeight: number, seenHeight: number, seenTop: number): Keyboard {
  const height = windowHeight - seenHeight;
  if (height < KEYBOARD_MIN) return NONE;
  return { height, covered: Math.max(0, height - Math.max(0, seenTop)) };
}

/** The keyboard, as it is now (see {@link keyboardOf}); none where the browser does not say. */
export function useKeyboard(): Keyboard {
  const [keyboard, setKeyboard] = useState<Keyboard>(NONE);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const now = keyboardOf(window.innerHeight, viewport.height, viewport.offsetTop);
      setKeyboard((before) => (before.height === now.height && before.covered === now.covered ? before : now));
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);

  return keyboard;
}

/**
 * How much of the window the on-screen keyboard is covering: where something
 * pinned to the bottom of the window sits to be above it (0 with none up).
 *
 * `position: fixed` does not account for the software keyboard on iOS, so a
 * bar pinned to the bottom ends up underneath it. The visual viewport reports
 * the actually visible area, which is what the bar has to sit on.
 */
export function useKeyboardInset(): number {
  return useKeyboard().covered;
}
