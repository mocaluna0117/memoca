import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { UnsupportedImageError, cropImage, prepareImage } from "@/lib/media/compress";
import { forgetWebpSupport } from "@/lib/media/webp-encoder";

/**
 * jsdom has no canvas, so these stand in for the browser: `webp` is whether it
 * can write WebP (Safari hands back a PNG instead), `alpha` is the opacity of
 * every pixel drawn, `bytes` is how big a file it writes at a given width and
 * quality, `size` is the picture's own size, `decodes` whether it can be read
 * at all, and `picture` what the small copy it is judged from looks like: a
 * photo's grain, or a screen's flat colour.
 */
let browser: {
  webp: boolean;
  alpha: number;
  bytes: number | ((width: number, quality?: number) => number);
  size: { width: number; height: number };
  decodes: boolean;
  picture: "photo" | "screen" | "unreadable";
  /** The one-pixel WebP check throws, as a canvas that cannot be used would. */
  checkThrows?: boolean;
};
/** What the canvas was asked to write, the one-pixel WebP check apart. */
let asked: { type: string; quality?: number; width?: number }[];
/** How often the one-pixel check ran. */
let probes: number;
/** Pixels read out of the image as drawn to be written. */
let scanned: number;
/**
 * The small copies an image was judged from: the part of it drawn, where it
 * was drawn to, the copy's canvas, and the pixels read back.
 */
let sampled: { from: number[]; to: number[]; canvas: number[]; read: number[] }[];
/** How smoothly the image was drawn, each time it was drawn to be written. */
let smoothing: string[];

beforeEach(() => {
  browser = {
    webp: true,
    alpha: 255,
    bytes: 10,
    size: { width: 400, height: 300 },
    decodes: true,
    picture: "photo",
  };
  asked = [];
  probes = 0;
  scanned = 0;
  sampled = [];
  smoothing = [];
  forgetWebpSupport();
  vi.stubGlobal("createImageBitmap", async () => {
    if (!browser.decodes) throw new DOMException("The source image could not be decoded.");
    return { ...browser.size, close() {} };
  });
  const context = {
    imageSmoothingQuality: "low",
    drawImage() {
      smoothing.push(context.imageSmoothingQuality);
    },
    getImageData(_x: number, _y: number, width: number, height: number) {
      scanned += 1;
      return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(browser.alpha) };
    },
  };
  // The copy an image is judged from is the one canvas made to be read back.
  const sampleOf = (canvas: HTMLCanvasElement) => {
    let drawn: number[] = [];
    return {
      drawImage(_image: unknown, ...area: number[]) {
        drawn = area;
      },
      getImageData(_x: number, _y: number, width: number, height: number) {
        if (browser.picture === "unreadable") throw new DOMException("The canvas has been tainted.");
        sampled.push({
          from: drawn.slice(0, 4),
          to: drawn.slice(4, 8),
          canvas: [canvas.width, canvas.height],
          read: [width, height],
        });
        const data = new Uint8ClampedArray(width * height * 4);
        // Grain: no two neighbours alike. Flat colour: all of them.
        for (let i = 0; i < data.length; i += 1) data[i] = browser.picture === "screen" ? 240 : (i * 37) % 251;
        return { width, height, data };
      },
    };
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    _type: string,
    options?: { willReadFrequently?: boolean },
  ) {
    return options?.willReadFrequently ? sampleOf(this) : context;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    callback,
    type,
    quality,
  ) {
    const wanted = type ?? "image/png";
    const written = wanted === "image/webp" && !browser.webp ? "image/png" : wanted;
    if (this.width === 1 && this.height === 1) {
      probes += 1;
      if (browser.checkThrows) throw new Error("canvas unavailable");
      callback(new Blob([new Uint8Array(1)], { type: written }));
      return;
    }
    asked.push({ type: wanted, ...(quality === undefined ? {} : { quality }) });
    const bytes = typeof browser.bytes === "number" ? browser.bytes : browser.bytes(this.width, quality);
    callback(new Blob([new Uint8Array(bytes)], { type: written }));
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
    expect(asked).toEqual([{ type: "image/webp", quality: 0.75 }]);
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
      // Not asked for WebP first, only to be handed a PNG: it said once it cannot.
      expect(asked, type).toEqual([
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

  test("a trimmed screenshot keeps its own size, and is written as one", async () => {
    browser = { ...browser, size: { width: 1179, height: 2556 }, picture: "screen" };
    const result = await cropImage(source("image/webp"), { x: 0, y: 0, width: 100, height: 90 });
    expect(result).toMatchObject({ width: 1179, height: 2300 });
    expect(asked).toEqual([{ type: "image/webp", quality: 0.65 }]);
  });

  test("what is kept is judged, not the whole image, and from a small copy", async () => {
    browser.size = { width: 4284, height: 5712 };
    const result = await cropImage(source("image/webp"), { x: 0, y: 50, width: 100, height: 50 });
    expect(sampled).toEqual([
      { from: [0, 2856, 4284, 2856], to: [0, 0, 314, 209], canvas: [314, 209], read: [314, 209] },
    ]);
    // Grain there: a photo, brought down to 2048 as photos are.
    expect(result).toMatchObject({ width: 2048, height: 1365 });
    expect(asked).toEqual([{ type: "image/webp", quality: 0.75 }]);
  });

  test("a trimmed screenshot larger than 4 million pixels is brought within them", async () => {
    browser = { ...browser, size: { width: 3420, height: 2214 }, picture: "screen" };
    const result = await cropImage(source("image/webp"), { x: 0, y: 0, width: 100, height: 99 });
    expect(result).toMatchObject({ width: 2498, height: 1601 });
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

  test("finds out once whether WebP can be written, not from every image", async () => {
    browser.webp = false;
    await prepareImage(file("image/png"));
    await prepareImage(file("image/png"));
    await cropImage(source("image/png"), quarter);
    expect(probes).toBe(1);
    expect(asked.some((call) => call.type === "image/webp")).toBe(false);
  });

  test("an image over the limit for one image is written smaller until it fits", async () => {
    browser.size = { width: 4000, height: 3000 };
    // Three bytes per pixel of width, whatever the quality.
    browser.bytes = (width) => width * 3;
    const result = await prepareImage(file("image/jpeg", 20_000), { maxBytes: 5_000 });
    // 2048 wide came to 6144 bytes; 1600 wide, a step lower, to 4800.
    expect(result).toMatchObject({ mime: "image/webp", width: 1600, height: 1200 });
    expect(asked.map((call) => call.type)).toEqual(["image/webp", "image/webp"]);
    expect(asked[0]!.quality).toBeCloseTo(0.75);
    expect(asked[1]!.quality).toBeCloseTo(0.65);
  });

  test("stops at the smallest step, for the caller to refuse what is still too large", async () => {
    browser.size = { width: 4000, height: 3000 };
    browser.bytes = (width) => width * 3;
    const result = await prepareImage(file("image/jpeg", 20_000), { maxBytes: 1_000 });
    expect(result).toMatchObject({ width: 1280, height: 960 });
    expect(result.blob.size).toBe(3_840);
    expect(asked).toHaveLength(3);
    expect(asked[2]!.quality).toBeCloseTo(0.55);
  });

  test("where WebP cannot be written, the fallback's quality steps down too", async () => {
    browser = { ...browser, webp: false, size: { width: 4000, height: 3000 }, bytes: (width) => width * 3 };
    const result = await prepareImage(file("image/jpeg", 20_000), { maxBytes: 5_000 });
    expect(result).toMatchObject({ mime: "image/jpeg", width: 1600 });
    expect(asked.map((call) => call.type)).toEqual(["image/jpeg", "image/jpeg"]);
    expect(asked[0]!.quality).toBeCloseTo(0.9);
    expect(asked[1]!.quality).toBeCloseTo(0.8);
  });

  test("an image within the limit is written once", async () => {
    browser.size = { width: 4000, height: 3000 };
    browser.bytes = (width) => width * 3;
    await prepareImage(file("image/jpeg", 20_000), { maxBytes: 10_000 });
    expect(asked).toHaveLength(1);
  });

  test("a screenshot is kept at its own size, and written at 0.65", async () => {
    browser = { ...browser, size: { width: 1179, height: 2556 }, picture: "screen" };
    expect(await prepareImage(file("image/png", 300_000))).toMatchObject({
      mime: "image/webp",
      width: 1179,
      height: 2556,
    });
    expect(asked).toEqual([{ type: "image/webp", quality: 0.65 }]);
  });

  test("a Mac's screenshot, twice the size of its screen, is brought within 4 million pixels", async () => {
    browser = { ...browser, size: { width: 3420, height: 2214 }, picture: "screen" };
    expect(await prepareImage(file("image/png", 1_000_000))).toMatchObject({ width: 2486, height: 1609 });
  });

  test("a photo is brought down to 2048 on its long edge and written at 0.75", async () => {
    browser.size = { width: 4284, height: 5712 };
    expect(await prepareImage(file("image/jpeg", 3_000_000))).toMatchObject({ width: 1536, height: 2048 });
    expect(asked).toEqual([{ type: "image/webp", quality: 0.75 }]);
  });

  test("is judged once, from a copy of about 65,000 pixels, whatever its size", async () => {
    browser.size = { width: 4284, height: 5712 };
    await prepareImage(file("image/jpeg", 3_000_000));
    expect(sampled).toEqual([
      { from: [0, 0, 4284, 5712], to: [0, 0, 222, 296], canvas: [222, 296], read: [222, 296] },
    ]);
  });

  test("a long capture is judged from a copy wide enough to tell, and brought within 4 million pixels", async () => {
    // Three screens of an iPhone, one above the other.
    browser = { ...browser, size: { width: 1179, height: 7668 }, picture: "screen" };
    const result = await prepareImage(file("image/png", 900_000));
    expect(sampled.map((sample) => sample.canvas)).toEqual([[100, 653]]);
    expect(result).toMatchObject({ width: 784, height: 5101 });
  });

  test("one that cannot be looked at is written as a photo, as every image was before", async () => {
    browser = { ...browser, size: { width: 1179, height: 2556 }, picture: "unreadable" };
    const reads: unknown[] = [];
    const result = await prepareImage(file("image/png", 300_000), { onRead: (read) => reads.push(read) });
    expect(result).toMatchObject({ width: 945, height: 2048 });
    expect(asked).toEqual([{ type: "image/webp", quality: 0.75 }]);
    expect(reads).toEqual([expect.objectContaining({ kind: "photo", flat: null })]);
  });

  test("a screen only a little over 4 million pixels keeps its own size, rather than blur in bands", async () => {
    // A Pixel Pro's screen: 4.02 million pixels.
    browser = { ...browser, size: { width: 1344, height: 2992 }, picture: "screen" };
    expect(await prepareImage(file("image/png", 300_000))).toMatchObject({ width: 1344, height: 2992 });
  });

  test("a screenshot over the limit is tried next as a photo would be, then smaller", async () => {
    browser = { ...browser, size: { width: 1179, height: 2556 }, picture: "screen", bytes: (width) => width * 3 };
    const writes: number[][] = [];
    const result = await prepareImage(file("image/png", 20_000), {
      maxBytes: 1_000,
      onWrite: (write) => writes.push([write.width, write.height]),
    });
    expect(writes).toEqual([
      [1179, 2556],
      [945, 2048],
      [738, 1600],
    ]);
    expect(result).toMatchObject({ width: 738, height: 1600 });
    expect(asked.map((call) => call.quality)).toEqual([0.65, expect.closeTo(0.55), expect.closeTo(0.45)]);
  });

  test("draws the image with care before writing it, as a crop is drawn", async () => {
    browser.size = { width: 4284, height: 5712 };
    await prepareImage(file("image/jpeg", 3_000_000));
    await cropImage(source("image/jpeg"), quarter);
    expect(smoothing).toEqual(["high", "high"]);
  });

  test("tells the diagnostics what it was taken for, and why", async () => {
    browser.picture = "screen";
    const reads: unknown[] = [];
    await prepareImage(file("image/png"), { onRead: (read) => reads.push(read) });
    expect(reads).toEqual([
      expect.objectContaining({ width: 400, height: 300, kind: "screen", flat: 1, sampleMs: expect.any(Number) }),
    ]);
  });

  test("an image this browser cannot read is refused, unless the server takes it as it is", async () => {
    browser.decodes = false;
    await expect(prepareImage(file("image/heic"))).rejects.toBeInstanceOf(UnsupportedImageError);
    await expect(prepareImage(new File([new Uint8Array(10)], "IMG_0001.HEIC"))).rejects.toBeInstanceOf(
      UnsupportedImageError,
    );
    const png = file("image/png");
    expect((await prepareImage(png)).blob).toBe(png);
  });

  test("a see-through image made smaller stays a PNG at every step, where WebP cannot be written", async () => {
    browser = {
      ...browser,
      webp: false,
      alpha: 0,
      size: { width: 4000, height: 3000 },
      bytes: (width) => width * 3,
    };
    const result = await prepareImage(file("image/webp", 20_000), { maxBytes: 5_000 });
    expect(result.mime).toBe("image/png");
    expect(asked.map((call) => call.type)).toEqual(["image/png", "image/png"]);
    expect(scanned).toBe(2);
  });

  test("a canvas that fails the WebP check leaves the fallback, and is not asked again", async () => {
    browser.checkThrows = true;
    expect((await prepareImage(file("image/webp"))).mime).toBe("image/jpeg");
    expect((await prepareImage(file("image/webp"))).mime).toBe("image/jpeg");
    expect(probes).toBe(1);
  });

  test("an image the server would not take is made smaller too until it fits, however small it came", async () => {
    // A HEIC photo Safari can read, written as PNG because it is see-through.
    browser = {
      ...browser,
      webp: false,
      alpha: 0,
      size: { width: 4000, height: 3000 },
      bytes: (width) => width * 3,
    };
    const result = await prepareImage(file("image/heic", 4_000), { maxBytes: 5_000 });
    expect(result).toMatchObject({ mime: "image/png", width: 1600 });
  });

  test("one it can read but the server would not take is always converted", async () => {
    // A bitmap is no smaller as WebP here, but the server does not take BMP.
    browser.bytes = 1000;
    const result = await prepareImage(file("image/bmp", 1000));
    expect(result.mime).toBe("image/webp");
  });
});

describe("where the canvas cannot write WebP, a worker does", () => {
  /** Answers every image with a WebP of `workerBytes`, or fails when that is null. */
  let workerBytes: number | null;
  /** What the worker was sent, as it would see it. */
  let sent: { width: number; height: number; quality: number; bytes: number }[];

  beforeEach(() => {
    browser.webp = false;
    workerBytes = 5;
    sent = [];
    vi.stubGlobal(
      "Worker",
      class {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: (() => void) | null = null;
        constructor() {
          queueMicrotask(() => this.onmessage?.({ data: { ready: true, loadMs: 1 } } as MessageEvent));
        }
        postMessage(message: { id: number; width: number; height: number; quality: number; pixels: ArrayBuffer }, transfer: Transferable[]) {
          sent.push({ width: message.width, height: message.height, quality: message.quality, bytes: message.pixels.byteLength });
          // Handed over, as a real worker takes it: nothing is left behind.
          structuredClone(undefined, { transfer });
          const data =
            workerBytes === null
              ? { id: message.id, error: "encoding failed" }
              : { id: message.id, webp: new Uint8Array(workerBytes).buffer, ms: 1, heap: null };
          queueMicrotask(() => this.onmessage?.({ data } as MessageEvent));
        }
        terminate() {}
      },
    );
  });

  const file = (type: string, size = 1000) => new File([new Uint8Array(size)], "a", { type });

  test("a photo, and a see-through image, come out as WebP", async () => {
    expect(await prepareImage(file("image/jpeg"))).toMatchObject({ mime: "image/webp", width: 400 });
    browser.alpha = 0;
    expect((await prepareImage(file("image/png"))).mime).toBe("image/webp");
    expect(sent).toHaveLength(2);
    // The canvas is never asked for WebP at full size.
    expect(asked).toEqual([]);
  });

  test("a screenshot goes to the worker at its own size, at 65", async () => {
    browser = { ...browser, size: { width: 1179, height: 2556 }, picture: "screen" };
    await prepareImage(file("image/png", 300_000));
    expect(sent.map(({ width, height, quality }) => ({ width, height, quality }))).toEqual([
      { width: 1179, height: 2556, quality: 65 },
    ]);
  });

  test("a trimmed image too", async () => {
    expect((await cropImage(source("image/png"), quarter)).mime).toBe("image/webp");
  });

  test("where the canvas can write WebP, the worker is never asked", async () => {
    browser.webp = true;
    const writes: string[] = [];
    await prepareImage(file("image/jpeg"), { onWrite: (write) => writes.push(write.by) });
    expect(sent).toEqual([]);
    expect(writes).toEqual(["canvas"]);
  });

  test("when the worker fails, the usual fallback is written", async () => {
    workerBytes = null;
    const result = await prepareImage(file("image/jpeg"));
    expect(result.mime).toBe("image/jpeg");
    expect(asked).toEqual([{ type: "image/jpeg", quality: 0.9 }]);
  });

  test("a see-through image stays see-through when the worker fails: it was looked at before handing it over", async () => {
    workerBytes = null;
    browser.alpha = 0;
    const result = await prepareImage(file("image/webp"));
    expect(result.mime).toBe("image/png");
    // Read once, for both the worker and the fallback.
    expect(scanned).toBe(1);
  });

  test("pixels that cannot be read out fall back instead of failing the image", async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation((() => ({
      drawImage() {},
      getImageData() {
        throw new RangeError("Out of memory");
      },
    })) as never);
    const writes: { by: string; issue?: string }[] = [];
    const result = await prepareImage(file("image/jpeg"), { onWrite: (write) => writes.push(write) });
    expect(result.mime).toBe("image/jpeg");
    expect(writes).toEqual([expect.objectContaining({ by: "fallback", issue: "Out of memory" })]);
    // And one of a type that may be see-through is kept as PNG, which loses nothing.
    expect((await prepareImage(file("image/webp"))).mime).toBe("image/png");
  });

  test("an image over the limit steps down in size and quality through the worker too", async () => {
    browser.size = { width: 4000, height: 3000 };
    workerBytes = 6_000;
    await prepareImage(file("image/jpeg", 20_000), { maxBytes: 5_000 });
    expect(sent.map(({ width, height, quality }) => ({ width, height, quality }))).toEqual([
      { width: 2048, height: 1536, quality: 75 },
      { width: 1600, height: 1200, quality: 65 },
      { width: 1280, height: 960, quality: 55 },
    ]);
  });

  test("each image written is reported: by what, as what, how large, and where the time went", async () => {
    const writes: { by: string; type: string; bytes: number; width: number; worker?: unknown }[] = [];
    const reads: { width: number }[] = [];
    await prepareImage(file("image/jpeg"), {
      onRead: (read) => reads.push(read),
      onWrite: (write) => writes.push(write),
    });
    expect(reads).toEqual([expect.objectContaining({ width: 400, height: 300 })]);
    expect(writes).toEqual([
      expect.objectContaining({
        by: "worker",
        type: "image/webp",
        bytes: 5,
        width: 400,
        worker: expect.objectContaining({ loadMs: 1, encodeMs: 1 }),
      }),
    ]);
  });
});
