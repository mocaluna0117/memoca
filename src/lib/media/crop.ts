/**
 * The arithmetic behind trimming an image, kept free of the DOM so it can be
 * tested without a canvas.
 *
 * The crop box reports a rectangle in the coordinates of the image as it is
 * shown, which is usually scaled to fit the screen. Everything here turns that
 * into whole pixels of the stored image.
 */

export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };

/** The crop box in percent of the shown image, which does not change when the window does. */
export const PERCENT: Size = { width: 100, height: 100 };

/** The whole image, as a percent crop. */
export const WHOLE: Rect = { x: 0, y: 0, width: 100, height: 100 };

/** The most an image may be: its long edge, and, if given, its pixels in all. */
export type Fit = {
  maxEdge: number;
  maxPixels?: number;
  /**
   * The scale from which the image is left at its own size after all:
   * drawn only a little smaller, it saves little, and its lines a pixel wide
   * blur in bands.
   */
  keepFrom?: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** One axis: edges are rounded rather than the length, so 50% of 400 is exactly 200. */
function span(start: number, length: number, scale: number, limit: number): [number, number] {
  const from = clamp(Math.round(start * scale), 0, limit);
  const to = clamp(Math.round((start + length) * scale), 0, limit);
  const size = Math.max(1, to - from);
  return [Math.min(from, limit - size), size];
}

/**
 * Maps a crop drawn over the shown image onto the stored one: what to cut out
 * of it, in its own pixels.
 *
 * `displayed` is the size the crop was measured against: the shown size for a
 * crop in pixels, or {@link PERCENT} for one in percent. The result always lies
 * inside the image and is at least one pixel each way.
 */
export function cropSource(crop: Rect, displayed: Size, natural: Size): Rect {
  const [x, width] = span(crop.x, crop.width, natural.width / displayed.width, natural.width);
  const [y, height] = span(crop.y, crop.height, natural.height / displayed.height, natural.height);
  return { x, y, width, height };
}

/**
 * The size to draw an image of `size` at so it stays within `fit`, keeping
 * its shape: never larger than it is, and at least one pixel each way. One
 * that would come out only a little smaller (see `keepFrom`) keeps its size.
 */
export function fitSize(size: Size, fit: Fit): Size {
  const within = Math.min(
    1,
    fit.maxEdge / Math.max(size.width, size.height),
    fit.maxPixels === undefined ? 1 : Math.sqrt(fit.maxPixels / (size.width * size.height)),
  );
  const scale = fit.keepFrom !== undefined && within >= fit.keepFrom ? 1 : within;
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/** True when the crop keeps every pixel, so trimming would change nothing. */
export function keepsWholeImage(source: Rect, natural: Size): boolean {
  return source.width === natural.width && source.height === natural.height;
}

/**
 * The largest crop of the given shape, centred, as a percent crop.
 *
 * `aspect` is width over height in pixels. Percentages of a wide image are not
 * square, which is why the image's own size is needed.
 */
export function aspectCrop(aspect: number, natural: Size): Rect {
  const imageAspect = natural.width / natural.height;
  if (imageAspect > aspect) {
    const width = (aspect / imageAspect) * 100;
    return { x: (100 - width) / 2, y: 0, width, height: 100 };
  }
  const height = (imageAspect / aspect) * 100;
  return { x: 0, y: (100 - height) / 2, width: 100, height };
}

/** The narrowest BlockNote lets an image be resized to by hand. */
export const MIN_PREVIEW_WIDTH = 64;

/**
 * The block's width after a crop, so what is left appears at the same scale
 * it did before, rather than stretched back out to the old width.
 *
 * Never narrower than BlockNote's own resize allows, so a small crop of a
 * wide image stays big enough to see and to grab, unless the image was
 * already shown narrower than that.
 */
export function scaledPreviewWidth(
  previewWidth: number,
  keptWidth: number,
  naturalWidth: number,
): number {
  const scaled = Math.round((previewWidth * keptWidth) / naturalWidth);
  return Math.max(Math.min(MIN_PREVIEW_WIDTH, previewWidth), scaled);
}

/** Whether any pixel is less than fully opaque, in RGBA bytes as a canvas's `getImageData` gives them. */
export function hasTransparency(rgba: ArrayLike<number>): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i]! < 255) return true;
  }
  return false;
}

/**
 * What to encode as when the browser cannot write WebP (Safari hands back a
 * PNG instead). A PNG stays a PNG, and so does anything with see-through
 * parts: a JPEG has no transparency and would fill them with black. Uploads
 * from other browsers are stored as WebP, which keeps transparency, so for
 * those the pixels decide (`transparent`), not the type. Anything else
 * becomes a JPEG, which is far smaller than a PNG of a photo.
 */
export function fallbackEncoding(
  sourceMime: string,
  transparent: boolean,
): { type: string; quality?: number } {
  return sourceMime === "image/png" || transparent
    ? { type: "image/png" }
    : { type: "image/jpeg", quality: 0.9 };
}

/**
 * Whether the pixels need looking at to choose a fallback: a JPEG cannot be
 * see-through, and a PNG stays one anyway.
 */
export const mayHideTransparency = (sourceMime: string) =>
  sourceMime !== "image/jpeg" && sourceMime !== "image/png";
