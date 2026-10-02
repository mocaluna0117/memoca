"use client";

import type { PDFDocumentProxy, PDFPageProxy, PDFWorker, RenderTask } from "pdfjs-dist";

type PdfJs = typeof import("pdfjs-dist");

/** pdf.js and the one worker every PDF is read in, fetched with the first PDF shown. */
let loading: Promise<{ lib: PdfJs; worker: PDFWorker }> | null = null;

/** Where the worker and what it reads are (scripts/copy-pdfjs.mjs). */
const assets = (version: string) => `/pdfjs/${version}/`;

function pdfjs(): Promise<{ lib: PdfJs; worker: PDFWorker }> {
  loading ??= import("pdfjs-dist/legacy/build/pdf.mjs")
    .then((module) => {
      const lib = module as unknown as PdfJs;
      lib.GlobalWorkerOptions.workerSrc = `${assets(lib.version)}pdf.worker.min.mjs`;
      return { lib, worker: lib.PDFWorker.create({ name: "memoca-pdf" }) };
    })
    .catch((error: unknown) => {
      // Offline before it was ever fetched, say: asked again next time.
      loading = null;
      throw error;
    });
  return loading;
}

/** Whether these bytes are a PDF's: one starts "%PDF-", within its first kilobyte. */
export function looksLikePdf(head: Uint8Array): boolean {
  const text = new TextDecoder("latin1").decode(head.subarray(0, 1024));
  return text.includes("%PDF-");
}

/** Lets go of a PDF opened with {@link openPdf}, and what the worker holds of it. */
export const closePdf = (doc: PDFDocumentProxy) => doc.loadingTask.destroy();

/** A PDF file this tab can show, or null when the bytes are not a PDF's. */
export async function openPdf(blob: Blob): Promise<PDFDocumentProxy | null> {
  const data = new Uint8Array(await blob.arrayBuffer());
  if (!looksLikePdf(data)) return null;
  const { lib, worker } = await pdfjs();
  const base = assets(lib.version);
  return lib.getDocument({
    data,
    worker,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
    // No forms of its own drawn. pdf.js runs no scripts a file has unless
    // asked to (its scripting sandbox is not even loaded).
    enableXfa: false,
  }).promise;
}

/** The most pixels one page is drawn with: a phone's canvas gives up well past this. */
const MAX_PIXELS = 12_000_000;

/** A page's height for each unit of its width. */
export const aspectOf = (page: PDFPageProxy) => {
  const { width, height } = page.getViewport({ scale: 1 });
  return height / width;
};

/**
 * Draws a page into `canvas`, `width` CSS pixels wide, as sharp as the
 * screen shows it within {@link MAX_PIXELS}. The task can be cancelled.
 */
export function drawPage(page: PDFPageProxy, canvas: HTMLCanvasElement, width: number): RenderTask {
  const natural = page.getViewport({ scale: 1 });
  const fit = width / natural.width;
  const height = natural.height * fit;
  const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_PIXELS / (width * height)));
  const viewport = page.getViewport({ scale: fit * ratio });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  return page.render({ canvas, viewport });
}

/** Whether a failure is only a drawing given up on, as a newer one took its place. */
export const wasCancelled = (error: unknown) =>
  (error as { name?: unknown } | null)?.name === "RenderingCancelledException";
