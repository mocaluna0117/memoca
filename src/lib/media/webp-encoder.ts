"use client";

/**
 * Where images can be written as WebP. Safari (iPhone, iPad and the Mac, and
 * so a desktop shell's window there too) cannot: asked for WebP, its canvas
 * quietly writes a PNG. That is found out once, from a single pixel, rather
 * than from a full-size image every time.
 */
let canvasWebp: Promise<boolean> | null = null;

export function canvasWritesWebp(): Promise<boolean> {
  canvasWebp ??= new Promise<boolean>((resolve) => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      canvas.toBlob((blob) => resolve(blob?.type === "image/webp"), "image/webp");
    } catch {
      resolve(false);
    }
  });
  return canvasWebp;
}

/** Forgets the answer, as if the page had just loaded: for tests. */
export function forgetWebpSupport(): void {
  canvasWebp = null;
}
