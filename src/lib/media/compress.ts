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

/** Long edge, in pixels, that uploaded images are reduced to. */
export const MAX_IMAGE_EDGE = 2048;
const WEBP_QUALITY = 0.82;

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
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  // Animated images lose their animation when drawn to a canvas, so they pass
  // through untouched.
  if (file.type === "image/gif") {
    return { blob: file, mime: file.type, width: 0, height: 0 };
  }

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return { blob: file, mime: file.type, width: 0, height: 0 };

  const original = { width: bitmap.width, height: bitmap.height };
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    return { blob: file, mime: file.type, ...original };
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await encodeCanvas(canvas, context, file.type);
  if (!blob || blob.size >= file.size) {
    return { blob: file, mime: file.type, ...original };
  }
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
 * Encodes a canvas as WebP where the browser can. Safari quietly writes a PNG
 * when asked for WebP, so the result's own type is checked and, if it is not
 * WebP, the canvas is encoded again in {@link fallbackEncoding}'s format.
 */
async function encodeCanvas(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  sourceMime: string,
): Promise<Blob | null> {
  const webp = await toBlob(canvas, "image/webp", WEBP_QUALITY);
  if (webp?.type === "image/webp") return webp;
  const transparent =
    mayHideTransparency(sourceMime) &&
    hasTransparency(context.getImageData(0, 0, canvas.width, canvas.height).data);
  const fallback = fallbackEncoding(sourceMime, transparent);
  return toBlob(canvas, fallback.type, fallback.quality);
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

export function categoryOf(mime: string): "image" | "video" | "other" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "other";
}
