import { describe, expect, test } from "vitest";
import { keyboardOf } from "@/lib/hooks/use-keyboard-inset";

describe("the on-screen keyboard, from what of the window is seen", () => {
  test("none up: the window all seen, or near enough (a browser's bar)", () => {
    expect(keyboardOf(844, 844, 0)).toEqual({ height: 0, covered: 0 });
    expect(keyboardOf(844, 810, 0)).toEqual({ height: 0, covered: 0 });
  });

  test("up, what is seen at the window's top: it covers all it is tall", () => {
    expect(keyboardOf(844, 508, 0)).toEqual({ height: 336, covered: 336 });
  });

  test("what is seen moved down to the page's end: as tall, covering less, then none", () => {
    // Its height, which the room after the note goes by, stays as it is.
    expect(keyboardOf(844, 508, 200)).toEqual({ height: 336, covered: 136 });
    expect(keyboardOf(844, 508, 320)).toEqual({ height: 336, covered: 16 });
    expect(keyboardOf(844, 508, 336)).toEqual({ height: 336, covered: 0 });
    // iOS's bounce past the end: no less than none.
    expect(keyboardOf(844, 508, 360)).toEqual({ height: 336, covered: 0 });
  });
});
