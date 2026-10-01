import { describe, expect, test } from "vitest";
import { stackRules } from "@/components/editor/stuck-toggles";

/** Each line moved down: its id, how far below the top, and its z-index. */
const moved = (css: string) =>
  [
    ...css.matchAll(
      /data-id="([^"]+)"[^{]*\{ top: calc\(var\(--memoca-sticky-top, 0px\) \+ ([\d.]+)px\); z-index: (\d+); \}/g,
    ),
  ].map(([, id, offset, z]) => `${id} ${offset} ${z}`);

describe("open toggles inside others, kept below their lines", () => {
  test("none inside another: left at the top, as the CSS has them", () => {
    expect(
      stackRules([
        { id: "a", height: 30, within: null },
        { id: "b", height: 40, within: null },
      ]),
    ).toBe("");
  });

  test("each below the lines of all it is in, a pixel over them, under them as it goes", () => {
    const css = stackRules([
      { id: "outer", height: 30, within: null },
      { id: "inner", height: 52.5, within: "outer" },
      { id: "deepest", height: 30, within: "inner" },
      { id: "beside", height: 30, within: "outer" },
      { id: "next", height: 30, within: null },
      { id: "in-next", height: 24, within: "next" },
    ]);
    expect(moved(css)).toEqual(["inner 29 7", "deepest 80.5 6", "beside 29 7", "in-next 29 7"]);
  });

  test("however deep, each under the one it is in", () => {
    const toggles = ["a", "b", "c", "d", "e"].map((id, i, ids) => ({
      id,
      height: 30,
      within: i === 0 ? null : ids[i - 1]!,
    }));
    const z = moved(stackRules(toggles)).map((line) => Number(line.split(" ")[2]));
    expect(z).toEqual([7, 6, 5, 4]);
  });

  test("an id that would not be safe in a selector: left out", () => {
    const css = stackRules([
      { id: "outer", height: 30, within: null },
      { id: 'x"] * { display: none } [x="', height: 30, within: "outer" },
    ]);
    expect(css).toBe("");
  });
});
