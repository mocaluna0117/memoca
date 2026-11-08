import { ENCODING, type ImageKind } from "./classify";
import { type Fit, type Size, fitSize } from "./crop";

/**
 * How an image is written for upload, decided apart from how it is drawn: the
 * same on the page (lib/media/compress) and in the worker (workers/webp-worker),
 * which does the drawing and writing off the page's thread where it can.
 */

/**
 * For an image still over the limit for one image: smaller long edges, each
 * written a step lower in quality, tried in turn after its kind's own size.
 * Only those smaller than that size, and at most two: a screenshot kept at
 * its own size is tried next at 2048, as a photo would have been.
 */
export const SHRINK_EDGES = [2048, 1600, 1280];
/** How much lower the quality is at each of those steps. */
export const QUALITY_STEP = 0.1;

/** The image types the server takes: an image has to end up as one of these. */
export const UPLOADABLE_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
] as const;

/** Whether the server takes an image of this type as it is. */
export const uploadable = (type: string) =>
  (UPLOADABLE_IMAGE_TYPES as readonly string[]).includes(type);

/** The sizes an image of this kind is written at, in turn, and the quality of each. */
export function writePlan(original: Size, kind: ImageKind): { fit: Fit; quality: number }[] {
  const { fit, quality } = ENCODING[kind];
  const own = fitSize(original, fit);
  const smaller = SHRINK_EDGES.filter((edge) => edge < Math.max(own.width, own.height)).slice(0, 2);
  const fits: Fit[] = [fit, ...smaller.map((maxEdge) => ({ maxEdge }))];
  return fits.map((each, step) => ({ fit: each, quality: quality - step * QUALITY_STEP }));
}

/**
 * Whether what is written has to be used, and so written again smaller
 * until it fits: the original is over the limit, or not a type the server
 * takes. Otherwise the original is kept whenever nothing written is smaller.
 */
export function mustFit(file: { size: number; type: string }, maxBytes?: number): boolean {
  return (maxBytes !== undefined && file.size > maxBytes) || !uploadable(file.type);
}
