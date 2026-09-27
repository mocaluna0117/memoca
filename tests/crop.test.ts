import { describe, expect, test } from "vitest";
import {
  PERCENT,
  WHOLE,
  aspectCrop,
  cropSource,
  fallbackEncoding,
  fitSize,
  hasTransparency,
  keepsWholeImage,
  mayHideTransparency,
  scaledPreviewWidth,
} from "@/lib/media/crop";

const photo = { width: 400, height: 300 };

describe("cropSource", () => {
  test("maps a percent crop onto whole source pixels", () => {
    expect(cropSource({ x: 0, y: 0, width: 50, height: 50 }, PERCENT, photo)).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 150,
    });
  });

  test("maps a crop measured on a shrunken preview onto the full image", () => {
    // The image shown at 380 x 285, the right half chosen.
    const source = cropSource({ x: 190, y: 0, width: 190, height: 285 }, { width: 380, height: 285 }, photo);
    expect(source).toEqual({ x: 200, y: 0, width: 200, height: 300 });
  });

  test("rounds the edges, so neighbouring crops meet without a gap", () => {
    const strip = { width: 100, height: 10 };
    const left = cropSource({ x: 0, y: 0, width: 33.3, height: 100 }, PERCENT, strip);
    const right = cropSource({ x: 33.3, y: 0, width: 66.7, height: 100 }, PERCENT, strip);
    expect(left.x + left.width).toBe(right.x);
    expect(right.x + right.width).toBe(100);
  });

  test("keeps a crop that spills over the edge inside the image", () => {
    const source = cropSource({ x: 90, y: -5, width: 20, height: 110 }, PERCENT, photo);
    expect(source).toEqual({ x: 360, y: 0, width: 40, height: 300 });
  });

  test("never produces an empty image", () => {
    const source = cropSource({ x: 100, y: 100, width: 0, height: 0 }, PERCENT, photo);
    expect(source).toEqual({ x: 399, y: 299, width: 1, height: 1 });
  });
});

describe("fitSize", () => {
  test("brings the long edge down to its cap, keeping the shape", () => {
    expect(fitSize({ width: 4000, height: 3000 }, { maxEdge: 2048 })).toEqual({ width: 2048, height: 1536 });
    expect(fitSize({ width: 3000, height: 4000 }, { maxEdge: 2048 })).toEqual({ width: 1536, height: 2048 });
  });

  test("brings the pixels in all down to theirs", () => {
    // A Mac's screenshot, twice the size of its 1710 x 1107 screen.
    const size = fitSize({ width: 3420, height: 2214 }, { maxEdge: 4096, maxPixels: 4_000_000 });
    expect(size).toEqual({ width: 2486, height: 1609 });
    expect(size.width * size.height).toBeLessThanOrEqual(4_000_000);
  });

  test("whichever cap is the tighter one wins", () => {
    // A long capture, 6.5 million pixels: within the pixels it would still be 4714 tall.
    expect(fitSize({ width: 1080, height: 6000 }, { maxEdge: 4096, maxPixels: 4_000_000 })).toEqual({
      width: 737,
      height: 4096,
    });
  });

  test("leaves an image at its own size when it would come out only a little smaller", () => {
    const fit = { maxEdge: 4096, maxPixels: 4_000_000, keepFrom: 0.9 };
    // 0.997 and 0.969 of its size: kept.
    expect(fitSize({ width: 1344, height: 2992 }, fit)).toEqual({ width: 1344, height: 2992 });
    expect(fitSize({ width: 2560, height: 1664 }, fit)).toEqual({ width: 2560, height: 1664 });
    // Exactly 0.9: kept too.
    expect(fitSize({ width: 4000, height: 1000 }, { maxEdge: 3600, keepFrom: 0.9 })).toEqual({
      width: 4000,
      height: 1000,
    });
    // 0.727: made smaller, as it would be without.
    expect(fitSize({ width: 3420, height: 2214 }, fit)).toEqual({ width: 2486, height: 1609 });
  });

  test("never makes an image larger, and never less than a pixel either way", () => {
    expect(fitSize({ width: 1000, height: 750 }, { maxEdge: 2048, maxPixels: 4_000_000 })).toEqual({
      width: 1000,
      height: 750,
    });
    expect(fitSize({ width: 10_000, height: 1 }, { maxEdge: 100 })).toEqual({ width: 100, height: 1 });
  });
});

describe("keepsWholeImage", () => {
  test("is true only when nothing would be cut", () => {
    expect(keepsWholeImage(cropSource(WHOLE, PERCENT, photo), photo)).toBe(true);
    // A fraction of a pixel short still rounds to the whole image.
    expect(keepsWholeImage(cropSource({ x: 0.05, y: 0, width: 99.9, height: 100 }, PERCENT, photo), photo)).toBe(
      true,
    );
    expect(keepsWholeImage(cropSource({ x: 0, y: 0, width: 99, height: 100 }, PERCENT, photo), photo)).toBe(false);
  });
});

describe("aspectCrop", () => {
  test("a square from a wide image uses its full height, centred", () => {
    const crop = aspectCrop(1, photo);
    expect(crop.y).toBe(0);
    expect(crop.height).toBe(100);
    expect(crop.width).toBeCloseTo(75);
    expect(crop.x).toBeCloseTo(12.5);
    expect(cropSource(crop, PERCENT, photo)).toEqual({ x: 50, y: 0, width: 300, height: 300 });
  });

  test("a wide shape from a tall image uses its full width, centred", () => {
    const tall = { width: 900, height: 1600 };
    expect(cropSource(aspectCrop(16 / 9, tall), PERCENT, tall)).toEqual({ x: 0, y: 547, width: 900, height: 506 });
  });

  test("the image's own shape keeps all of it", () => {
    expect(aspectCrop(4 / 3, photo)).toEqual(WHOLE);
  });
});

describe("scaledPreviewWidth", () => {
  test("what is left keeps the scale it was shown at", () => {
    expect(scaledPreviewWidth(600, 200, 400)).toBe(300);
    expect(scaledPreviewWidth(333, 1, 3)).toBe(111);
  });

  test("is never narrower than a hand resize allows", () => {
    // 16 px of a 2048 px image shown 300 px wide would be 2 px.
    expect(scaledPreviewWidth(300, 16, 2048)).toBe(64);
  });

  test("keeps an image that was already narrower at its width", () => {
    expect(scaledPreviewWidth(40, 10, 400)).toBe(40);
  });
});

describe("hasTransparency", () => {
  const pixels = (...alphas: number[]) => alphas.flatMap((alpha) => [10, 20, 30, alpha]);

  test("is false when every pixel is opaque", () => {
    expect(hasTransparency(pixels(255, 255, 255))).toBe(false);
    expect(hasTransparency([])).toBe(false);
  });

  test("finds a single pixel that is not", () => {
    expect(hasTransparency(pixels(255, 254, 255))).toBe(true);
    expect(hasTransparency(pixels(255, 255, 0))).toBe(true);
  });

  test("reads only the alpha channel", () => {
    expect(hasTransparency([0, 0, 0, 255, 0, 0, 0, 255])).toBe(false);
  });
});

describe("fallbackEncoding", () => {
  test("keeps a PNG a PNG", () => {
    expect(fallbackEncoding("image/png", false)).toEqual({ type: "image/png" });
  });

  test("keeps see-through pixels in a PNG, whatever the source was stored as", () => {
    expect(fallbackEncoding("image/webp", true)).toEqual({ type: "image/png" });
    expect(fallbackEncoding("image/avif", true)).toEqual({ type: "image/png" });
    expect(fallbackEncoding("", true)).toEqual({ type: "image/png" });
  });

  test("writes anything else as a JPEG", () => {
    expect(fallbackEncoding("image/webp", false)).toEqual({ type: "image/jpeg", quality: 0.9 });
    expect(fallbackEncoding("image/jpeg", false)).toEqual({ type: "image/jpeg", quality: 0.9 });
    expect(fallbackEncoding("", false)).toEqual({ type: "image/jpeg", quality: 0.9 });
  });
});

describe("mayHideTransparency", () => {
  test("only the types whose pixels could decide the fallback are looked at", () => {
    expect(mayHideTransparency("image/jpeg")).toBe(false);
    expect(mayHideTransparency("image/png")).toBe(false);
    expect(mayHideTransparency("image/webp")).toBe(true);
    expect(mayHideTransparency("image/avif")).toBe(true);
    expect(mayHideTransparency("application/octet-stream")).toBe(true);
  });
});
