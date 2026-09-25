import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cropImage, prepareImage } from "@/lib/media/compress";

/**
 * jsdom has no canvas, so these stand in for the browser: `webp` is whether it
 * can write WebP (Safari hands back a PNG instead), `alpha` is the opacity of
 * every pixel drawn, and `bytes` is how big any file it writes is.
 */
let browser: { webp: boolean; alpha: number; bytes: number };
let asked: { type: string; quality?: number }[];
let scanned: number;

beforeEach(() => {
  browser = { webp: true, alpha: 255, bytes: 10 };
  asked = [];
  scanned = 0;
  vi.stubGlobal("createImageBitmap", async () => ({ width: 400, height: 300, close() {} }));
  const context = {
    imageSmoothingQuality: "low",
    drawImage() {},
    getImageData(_x: number, _y: number, width: number, height: number) {
      scanned += 1;
      return { data: new Uint8ClampedArray(width * height * 4).fill(browser.alpha) };
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => context) as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type, quality) => {
    const wanted = type ?? "image/png";
    asked.push({ type: wanted, ...(quality === undefined ? {} : { quality }) });
    const written = wanted === "image/webp" && !browser.webp ? "image/png" : wanted;
    callback(new Blob([new Uint8Array(browser.bytes)], { type: written }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const source = (type: string, size = 1000) => new Blob([new Uint8Array(size)], { type });
const quarter = { x: 0, y: 0, width: 50, height: 50 };

describe("cropImage", () => {
  test("writes WebP where the browser can", async () => {
    const result = await cropImage(source("image/png"), quarter);
    expect(result).toMatchObject({
      mime: "image/webp",
      width: 200,
      height: 150,
      natural: { width: 400, height: 300 },
      kept: { x: 0, y: 0, width: 200, height: 150 },
    });
    expect(result.blob.type).toBe("image/webp");
    expect(asked).toEqual([{ type: "image/webp", quality: 0.82 }]);
    expect(scanned).toBe(0);
  });

  test("where it cannot, an opaque image becomes a JPEG, unless it was a PNG", async () => {
    browser.webp = false;
    for (const [type, expected] of [
      ["image/webp", "image/jpeg"],
      ["image/avif", "image/jpeg"],
      ["image/jpeg", "image/jpeg"],
      ["image/png", "image/png"],
    ] as const) {
      asked = [];
      const result = await cropImage(source(type), quarter);
      expect(result.mime, type).toBe(expected);
      expect(result.blob.type, type).toBe(expected);
      expect(asked, type).toEqual([
        { type: "image/webp", quality: 0.82 },
        expected === "image/png" ? { type: "image/png" } : { type: "image/jpeg", quality: 0.9 },
      ]);
    }
  });

  test("where it cannot, a see-through image stays a PNG, not a JPEG filled with black", async () => {
    browser = { ...browser, webp: false, alpha: 0 };
    // Stored as WebP by another browser, which keeps transparency.
    for (const type of ["image/webp", "image/avif"]) {
      const result = await cropImage(source(type), quarter);
      expect(result.mime, type).toBe("image/png");
      expect(asked.at(-1)).toEqual({ type: "image/png" });
    }
  });

  test("a JPEG or a PNG is not looked at pixel by pixel: the type already decides", async () => {
    browser = { ...browser, webp: false, alpha: 0 };
    expect((await cropImage(source("image/jpeg"), quarter)).mime).toBe("image/jpeg");
    expect((await cropImage(source("image/png"), quarter)).mime).toBe("image/png");
    expect(scanned).toBe(0);
  });
});

describe("prepareImage", () => {
  const file = (type: string, size = 1000) => new File([new Uint8Array(size)], "a", { type });

  test("records the type the browser wrote, not WebP whatever happened", async () => {
    browser.webp = false;
    const png = await prepareImage(file("image/png"));
    expect(png).toMatchObject({ mime: "image/png", width: 400, height: 300 });
    expect(png.blob.type).toBe("image/png");

    const opaque = await prepareImage(file("image/webp"));
    expect(opaque).toMatchObject({ mime: "image/jpeg", width: 400, height: 300 });
    expect(opaque.blob.type).toBe("image/jpeg");

    browser.alpha = 128;
    const clear = await prepareImage(file("image/webp"));
    expect(clear.mime).toBe("image/png");
    expect(clear.blob.type).toBe("image/png");
  });

  test("writes WebP where the browser can", async () => {
    const result = await prepareImage(file("image/png"));
    expect(result.mime).toBe("image/webp");
    expect(result.blob.type).toBe("image/webp");
  });

  test("keeps the original when the new file is no smaller", async () => {
    browser.bytes = 1000;
    const original = file("image/jpeg");
    const result = await prepareImage(original);
    expect(result.blob).toBe(original);
    expect(result).toMatchObject({ mime: "image/jpeg", width: 400, height: 300 });
  });
});
