"use client";

/**
 * A file read from the device, copied into memory: what a row is written
 * with, and what a URL is made from while its row may still be written.
 *
 * WebKit (the Mac desktop app, Safari) keeps a file in IndexedDB on disk, and
 * the blob a row is read as points at that file. Once the app has started
 * anew, writing a row again with such a blob loses the file: the row then
 * holds a file that is gone (NotFoundError), and so does every blob and URL
 * read from it before. Images pasted on the desktop app showed "?" after a
 * reload, their cached copy lost by the write that noted their use. A row is
 * therefore never written with a blob read from one, only with a copy.
 */
export async function inMemory(blob: Blob): Promise<Blob> {
  return new Blob([await blob.arrayBuffer()], { type: blob.type });
}

/** A file read from the device, as a copy in memory where it can be read (see {@link inMemory}). */
export const copiedBlob = (blob: Blob): Promise<Blob> => inMemory(blob).catch(() => blob);
