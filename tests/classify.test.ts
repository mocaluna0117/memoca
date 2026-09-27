import { describe, expect, test } from "vitest";
import { ENCODING, FLAT_SHARE, flatShare, kindOf } from "@/lib/media/classify";
import { fitSize } from "@/lib/media/crop";

/** RGBA bytes for a picture drawn pixel by pixel. */
function pixels(width: number, height: number, colour: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set(colour(x, y), (y * width + x) * 4);
  }
  return data;
}

describe("flatShare", () => {
  test("one colour throughout is all flat; no two neighbours alike, none", () => {
    expect(flatShare(pixels(8, 4, () => [250, 250, 250, 255]), 8, 4)).toBe(1);
    expect(flatShare(pixels(8, 4, (x, y) => [x * 30, y * 60, 0, 255]), 8, 4)).toBe(0);
  });

  test("counts side-by-side pairs along each row, not across the end of one to the next", () => {
    // Each row is one colour, a different one from the row before: every pair
    // along a row is alike, and the last pixel of a row is unlike the next's first.
    expect(flatShare(pixels(5, 3, (_x, y) => [y * 100, 0, 0, 255]), 5, 3)).toBe(1);
    // Columns alternate: no pair along a row is alike, however alike the rows are.
    expect(flatShare(pixels(4, 3, (x) => [x % 2 ? 255 : 0, 0, 0, 255]), 4, 3)).toBe(0);
  });

  test("a pair differing in one channel only, transparency included, is not alike", () => {
    // The same two pixels, first: alike.
    expect(flatShare(pixels(2, 1, () => [10, 20, 30, 255]), 2, 1)).toBe(1);
    for (const channel of [0, 1, 2, 3]) {
      const data = pixels(2, 1, () => [10, 20, 30, 255]);
      data[4 + channel] = data[4 + channel]! - 1;
      expect(flatShare(data, 2, 1), `channel ${channel}`).toBe(0);
    }
  });

  test("every row counts, the last one too", () => {
    // The top row one colour, the bottom row grain: half the pairs are alike.
    expect(flatShare(pixels(3, 2, (x, y) => (y === 0 ? [5, 5, 5, 255] : [x * 90, 0, 0, 255])), 3, 2)).toBe(0.5);
    expect(flatShare(pixels(3, 2, (x, y) => (y === 1 ? [5, 5, 5, 255] : [x * 90, 0, 0, 255])), 3, 2)).toBe(0.5);
  });

  test("is the share of pairs alike", () => {
    // Left half white, right half grain: of the 7 pairs a row, the 3 in the white are alike.
    const data = pixels(8, 2, (x, y) => (x < 4 ? [255, 255, 255, 255] : [x * 20 + y, 90, 40, 255]));
    expect(flatShare(data, 8, 2)).toBeCloseTo(3 / 7);
  });

  test("an image a pixel wide has no pairs, and counts as not flat", () => {
    expect(flatShare(pixels(1, 5, () => [0, 0, 0, 255]), 1, 5)).toBe(0);
  });
});

describe("kindOf", () => {
  test("from the line up, a screen; below it, or when it could not be looked at, a photo", () => {
    expect(kindOf(FLAT_SHARE)).toBe("screen");
    expect(kindOf(0.88)).toBe("screen");
    expect(kindOf(FLAT_SHARE - 0.01)).toBe("photo");
    expect(kindOf(0.02)).toBe("photo");
    expect(kindOf(null)).toBe("photo");
  });

  test("the line lies between what screenshots and photos measured", () => {
    // In Chrome's canvas: screenshots of text and panels 0.60 and up; photos
    // 0.14 and below, a product on white and cut-out subjects apart.
    expect(FLAT_SHARE).toBeGreaterThan(0.14);
    expect(FLAT_SHARE).toBeLessThan(0.6);
  });
});

describe("ENCODING", () => {
  test("keeps every iPhone's screenshot at its own size", () => {
    for (const size of [
      { width: 1179, height: 2556 },
      { width: 1206, height: 2622 },
      { width: 1290, height: 2796 },
      { width: 1320, height: 2868 },
    ]) {
      expect(fitSize(size, ENCODING.screen.fit)).toEqual(size);
    }
  });

  test("keeps a screen only a little over 4 million pixels at its own size", () => {
    for (const size of [
      { width: 1344, height: 2992 },
      { width: 1440, height: 3120 },
      { width: 2560, height: 1664 },
    ]) {
      expect(fitSize(size, ENCODING.screen.fit)).toEqual(size);
    }
  });

  test("brings a larger screen within 4 million pixels, and a long capture too, up to 8192 long", () => {
    expect(fitSize({ width: 3420, height: 2214 }, ENCODING.screen.fit)).toEqual({ width: 2486, height: 1609 });
    // Three screens of an iPhone: as wide as a pixel budget allows, not narrowed to a long edge.
    expect(fitSize({ width: 1179, height: 7668 }, ENCODING.screen.fit)).toEqual({ width: 784, height: 5101 });
    expect(fitSize({ width: 1080, height: 20_000 }, ENCODING.screen.fit)).toEqual({ width: 442, height: 8192 });
  });

  test("writes a photo 2048 on its long edge, at 0.75", () => {
    expect(fitSize({ width: 4284, height: 5712 }, ENCODING.photo.fit)).toEqual({ width: 1536, height: 2048 });
    expect(ENCODING.photo.quality).toBe(0.75);
  });

  test("writes a screen at a lower quality than a photo: it is kept larger instead", () => {
    expect(ENCODING.screen.quality).toBeLessThan(ENCODING.photo.quality);
  });
});
