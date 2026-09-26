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
import { canvasWritesWebp } from "./webp-encoder";

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
export async function prepareImage(file: File, opts: { maxBytes?: number } = {}): Promise<PreparedImage> {
  // Animated images lose their animation when drawn to a canvas, so they pass
  // through untouched.
  if (file.type === "image/gif") {
    return { blob: file, mime: file.type, width: 0, height: 0 };
  }

  const bitmap = await createImageBitmap(file).catch(() => null);
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
      const written = await writeAt(bitmap, edge, file.type, step);
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
  const blob = await encodeCanvas(canvas, context, sourceMime, step);
  // The type the browser actually wrote, which is not WebP everywhere.
  return blob ? { blob, mime: blob.type, width, height } : null;
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

  const blob = await encodeCanvas(canvas, context, source.type);
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
 * Encodes a canvas as WebP where the browser can, and otherwise in
 * {@link fallbackEncoding}'s format. Whether it can is asked once (see
 * {@link canvasWritesWebp}); the result's own type is still checked, in case
 * a browser that said yes writes something else after all. `step` lowers the
 * quality, for an image being made smaller to fit.
 */
async function encodeCanvas(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  sourceMime: string,
  step = 0,
): Promise<Blob | null> {
  if (await canvasWritesWebp()) {
    const webp = await toBlob(canvas, "image/webp", WEBP_QUALITY - step * QUALITY_STEP);
    if (webp?.type === "image/webp") return webp;
  }
  const transparent =
    mayHideTransparency(sourceMime) &&
    hasTransparency(context.getImageData(0, 0, canvas.width, canvas.height).data);
  const fallback = fallbackEncoding(sourceMime, transparent);
  const quality = fallback.quality === undefined ? undefined : fallback.quality - step * QUALITY_STEP;
  return toBlob(canvas, fallback.type, quality);
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

export function categoryOf(mime: string): "image" | "video" | "other" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "other";
}
