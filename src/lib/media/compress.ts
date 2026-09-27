"use client";

import { ENCODING, type ImageKind, SAMPLE, flatShare, kindOf } from "./classify";
import {
  type Fit,
  type Rect,
  type Size,
  PERCENT,
  cropSource,
  fallbackEncoding,
  fitSize,
  hasTransparency,
  mayHideTransparency,
} from "./crop";
import { type WorkerReport, canvasWritesWebp, encodeWebp, webpWorkerAvailable } from "./webp-encoder";

/**
 * For an image still over the limit for one image: smaller long edges, each
 * written a step lower in quality, tried in turn after its kind's own size.
 * Only those smaller than that size, and at most two: a screenshot kept at
 * its own size is tried next at 2048, as a photo would have been.
 */
const SHRINK_EDGES = [2048, 1600, 1280];
/** How much lower the quality is at each of those steps. */
const QUALITY_STEP = 0.1;

/** The image types the server takes: an image has to end up as one of these. */
export const UPLOADABLE_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
] as const;

/**
 * An image this browser cannot read, in a format the server does not take
 * either, such as a HEIC photo in Chrome: it could be neither converted nor
 * shown.
 */
export class UnsupportedImageError extends Error {
  constructor(readonly type: string) {
    super(`unsupported image: ${type}`);
    this.name = "UnsupportedImageError";
  }

  /** A HEIC photo, which Safari can read: worth saying so. */
  get heic(): boolean {
    return /hei[cf]/i.test(this.type);
  }
}

/** Whether the server takes an image of this type as it is. */
const uploadable = (type: string) => (UPLOADABLE_IMAGE_TYPES as readonly string[]).includes(type);

/**
 * One image written while preparing an upload, as the diagnostics in Settings
 * show it: at what size, by what, as what, how large, and how long it took.
 */
export type WriteTrace = {
  width: number;
  height: number;
  by: "canvas" | "worker" | "fallback";
  type: string;
  bytes: number;
  /** Drawing the image at that size, before writing it. */
  drawMs: number;
  /** Writing it, all in. */
  ms: number;
  /** Reading the pixels out of the canvas, for the worker. */
  pixelsMs?: number;
  /** What asking the worker came to, when it was asked. */
  worker?: Omit<WorkerReport, "webp">;
  /** Why the worker could not be asked, when that failed. */
  issue?: string;
};

/** The image as read, before anything was written: for the diagnostics too. */
export type ReadTrace = {
  width: number;
  height: number;
  /** Reading it. */
  ms: number;
  /** What it was taken for, from how much of it is flat colour (null: it could not be looked at). */
  kind: ImageKind;
  flat: number | null;
  /** Telling which, from a small copy. */
  sampleMs: number;
};

type Tracing = {
  onRead?: (trace: ReadTrace) => void;
  onWrite?: (trace: WriteTrace) => void;
  /** A try from the diagnostics: the worker's failures do not count against it. */
  trial?: boolean;
};

export type PreparedImage = {
  blob: Blob;
  mime: string;
  width: number;
  height: number;
};

/** A crop, with the source's size and the part of it that was kept, in its pixels. */
export type CroppedImage = PreparedImage & { natural: Size; kept: Rect };

/**
 * Shrinks a photo before it ever leaves the device.
 *
 * A phone camera file is several megabytes and no note needs that: resizing to
 * a sensible long edge and re-encoding as WebP typically cuts it by an order of
 * magnitude, which is the difference between a 100 MB allowance holding a
 * handful of notes and holding hundreds. A screenshot or a diagram is kept at
 * its own size instead, so its text stays sharp ({@link ENCODING}).
 *
 * `maxBytes` is the limit for one image. An image still over it is written
 * again smaller and at a lower quality, up to twice; what comes back may still
 * be over, for the caller to refuse. The original is kept whenever nothing
 * written is smaller.
 */
export async function prepareImage(
  file: File,
  opts: { maxBytes?: number } & Tracing = {},
): Promise<PreparedImage> {
  // Animated images lose their animation when drawn to a canvas, so they pass
  // through untouched.
  if (file.type === "image/gif") {
    return { blob: file, mime: file.type, width: 0, height: 0 };
  }

  const reading = performance.now();
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    // Not readable here: fine as it is only if the server takes it.
    if (!uploadable(file.type)) throw new UnsupportedImageError(file.type || file.name);
    return { blob: file, mime: file.type, width: 0, height: 0 };
  }
  const readMs = performance.now() - reading;

  const original = { width: bitmap.width, height: bitmap.height };
  const judging = performance.now();
  const flat = flatnessOf(bitmap, { x: 0, y: 0, ...original });
  const kind = kindOf(flat);
  opts.onRead?.({ ...original, ms: readMs, kind, flat, sampleMs: performance.now() - judging });

  const over = (bytes: number) => opts.maxBytes !== undefined && bytes > opts.maxBytes;
  // Written again smaller only when what is written has to be used and does
  // not fit: the original is over the limit, or not a type the server takes.
  const mustFit = over(file.size) || !uploadable(file.type);
  const { fit, quality } = ENCODING[kind];
  const own = fitSize(original, fit);
  const smaller = SHRINK_EDGES.filter((edge) => edge < Math.max(own.width, own.height)).slice(0, 2);
  const fits: Fit[] = [fit, ...smaller.map((maxEdge) => ({ maxEdge }))];
  let best: PreparedImage | null = null;
  try {
    for (const [step, size] of fits.entries()) {
      const written = await writeAt(bitmap, size, file.type, quality - step * QUALITY_STEP, step, opts);
      if (!written) break;
      if (!best || written.blob.size < best.blob.size) best = written;
      if (!mustFit || !over(best.blob.size)) break;
    }
  } finally {
    bitmap.close();
  }

  if (!best || best.blob.size >= file.size) {
    if (!uploadable(file.type)) {
      // Readable here, but the server would not take it as it is.
      if (best) return best;
      throw new UnsupportedImageError(file.type || file.name);
    }
    return { blob: file, mime: file.type, ...original };
  }
  return best;
}

/** Draws the image within `fit` and writes it, as WebP at `quality` where it can. */
async function writeAt(
  bitmap: ImageBitmap,
  fit: Fit,
  sourceMime: string,
  quality: number,
  step: number,
  tracing: Tracing,
): Promise<PreparedImage | null> {
  const { width, height } = fitSize(bitmap, fit);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  // Made smaller with care, as a crop is: a photo brought down from a phone
  // camera's size by the default filter comes out jagged, and larger.
  context.imageSmoothingQuality = "high";
  const drawing = performance.now();
  context.drawImage(bitmap, 0, 0, width, height);
  const started = performance.now();
  const written = await encodeCanvas(canvas, context, sourceMime, quality, step, tracing.trial);
  if (!written) return null;
  const { blob, by, details } = written;
  tracing.onWrite?.({
    width,
    height,
    by,
    type: blob.type,
    bytes: blob.size,
    drawMs: started - drawing,
    ms: performance.now() - started,
    ...details,
  });
  // The type the browser actually wrote, which is not WebP everywhere.
  return { blob, mime: blob.type, width, height };
}

/**
 * Cuts a rectangle out of an image and encodes it the way uploads are.
 *
 * Works from the file's bytes, never from an `<img>` on the page: an image
 * served from another origin would taint the canvas and could not be read
 * back. `crop` is in percent of the image, so it does not matter how large
 * the image was shown while the rectangle was chosen. What is kept is judged
 * on its own: a photo cut out of a screenshot of it is written as a photo.
 */
export async function cropImage(source: Blob, crop: Rect): Promise<CroppedImage> {
  const bitmap = await createImageBitmap(source, { imageOrientation: "from-image" });
  const natural = { width: bitmap.width, height: bitmap.height };
  const kept = cropSource(crop, PERCENT, natural);
  const { fit, quality } = ENCODING[kindOf(flatnessOf(bitmap, kept))];
  const output = fitSize(kept, fit);

  const canvas = document.createElement("canvas");
  canvas.width = output.width;
  canvas.height = output.height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("canvas unavailable");
  }
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, kept.x, kept.y, kept.width, kept.height, 0, 0, output.width, output.height);
  bitmap.close();

  const blob = (await encodeCanvas(canvas, context, source.type, quality))?.blob;
  if (!blob) throw new Error("encoding failed");
  return { blob, mime: blob.type, ...output, natural, kept };
}

/**
 * How much of `area` of the image is flat colour ({@link flatShare}), looked
 * at in a small copy ({@link SAMPLE}), which takes a few milliseconds
 * whatever the image's size. Null when it cannot be looked at, and the image
 * is then written as a photo, as every image was before.
 */
function flatnessOf(bitmap: ImageBitmap, area: Rect): number | null {
  const size = fitSize(area, SAMPLE);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  // Read back once and never shown: kept in memory rather than on the GPU.
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(bitmap, area.x, area.y, area.width, area.height, 0, 0, size.width, size.height);
    return flatShare(context.getImageData(0, 0, size.width, size.height).data, size.width, size.height);
  } catch {
    return null;
  }
}

/**
 * Encodes a canvas as WebP at `quality`: by the canvas where the browser can,
 * else by the WebAssembly worker (Safari), else in {@link fallbackEncoding}'s
 * format. Whether the canvas can is asked once (see {@link canvasWritesWebp});
 * the result's own type is still checked, in case a browser that said yes
 * writes something else after all. `step` lowers the fallback's quality too,
 * for an image being made smaller to fit.
 */
async function encodeCanvas(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  sourceMime: string,
  quality: number,
  step = 0,
  trial = false,
): Promise<{ blob: Blob; by: WriteTrace["by"]; details: Partial<WriteTrace> } | null> {
  const details: Partial<WriteTrace> = {};
  let transparent: boolean | null = null;
  if (await canvasWritesWebp()) {
    const webp = await toBlob(canvas, "image/webp", quality);
    if (webp?.type === "image/webp") return { blob: webp, by: "canvas", details };
  } else if (webpWorkerAvailable()) {
    try {
      const reading = performance.now();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      details.pixelsMs = performance.now() - reading;
      // Looked at before the pixels are handed over, for the fallback.
      transparent = mayHideTransparency(sourceMime) && hasTransparency(pixels.data);
      const { webp, ...report } = await encodeWebp(pixels, quality, { trial });
      details.worker = report;
      if (webp) return { blob: webp, by: "worker", details };
    } catch (error) {
      // No room for the pixels, say: the fallback does without them.
      details.issue = error instanceof Error ? error.message : String(error);
    }
  }
  transparent ??= mayHideTransparency(sourceMime) && seeThrough(canvas, context);
  const fallback = fallbackEncoding(sourceMime, transparent);
  const fallbackQuality = fallback.quality === undefined ? undefined : fallback.quality - step * QUALITY_STEP;
  const blob = await toBlob(canvas, fallback.type, fallbackQuality);
  return blob ? { blob, by: "fallback", details } : null;
}

/** Whether any pixel is see-through; taken to be so when the pixels cannot be read. */
function seeThrough(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): boolean {
  try {
    return hasTransparency(context.getImageData(0, 0, canvas.width, canvas.height).data);
  } catch {
    // Kept as PNG, which loses nothing either way.
    return true;
  }
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

export function categoryOf(mime: string): "image" | "video" | "other" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "other";
}
