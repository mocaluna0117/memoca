/**
 * Telling a screenshot or a diagram from a photo, to write each the way that
 * suits it. Kept free of the DOM so it can be tested without a canvas.
 *
 * What blurs a screenshot's small text is being made smaller, not the
 * quality it is written at: an iPhone screenshot (1179 × 2556) brought down
 * to 2048 on its long edge, as photos are, loses a fifth of its width. Kept
 * at its own size and written at 65 instead of 82, it comes out about as
 * large as before (11 screenshots came to 6 per cent more), and its text as
 * sharp as on the screen. Photos are written as before. The measurements
 * behind these numbers are in docs/STORAGE-AND-DESKTOP.md (S5).
 */

import type { Fit } from "./crop";

/** What an image shows, as far as writing it goes. */
export type ImageKind = "photo" | "screen";

/** How each kind is written: the most it may be, and its WebP quality (0 to 1). */
export const ENCODING: Record<ImageKind, { fit: Fit; quality: number }> = {
  /**
   * 2048 on its long edge: more than a phone or a note shows, a fraction of
   * what a camera takes. Quality 75 came to a quarter less than 82 for 19
   * photos, and looked the same (SSIM at the width shown, 0.971 to 0.976).
   */
  photo: { fit: { maxEdge: 2048 }, quality: 0.75 },
  /**
   * At its own size up to 4 million pixels, which every iPhone's screen
   * (the largest 1320 × 2868) fits, and a little over, where it would come
   * out less than a tenth smaller (a Pixel Pro's, a 13-inch MacBook Air's).
   * A larger Mac's is brought within them (3420 × 2214 to 2486 × 1609), and
   * so is a long capture of several screens, which the long edge, well
   * past any screen's, leaves to the pixels. Quality 65 looks as 75 does,
   * and comes out about a tenth smaller.
   */
  screen: { fit: { maxEdge: 8192, maxPixels: 4_000_000, keepFrom: 0.9 }, quality: 0.65 },
};

/**
 * The small copy an image is judged from: about 65,000 pixels (256 × 256),
 * whatever its shape, so that a long capture's is not a sliver a few pixels
 * wide.
 */
export const SAMPLE: Fit = { maxEdge: 4096, maxPixels: 65_536 };

/**
 * The share of side-by-side pixels of exactly one colour from which an image
 * counts as a screen. Measured as Chrome's canvas makes the copy,
 * screenshots of text and panels came to 0.60 to 0.95, dark ones included,
 * and photos to 0.14 or less, but for a product on a white background
 * (0.60), a subject cut out of its background and a bright photo of a
 * document (0.53 each). A screenshot filled with a photo (a social feed,
 * 0.37) counts as a photo. Taken for the wrong kind, an image comes out no
 * sharper than before, or a little larger (19 photos written as screens
 * came to 7 per cent more, a wide one to 30), so the line need not be exact.
 */
export const FLAT_SHARE = 0.4;

/**
 * The share of side-by-side pixels, along each row, that are exactly the
 * same colour, transparency included. `rgba` is four bytes a pixel, as a
 * canvas's `getImageData` gives them. Flat colour, a screen's backgrounds and
 * panels, repeats exactly; a camera's grain almost never does.
 */
export function flatShare(rgba: ArrayLike<number>, width: number, height: number): number {
  let pairs = 0;
  let same = 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4;
    for (let x = 1; x < width; x += 1) {
      const at = row + x * 4;
      pairs += 1;
      if (
        rgba[at] === rgba[at - 4] &&
        rgba[at + 1] === rgba[at - 3] &&
        rgba[at + 2] === rgba[at - 2] &&
        rgba[at + 3] === rgba[at - 1]
      ) {
        same += 1;
      }
    }
  }
  return pairs === 0 ? 0 : same / pairs;
}

/** The kind of an image with this much flat colour; a photo when it could not be looked at. */
export const kindOf = (share: number | null): ImageKind =>
  share !== null && share >= FLAT_SHARE ? "screen" : "photo";
