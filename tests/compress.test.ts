import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { UnsupportedImageError, cropImage, prepareImage } from "@/lib/media/compress";
import { forgetWebpSupport } from "@/lib/media/webp-encoder";

/**
 * jsdom has no canvas, so these stand in for the browser: `webp` is whether it
 * can write WebP (Safari hands back a PNG instead), `alpha` is the opacity of
 * every pixel drawn, `bytes` is how big a file it writes at a given width and
 * quality, `size` is the picture's own size, and `decodes` whether it can be
 * read at all.
 */
let browser: {
  webp: boolean;
  alpha: number;
  bytes: number | ((width: number, quality?: number) => number);
  size: { width: number; height: number };
  decodes: boolean;
  /** The one-pixel WebP check throws, as a canvas that cannot be used would. */
  checkThrows?: boolean;
};
/** What the canvas was asked to write, the one-pixel WebP check apart. */
let asked: { type: string; quality?: number; width?: number }[];
/** How often the one-pixel check ran. */
let probes: number;
let scanned: number;

beforeEach(() => {
  browser = { webp: true, alpha: 255, bytes: 10, size: { width: 400, height: 300 }, decodes: true };
  asked = [];
  probes = 0;
  scanned = 0;
  forgetWebpSupport();
  vi.stubGlobal("createImageBitmap", async () => {
    if (!browser.decodes) throw new DOMException("The source image could not be decoded.");
    return { ...browser.size, close() {} };
  });
  const context = {
    imageSmoothingQuality: "low",
    drawImage() {},
    getImageData(_x: number, _y: number, width: number, height: number) {
      scanned += 1;
      return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(browser.alpha) };
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => context) as never);
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
    expect(asked[0]!.quality).toBeCloseTo(0.82);
    expect(asked[1]!.quality).toBeCloseTo(0.72);
  });

  test("stops at the smallest step, for the caller to refuse what is still too large", async () => {
    browser.size = { width: 4000, height: 3000 };
    browser.bytes = (width) => width * 3;
    const result = await prepareImage(file("image/jpeg", 20_000), { maxBytes: 1_000 });
    expect(result).toMatchObject({ width: 1280, height: 960 });
    expect(result.blob.size).toBe(3_840);
    expect(asked).toHaveLength(3);
    expect(asked[2]!.quality).toBeCloseTo(0.62);
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
      { width: 2048, height: 1536, quality: 82 },
      { width: 1600, height: 1200, quality: 72 },
      { width: 1280, height: 960, quality: 62 },
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
