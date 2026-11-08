import { expect, test } from "vitest";
import { caretShift } from "@/components/editor/caret-above-keyboard";

// A phone 800 px tall, its keyboard covering the lower 300 px.
const visible = { top: 0, bottom: 500 };

test("a caret under the keyboard: the page scrolls up by what it is under by, and a little", () => {
  expect(caretShift({ top: 712, bottom: 732 }, visible)).toBe(240);
});

test("a caret in sight: nothing", () => {
  expect(caretShift({ top: 300, bottom: 320 }, visible)).toBe(0);
  expect(caretShift({ top: 472, bottom: 492 }, visible)).toBe(0);
});

test("a caret above what is seen (the page pinched up): down to it", () => {
  expect(caretShift({ top: -30, bottom: -10 }, { top: 0, bottom: 500 })).toBe(-38);
});
