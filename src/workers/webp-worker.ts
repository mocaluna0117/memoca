/**
 * Prepares images for upload off the page's thread: reads the file, judges
 * it (a photo or a screen), draws it at the size it is kept at and writes
 * it as WebP, by the canvas where this browser's can (Chrome, Firefox), by
 * libwebp as WebAssembly where it cannot (Safari), or in a fallback format.
 * The page did all of this itself before, and a 12-megapixel photo held it
 * for most of a second. Also writes raw pixels as WebP, as it did at first,
 * for the page's own canvas (a crop, say).
 *
 * Built on its own into public/webp/<version>/ by
 * scripts/build-webp-worker.mjs, next to the encoder's WebAssembly, which
 * it loads from beside itself the first time it is needed. Says when it is
 * ready as soon as it starts. Not part of the app's bundle.
 */
import factory, { type WebPModule } from "@jsquash/webp/codec/enc/webp_enc.js";
import { defaultOptions } from "@jsquash/webp/meta.js";
import { initEmscriptenModule } from "@jsquash/webp/utils.js";
import { SAMPLE, flatShare, kindOf } from "../lib/media/classify";
import {
  type Fit,
  type Rect,
  fallbackEncoding,
  fitSize,
  hasTransparency,
  mayHideTransparency,
} from "../lib/media/crop";
import { mustFit, uploadable, writePlan } from "../lib/media/prepare-plan";

/** Raw pixels to write as WebP, as the first worker took them. */
type PixelsRequest = {
  id: number;
  width: number;
  height: number;
  pixels: ArrayBuffer;
  quality: number;
};
/** An image file to prepare for upload, as the page would have. */
type PrepareRequest = {
  id: number;
  kind: "prepare";
  file: Blob;
  type: string;
  size: number;
  maxBytes?: number;
};
type Request = PixelsRequest | PrepareRequest;

/** What one image written came to, as the diagnostics in Settings show it. */
type Write = {
  width: number;
  height: number;
  by: "worker-canvas" | "worker-wasm" | "fallback";
  type: string;
  bytes: number;
  drawMs: number;
  ms: number;
  pixelsMs?: number;
  issue?: string;
};
type Read = {
  width: number;
  height: number;
  ms: number;
  kind: "photo" | "screen";
  flat: number | null;
  sampleMs: number;
};
type Message =
  | { ready: true; loadMs: number }
  | { ready: false; error: string }
  | { id: number; webp: ArrayBuffer; ms: number; heap: number | null }
  | { id: number; error: string }
  | {
      id: number;
      /** Could not be read here: the page decides what the server takes. */
      unsupported: true;
    }
  | {
      id: number;
      read: Read;
      writes: Write[];
      /** The original is to be kept: nothing written was smaller. */
      original: true;
      width: number;
      height: number;
    }
  | {
      id: number;
      read: Read;
      writes: Write[];
      prepared: { blob: Blob; mime: string; width: number; height: number };
    };

/**
 * libwebp's effort, from 0 to 6. At 2 a photo takes a third of the time it
 * does at the default 4, and comes out 3 to 4 per cent larger.
 */
const METHOD = 2;

/** The parts of a worker's global scope used here. */
const scope = self as unknown as {
  location: Location;
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: Message, transfer?: Transferable[]): void;
};

const besideMe = (file: string) => new URL(file, scope.location.href).href;

async function compile(): Promise<WebAssembly.Module> {
  const url = besideMe("webp_enc.wasm");
  try {
    return await WebAssembly.compileStreaming(fetch(url));
  } catch {
    // Served without the WebAssembly type: read it whole instead.
    return WebAssembly.compile(await (await fetch(url)).arrayBuffer());
  }
}

/**
 * The encoder, loaded the first time it is needed: where the canvas writes
 * WebP it never is, and its half a megabyte is not fetched.
 */
let encoder: Promise<WebPModule> | null = null;
const encoderLoaded = () =>
  (encoder ??= compile().then((compiled) =>
    // Should the compiled module fail to start, the encoder looks for its file
    // beside the worker too, not at an address of its own.
    initEmscriptenModule(factory, compiled, { locateFile: besideMe }),
  ));

const started = performance.now();
scope.postMessage({ ready: true, loadMs: performance.now() - started });

/** Whether this browser's canvas writes WebP (Safari's quietly writes a PNG), found out once. */
let canvasWebp: Promise<boolean> | null = null;
const canvasWritesWebp = () =>
  (canvasWebp ??= (async () => {
    try {
      const probe = new OffscreenCanvas(1, 1);
      probe.getContext("2d");
      const blob = await probe.convertToBlob({ type: "image/webp" });
      return blob.type === "image/webp";
    } catch {
      return false;
    }
  })());

function encodePixels(
  libwebp: WebPModule,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  quality: number,
): Uint8Array | null {
  return libwebp.encode(pixels as Uint8ClampedArray<ArrayBuffer>, width, height, {
    ...defaultOptions,
    quality: Math.round(quality * 100),
    method: METHOD,
  });
}

/** How much of `area` of the image is flat colour, from a small copy; null when it cannot be looked at. */
function flatnessOf(bitmap: ImageBitmap, area: Rect): number | null {
  const size = fitSize(area, SAMPLE);
  try {
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(bitmap, area.x, area.y, area.width, area.height, 0, 0, size.width, size.height);
    return flatShare(context.getImageData(0, 0, size.width, size.height).data, size.width, size.height);
  } catch {
    return null;
  }
}

/** Draws the image within `fit` and writes it, as WebP at `quality` where it can. */
async function writeAt(
  bitmap: ImageBitmap,
  fit: Fit,
  sourceMime: string,
  quality: number,
  step: number,
): Promise<{ blob: Blob; write: Write } | null> {
  const { width, height } = fitSize(bitmap, fit);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  // Made smaller with care, as a crop is: a photo brought down from a phone
  // camera's size by the default filter comes out jagged, and larger.
  context.imageSmoothingQuality = "high";
  const drawing = performance.now();
  context.drawImage(bitmap, 0, 0, width, height);
  const began = performance.now();
  const trace = { width, height, drawMs: began - drawing };
  let transparent: boolean | null = null;
  if (await canvasWritesWebp()) {
    const webp = await canvas.convertToBlob({ type: "image/webp", quality });
    if (webp.type === "image/webp") {
      return {
        blob: webp,
        write: { ...trace, by: "worker-canvas", type: webp.type, bytes: webp.size, ms: performance.now() - began },
      };
    }
  }
  let issue: string | undefined;
  let pixelsMs: number | undefined;
  try {
    const reading = performance.now();
    const pixels = context.getImageData(0, 0, width, height);
    pixelsMs = performance.now() - reading;
    transparent = mayHideTransparency(sourceMime) && hasTransparency(pixels.data);
    const written = encodePixels(await encoderLoaded(), pixels.data, width, height, quality);
    if (written) {
      const blob = new Blob([written.slice().buffer as ArrayBuffer], { type: "image/webp" });
      return {
        blob,
        write: { ...trace, by: "worker-wasm", type: blob.type, bytes: blob.size, ms: performance.now() - began, pixelsMs },
      };
    }
    issue = "encoding failed";
  } catch (error) {
    issue = error instanceof Error ? error.message : String(error);
  }
  // Neither: the fallback format, as the page would write it.
  if (transparent === null) {
    try {
      transparent =
        mayHideTransparency(sourceMime) &&
        hasTransparency(context.getImageData(0, 0, width, height).data);
    } catch {
      transparent = true;
    }
  }
  const fallback = fallbackEncoding(sourceMime, transparent);
  const blob = await canvas.convertToBlob({
    type: fallback.type,
    ...(fallback.quality === undefined ? {} : { quality: fallback.quality - step * 0.1 }),
  });
  return {
    blob,
    write: { ...trace, by: "fallback", type: blob.type, bytes: blob.size, ms: performance.now() - began, pixelsMs, issue },
  };
}

async function prepare(request: PrepareRequest): Promise<Message> {
  const { id, file, type, size, maxBytes } = request;
  const reading = performance.now();
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  if (!bitmap) return { id, unsupported: true };
  const readMs = performance.now() - reading;
  const original = { width: bitmap.width, height: bitmap.height };
  const judging = performance.now();
  const flat = flatnessOf(bitmap, { x: 0, y: 0, ...original });
  const kind = kindOf(flat);
  const read: Read = { ...original, ms: readMs, kind, flat, sampleMs: performance.now() - judging };
  const writes: Write[] = [];
  const over = (bytes: number) => maxBytes !== undefined && bytes > maxBytes;
  const fitting = mustFit({ size, type }, maxBytes);
  let best: { blob: Blob; width: number; height: number } | null = null;
  try {
    for (const [step, { fit, quality }] of writePlan(original, kind).entries()) {
      const written = await writeAt(bitmap, fit, type, quality, step);
      if (!written) break;
      writes.push(written.write);
      if (!best || written.blob.size < best.blob.size) {
        best = { blob: written.blob, width: written.write.width, height: written.write.height };
      }
      if (!fitting || !over(best.blob.size)) break;
    }
  } finally {
    bitmap.close();
  }
  if (!best || best.blob.size >= size) {
    // Nothing smaller: the original, where the server takes it; else the
    // best there is, which the page may still refuse as too large.
    if (uploadable(type) || !best) return { id, read, writes, original: true, ...original };
  }
  return {
    id,
    read,
    writes,
    prepared: { blob: best.blob, mime: best.blob.type, width: best.width, height: best.height },
  };
}

scope.onmessage = async (event) => {
  const request = event.data;
  if ("kind" in request) {
    try {
      scope.postMessage(await prepare(request));
    } catch (error) {
      scope.postMessage({ id: request.id, error: String(error) });
    }
    return;
  }
  const { id, width, height, pixels, quality } = request;
  try {
    const libwebp = await encoderLoaded();
    const began = performance.now();
    const written = libwebp.encode(new Uint8ClampedArray(pixels), width, height, {
      ...defaultOptions,
      quality,
      method: METHOD,
    });
    if (!written) throw new Error("encoding failed");
    // Its own buffer, exactly as long as the file, to hand back without a copy.
    const webp = written.slice().buffer;
    const heap = (libwebp as { HEAPU8?: Uint8Array }).HEAPU8?.length ?? null;
    scope.postMessage({ id, webp, ms: performance.now() - began, heap }, [webp]);
  } catch (error) {
    scope.postMessage({ id, error: String(error) });
  }
};
