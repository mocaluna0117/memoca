import { describe, expect, test } from "vitest";
import {
  PERCENT,
  WHOLE,
  aspectCrop,
  fallbackEncoding,
  hasTransparency,
  keepsWholeImage,
  mayHideTransparency,
  planCrop,
  scaledPreviewWidth,
} from "@/lib/media/crop";

const photo = { width: 400, height: 300 };

describe("planCrop", () => {
  test("maps a percent crop onto whole source pixels", () => {
    const plan = planCrop({ x: 0, y: 0, width: 50, height: 50 }, PERCENT, photo, 2048);
    expect(plan).toEqual({
      source: { x: 0, y: 0, width: 200, height: 150 },
      output: { width: 200, height: 150 },
    });
  });

  test("maps a crop measured on a shrunken preview onto the full image", () => {
    // The image shown at 380 x 285, the right half chosen.
    const plan = planCrop(
      { x: 190, y: 0, width: 190, height: 285 },
      { width: 380, height: 285 },
      photo,
      2048,
    );
    expect(plan.source).toEqual({ x: 200, y: 0, width: 200, height: 300 });
  });

  test("rounds the edges, so neighbouring crops meet without a gap", () => {
    const left = planCrop(
      { x: 0, y: 0, width: 33.3, height: 100 },
      PERCENT,
      { width: 100, height: 10 },
      2048,
    );
    const right = planCrop(
      { x: 33.3, y: 0, width: 66.7, height: 100 },
      PERCENT,
      { width: 100, height: 10 },
      2048,
    );
    expect(left.source.x + left.source.width).toBe(right.source.x);
    expect(right.source.x + right.source.width).toBe(100);
  });

  test("keeps a crop that spills over the edge inside the image", () => {
    const plan = planCrop({ x: 90, y: -5, width: 20, height: 110 }, PERCENT, photo, 2048);
    expect(plan.source).toEqual({ x: 360, y: 0, width: 40, height: 300 });
  });

  test("never produces an empty image", () => {
    const plan = planCrop({ x: 100, y: 100, width: 0, height: 0 }, PERCENT, photo, 2048);
    expect(plan.source).toEqual({ x: 399, y: 299, width: 1, height: 1 });
    expect(plan.output).toEqual({ width: 1, height: 1 });
  });

  test("shrinks the result to the long-edge cap, keeping its shape", () => {
    const plan = planCrop(WHOLE, PERCENT, { width: 4000, height: 3000 }, 2048);
    expect(plan.source).toEqual({ x: 0, y: 0, width: 4000, height: 3000 });
    expect(plan.output).toEqual({ width: 2048, height: 1536 });
  });

  test("leaves a crop under the cap at its own size", () => {
    const plan = planCrop(
      { x: 0, y: 0, width: 25, height: 25 },
      PERCENT,
      { width: 4000, height: 3000 },
      2048,
    );
    expect(plan.output).toEqual({ width: 1000, height: 750 });
  });
});

describe("keepsWholeImage", () => {
  test("is true only when nothing would be cut", () => {
    expect(keepsWholeImage(planCrop(WHOLE, PERCENT, photo, 2048), photo)).toBe(true);
    // A fraction of a pixel short still rounds to the whole image.
    expect(
      keepsWholeImage(
        planCrop({ x: 0.05, y: 0, width: 99.9, height: 100 }, PERCENT, photo, 2048),
        photo,
      ),
    ).toBe(true);
    expect(
      keepsWholeImage(
        planCrop({ x: 0, y: 0, width: 99, height: 100 }, PERCENT, photo, 2048),
        photo,
      ),
    ).toBe(false);
  });
});

describe("aspectCrop", () => {
  test("a square from a wide image uses its full height, centred", () => {
    const crop = aspectCrop(1, photo);
    expect(crop.y).toBe(0);
    expect(crop.height).toBe(100);
    expect(crop.width).toBeCloseTo(75);
    expect(crop.x).toBeCloseTo(12.5);
    const { source } = planCrop(crop, PERCENT, photo, 2048);
    expect(source).toEqual({ x: 50, y: 0, width: 300, height: 300 });
  });

  test("a wide shape from a tall image uses its full width, centred", () => {
    const tall = { width: 900, height: 1600 };
    const { source } = planCrop(aspectCrop(16 / 9, tall), PERCENT, tall, 2048);
    expect(source).toEqual({ x: 0, y: 547, width: 900, height: 506 });
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
