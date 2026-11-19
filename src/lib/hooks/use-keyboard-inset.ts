"use client";

import { useEffect, useState } from "react";

/** Less of the window covered than this is no keyboard (a hardware keyboard's bar of shortcuts, say). */
const KEYBOARD_MIN = 40;

/** The on-screen keyboard, as a page laid out under it has to take it. */
export type Keyboard = {
  /**
   * How tall it is: 0 with none up. As long as it is up this stays as it
   * is, however what is seen is moved and the window sized: what a page
   * leaves room for, and whether a bar for it (or one it hides) is shown,
   * goes by this.
   */
  height: number;
  /**
   * How much of the bottom of the window (the layout viewport, which
   * `position: fixed` goes by) it covers now: where a bar sits on it.
   */
  covered: number;
};

const NONE: Keyboard = { height: 0, covered: 0 };

/**
 * The keyboard, from the window as tall as it has been (`tallest`), as tall
 * as it is now (`windowHeight`), what of it is seen (the visual viewport:
 * its height, and how far down the window it is), and whether something
 * that takes typing has the focus (`editing`).
 *
 * iOS does not make the window shorter for its keyboard as it comes up:
 * what is seen is shorter, and is moved down the window as the page is
 * scrolled to its end. And now and then, scrolled, it does make the window
 * as short as what is seen. Neither moves the keyboard's height, read
 * against the window at its tallest.
 *
 * Read against the window as it is now, it was taken for none once iOS
 * made the window short (the bottom bar came out over the keyboard, the
 * block bar went); and read as what it covered, it went down as what is
 * seen moved, the page's room for it with it, and a note scrolled with the
 * keyboard up shook and went no further down (2026-11-19).
 */
export function keyboardOf(
  tallest: number,
  windowHeight: number,
  seenHeight: number,
  seenTop: number,
  editing: boolean,
): Keyboard {
  if (!editing) return NONE;
  const height = Math.max(tallest, windowHeight) - seenHeight;
  if (height < KEYBOARD_MIN) return NONE;
  return { height, covered: Math.max(0, windowHeight - seenHeight - Math.max(0, seenTop)) };
}

/** Kinds of input a phone brings its keyboard up for. */
const NO_KEYBOARD = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

/** Whether what has the focus takes typing: a field, or a note's text. */
function editing(): boolean {
  const focused = document.activeElement;
  if (focused instanceof HTMLTextAreaElement) return !focused.readOnly;
  if (focused instanceof HTMLInputElement) return !focused.readOnly && !NO_KEYBOARD.has(focused.type);
  return focused instanceof HTMLElement && focused.isContentEditable;
}

/** The window at its tallest so far, at this width (a turned phone starts again). */
let tallest = 0;
let tallestAt = 0;

/** The keyboard as it is now (see {@link keyboardOf}): none where the browser does not say. */
export function keyboardNow(): Keyboard {
  const viewport = window.visualViewport;
  if (!viewport) return NONE;
  // A computer's window made shorter (its developer tools, say) is no keyboard.
  if (window.matchMedia && !window.matchMedia("(any-pointer: coarse)").matches) return NONE;
  if (window.innerWidth !== tallestAt) {
    tallestAt = window.innerWidth;
    tallest = 0;
  }
  // The window's own, and the page's frame's, which iOS may keep as it was.
  tallest = Math.max(tallest, window.innerHeight, document.documentElement.clientHeight);
  return keyboardOf(tallest, window.innerHeight, viewport.height, viewport.offsetTop, editing());
}

/** The keyboard, as it is now, followed (see {@link keyboardOf}). */
export function useKeyboard(): Keyboard {
  const [keyboard, setKeyboard] = useState<Keyboard>(NONE);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const now = keyboardNow();
      setKeyboard((before) => (before.height === now.height && before.covered === now.covered ? before : now));
    };
    // The focus moved: looked at once it has (out of one field and into the
    // next is not the keyboard going down and up).
    let frame = 0;
    const focusMoved = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("scroll", update, { passive: true });
    document.addEventListener("focusin", focusMoved);
    document.addEventListener("focusout", focusMoved);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("scroll", update);
      document.removeEventListener("focusin", focusMoved);
      document.removeEventListener("focusout", focusMoved);
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
