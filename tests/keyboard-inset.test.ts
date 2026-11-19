import { describe, expect, test } from "vitest";
import { keyboardOf } from "@/lib/hooks/use-keyboard-inset";

describe("the on-screen keyboard, from what of the window is seen", () => {
  test("none up: the window all seen, or near enough, or nothing that takes typing focused", () => {
    expect(keyboardOf(844, 844, 844, 0, true)).toEqual({ height: 0, covered: 0 });
    expect(keyboardOf(844, 844, 810, 0, true)).toEqual({ height: 0, covered: 0 });
    // Safari's bars shown again, the window shorter, nothing being typed in.
    expect(keyboardOf(844, 760, 760, 0, false)).toEqual({ height: 0, covered: 0 });
  });

  test("up, what is seen at the window's top: it covers all it is tall", () => {
    expect(keyboardOf(844, 844, 508, 0, true)).toEqual({ height: 336, covered: 336 });
  });

  test("what is seen moved down to the page's end: as tall, covering less, then none", () => {
    // Its height, which the room after the note goes by, stays as it is.
    expect(keyboardOf(844, 844, 508, 200, true)).toEqual({ height: 336, covered: 136 });
    expect(keyboardOf(844, 844, 508, 336, true)).toEqual({ height: 336, covered: 0 });
    // iOS's bounce past the end: no less than none.
    expect(keyboardOf(844, 844, 508, 360, true)).toEqual({ height: 336, covered: 0 });
  });

  test("iOS making the window as short as what is seen, scrolled: still up, the window's foot on it", () => {
    // Read against the window as it was now, it was taken for none: the
    // bottom bar came out over the keyboard, and the block bar went.
    expect(keyboardOf(844, 508, 508, 0, true)).toEqual({ height: 336, covered: 0 });
  });
});
