import { describe, expect, test } from "vitest";
import { describeKind } from "@/components/settings/image-diagnostics";

const read = { width: 1179, height: 2556, ms: 21 };

describe("the diagnostics' line on what an image was taken for", () => {
  test("says how much of it is flat colour, and from how much it counts as a screen", () => {
    expect(describeKind({ ...read, kind: "screen", flat: 0.694, sampleMs: 2.4 })).toBe(
      "種類: スクショ・図（隣と同じ色の画素 69%。40% 以上でスクショ・図、2 ms）",
    );
    expect(describeKind({ ...read, kind: "photo", flat: 0.05, sampleMs: 3 })).toBe(
      "種類: 写真（隣と同じ色の画素 5%。40% 以上でスクショ・図、3 ms）",
    );
  });

  test("says so when it could not be looked at", () => {
    expect(describeKind({ ...read, kind: "photo", flat: null, sampleMs: 1 })).toBe(
      "種類: 写真（見分けられなかったため、1 ms）",
    );
  });
});
