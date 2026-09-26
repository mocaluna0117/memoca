"use client";

import {
  type Rect,
  type Size,
  PERCENT,
  fallbackEncoding,
  hasTransparency,
  mayHideTransparency,
  planCrop,
} from "./crop";
import { type WorkerReport, canvasWritesWebp, encodeWebp, webpWorkerAvailable } from "./webp-encoder";

/** Long edge, in pixels, that uploaded images are reduced to. */
export const MAX_IMAGE_EDGE = 2048;
const WEBP_QUALITY = 0.82;

/**
 * For an image still over the limit for one image: smaller long edges, each
 * written a step lower in quality, tried in turn.
 */
const SHRINK_EDGES = [MAX_IMAGE_EDGE, 1600, 1280];
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
export type ReadTrace = { width: number; height: number; ms: number };

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
 * handful of notes and holding hundreds.
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
  if (bitmap) opts.onRead?.({ width: bitmap.width, height: bitmap.height, ms: performance.now() - reading });
  if (!bitmap) {
    // Not readable here: fine as it is only if the server takes it.
    if (!uploadable(file.type)) throw new UnsupportedImageError(file.type || file.name);
    return { blob: file, mime: file.type, width: 0, height: 0 };
  }

  const original = { width: bitmap.width, height: bitmap.height };
  const over = (bytes: number) => opts.maxBytes !== undefined && bytes > opts.maxBytes;
  // Written again smaller only when what is written has to be used and does
  // not fit: the original is over the limit, or not a type the server takes.
  const mustFit = over(file.size) || !uploadable(file.type);
  let best: PreparedImage | null = null;
  try {
    for (const [step, edge] of SHRINK_EDGES.entries()) {
      const written = await writeAt(bitmap, edge, file.type, step, opts);
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

/** Draws the image at most `maxEdge` on its long side and writes it. */
async function writeAt(
  bitmap: ImageBitmap,
  maxEdge: number,
  sourceMime: string,
  step: number,
  tracing: Tracing,
): Promise<PreparedImage | null> {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, width, height);
  const started = performance.now();
  const written = await encodeCanvas(canvas, context, sourceMime, step, tracing.trial);
  if (!written) return null;
  const { blob, by, details } = written;
  tracing.onWrite?.({
    width,
    height,
    by,
    type: blob.type,
    bytes: blob.size,
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
 * the image was shown while the rectangle was chosen.
 */
export async function cropImage(source: Blob, crop: Rect): Promise<CroppedImage> {
  const bitmap = await createImageBitmap(source, { imageOrientation: "from-image" });
  const natural = { width: bitmap.width, height: bitmap.height };
  const plan = planCrop(crop, PERCENT, natural, MAX_IMAGE_EDGE);

  const canvas = document.createElement("canvas");
  canvas.width = plan.output.width;
  canvas.height = plan.output.height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("canvas unavailable");
  }
  context.imageSmoothingQuality = "high";
  const { x, y, width, height } = plan.source;
  context.drawImage(bitmap, x, y, width, height, 0, 0, plan.output.width, plan.output.height);
  bitmap.close();

  const blob = (await encodeCanvas(canvas, context, source.type))?.blob;
  if (!blob) throw new Error("encoding failed");
  return {
    blob,
    mime: blob.type,
    width: plan.output.width,
    height: plan.output.height,
    natural,
    kept: plan.source,
  };
}

/**
 * Encodes a canvas as WebP: by the canvas where the browser can, else by the
 * WebAssembly worker (Safari), else in {@link fallbackEncoding}'s format.
 * Whether the canvas can is asked once (see {@link canvasWritesWebp}); the
 * result's own type is still checked, in case a browser that said yes writes
 * something else after all. `step` lowers the quality, for an image being
 * made smaller to fit.
 */
async function encodeCanvas(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  sourceMime: string,
  step = 0,
  trial = false,
): Promise<{ blob: Blob; by: WriteTrace["by"]; details: Partial<WriteTrace> } | null> {
  const quality = WEBP_QUALITY - step * QUALITY_STEP;
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
