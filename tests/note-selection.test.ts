import { describe, expect, test } from "vitest";
import { extendTo, rangeOf, takenWith, toggled } from "@/lib/note-selection";

const ORDER = ["a", "b", "c", "d", "e"];

describe("notes chosen in the list", () => {
  test("a range, either way, both ends in it; from one no longer there, the other alone", () => {
    expect(rangeOf(ORDER, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeOf(ORDER, "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeOf(ORDER, "c", "c")).toEqual(["c"]);
    expect(rangeOf(ORDER, "gone", "c")).toEqual(["c"]);
    expect(rangeOf(ORDER, "c", "gone")).toEqual([]);
  });

  test("a Shift and a click: from the anchor to it, with what was chosen before; again, in place of the first", () => {
    const base = new Set(["e"]);
    expect([...extendTo(base, ORDER, "a", "c")].sort()).toEqual(["a", "b", "c", "e"]);
    // From the same anchor, shorter: the range shrinks.
    expect([...extendTo(base, ORDER, "a", "b")].sort()).toEqual(["a", "b", "e"]);
  });

  test("one chosen or not, the other way, the rest as they were", () => {
    expect([...toggled(new Set(["a"]), "b")].sort()).toEqual(["a", "b"]);
    expect([...toggled(new Set(["a", "b"]), "a")]).toEqual(["b"]);
  });

  test("dragged, a chosen note takes the others along in the list's order; another, itself", () => {
    const chosen = new Set(["d", "b"]);
    expect(takenWith(ORDER, chosen, "d")).toEqual(["b", "d"]);
    expect(takenWith(ORDER, chosen, "c")).toEqual(["c"]);
    expect(takenWith(ORDER, new Set(), "a")).toEqual(["a"]);
  });
});
