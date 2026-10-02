import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  KEPT,
  forgetPlaces,
  placeAt,
  placeOf,
  rememberPlace,
  scrollToPlace,
} from "@/lib/note-place";

const lines = [
  { id: "a", top: -300, bottom: -100 },
  { id: "b", top: -100, bottom: 40 },
  { id: "c", top: 40, bottom: 80 },
];

describe("where a note was being read", () => {
  test("the first line not wholly above the top of the screen, and how far into it", () => {
    expect(placeAt(lines, 0)).toEqual({ block: "b", offset: 100 });
    expect(placeAt(lines, 40)).toEqual({ block: "c", offset: 0 });
    expect(placeAt(lines, 500)).toBeNull();
    expect(placeAt([], 0)).toBeNull();
    // The note's first line still below the top of the screen: before it.
    expect(placeAt([{ id: "a", top: 20, bottom: 40 }], 0)).toEqual({ block: "a", offset: -20 });
  });

  test("back to it: scrolled by how far the line is from where it was", () => {
    // The line now 260 px down (an image above it loaded): 360 px more.
    expect(scrollToPlace({ block: "b", offset: 100 }, 260, 0)).toBe(360);
    expect(scrollToPlace({ block: "b", offset: 100 }, -100, 0)).toBe(0);
  });
});

describe("kept on this device", () => {
  beforeEach(() => {
    localStorage.clear();
    forgetPlaces();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    forgetPlaces();
  });

  test("the last one kept for each note, in storage", () => {
    rememberPlace("n1", { block: "a", offset: 10 });
    rememberPlace("n1", { block: "b", offset: 20 });
    expect(placeOf("n1")).toEqual({ block: "b", offset: 20 });
    expect(placeOf("n2")).toBeNull();
    expect(localStorage.getItem("memoca:note-places")).toContain("n1");
  });

  test("only so many: the one read longest ago goes first, one read again kept", () => {
    for (let i = 0; i < KEPT; i += 1) rememberPlace(`n${i}`, { block: "a", offset: i });
    // Read again: the one read last, not the first to go.
    rememberPlace("n0", { block: "a", offset: 0 });
    rememberPlace(`n${KEPT}`, { block: "a", offset: KEPT });
    expect(placeOf("n0")).not.toBeNull();
    expect(placeOf("n1")).toBeNull();
    expect(placeOf(`n${KEPT}`)).toEqual({ block: "a", offset: KEPT });
  });

  test("what another tab kept meanwhile is kept too", () => {
    rememberPlace("here", { block: "a", offset: 1 });
    // Another tab of the app, writing its own.
    const stored = JSON.parse(localStorage.getItem("memoca:note-places")!) as unknown[];
    localStorage.setItem(
      "memoca:note-places",
      JSON.stringify([...stored, ["there", { block: "b", offset: 2 }]]),
    );
    rememberPlace("here", { block: "a", offset: 3 });
    expect(placeOf("there")).toEqual({ block: "b", offset: 2 });
    expect(placeOf("here")).toEqual({ block: "a", offset: 3 });
  });

  test("storage refused: kept for the session", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    rememberPlace("n1", { block: "a", offset: 5 });
    expect(placeOf("n1")).toEqual({ block: "a", offset: 5 });
  });

  test("forgotten, as the device forgets an account", () => {
    rememberPlace("n1", { block: "a", offset: 5 });
    forgetPlaces();
    expect(placeOf("n1")).toBeNull();
    expect(localStorage.getItem("memoca:note-places")).toBeNull();
  });

  test("what is stored broken, or not this, is left out, the rest kept", () => {
    localStorage.setItem(
      "memoca:note-places",
      JSON.stringify([["n1", { block: 3 }], "x", ["n2", { block: "b", offset: 4 }]]),
    );
    expect(placeOf("n1")).toBeNull();
    expect(placeOf("n2")).toEqual({ block: "b", offset: 4 });
    localStorage.setItem("memoca:note-places", "{not json");
    expect(placeOf("n2")).toBeNull();
  });
});
