"use client";

/** Long edge, in pixels, that uploaded images are reduced to. */
export const MAX_IMAGE_EDGE = 2048;
const WEBP_QUALITY = 0.82;

export type PreparedImage = {
  blob: Blob;
  mime: string;
  width: number;
  height: number;
};

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

  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    return { blob: file, mime: file.type, width: bitmap.width, height: bitmap.height };
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", WEBP_QUALITY),
  );
  if (!blob || blob.size >= file.size) {
    return { blob: file, mime: file.type, width, height };
  }
  return { blob, mime: "image/webp", width, height };
}

export function categoryOf(mime: string): "image" | "video" | "other" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "other";
}
