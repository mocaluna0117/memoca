"use client";

import { showExportCover } from "./export-cover";
import { A4, type PageImage, writePdf } from "./pdf-writer";
import { type ProgressPart, trackProgress } from "./progress";

/** The margin round each sheet, in points: about 14 mm. */
const MARGIN = 40;
/**
 * How sharp the pictures are: four pixels to each of the screen's, about
 * 400 dpi on the sheet (720 pixels across 515 points), as sharp as print
 * asks for. Twice, 200 dpi, read soft when zoomed in or printed.
 */
const SCALE = 4;
/**
 * The most a page's picture is wide, in pixels, whatever the note's width:
 * 2,880 by about 4,070 is 11.7 million pixels, within the 16.7 million a
 * canvas may have on an iPhone.
 */
const MAX_WIDTH = 2880;
/** A JPEG is kept only when it is this much smaller than the lossless picture. */
const JPEG_GAIN = 0.6;
/**
 * The width a note is laid out at to be drawn, in CSS pixels, whatever
 * screen it is on: its 16-pixel text comes to about 11 points on the sheet,
 * as a document's does, from a phone as from a wide window.
 */
const LAYOUT_WIDTH = 720;
/** How long to wait for a note's pictures and PDFs to be drawn before drawing it anyway. */
const SETTLE_MS = 10_000;

/** Asked of every PDF in the note before it is drawn: to draw its first page now. */
export const EXPORT_EVENT = "memoca:export";

/**
 * How the percent shown is shared out between the steps of making a PDF,
 * by about how long each takes: waiting for the note's images and PDFs,
 * loading what draws it, drawing its pages, and writing the file. A
 * page is drawn, then encoded, in about these shares of its time.
 */
const STEPS = { waiting: 10, starting: 4, pages: 84, writing: 2 } as const;
const PAGE_STEPS = { drawing: 6, encoding: 4 } as const;

/** Classes that show what is selected or being edited, not the note. */
const TRANSIENT = ["ProseMirror-selectednode", "memoca-selected-media", "ProseMirror-focused"];
/** What is drawn over a note but is not of it. */
const NOT_OF_THE_NOTE =
  ".bn-side-menu, .bn-formatting-toolbar, .ProseMirror-gapcursor, .prosemirror-dropcursor-block, .prosemirror-dropcursor-inline";

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What the open note looks like, as a PDF: its title as the header shows it,
 * then its body as it is drawn on the screen, by the browser itself, laid
 * out at the width of a sheet ({@link LAYOUT_WIDTH}), on A4 sheets. A sheet
 * ends where a block (a line, an item, an image) does, so no line is cut in
 * two; only a block taller than a sheet is. In the light theme, whichever is on: a sheet of paper is white.
 * Its text is a picture: it reads exactly as the note does, but cannot be
 * selected.
 *
 * Made under a cover that says how far it has come, from the steps done
 * ({@link STEPS}): 100% once the file is made, before it is saved. Cancelled
 * from the cover, it stops once the page under way is drawn, and throws an
 * AbortError.
 */
export async function noteToPdf({
  body,
  titleField,
  title,
}: {
  /** The editor's own element (.memoca-editor). */
  body: HTMLElement;
  /** The note's title field, whose look the title is drawn with. */
  titleField: HTMLElement | null;
  title: string;
}): Promise<Blob> {
  const cancel = new AbortController();
  const { signal } = cancel;
  const cover = showExportCover({ onCancel: () => cancel.abort() });
  const progress = trackProgress((percent) => cover.set(percent));
  const [waiting, starting, pages, writing] = progress.whole.split(
    STEPS.waiting,
    STEPS.starting,
    STEPS.pages,
    STEPS.writing,
  );
  let restore: (() => void) | null = null;
  try {
    restore = prepare(body);
    (document.activeElement as HTMLElement | null)?.blur?.();
    getSelection()?.removeAllRanges();
    window.dispatchEvent(new Event(EXPORT_EVENT));
    await settle(body, waiting, signal);
    await frame();
    await frame();
    starting.to(0.25);
    const pdf = await draw(body, titleField, title, { starting, pages, writing }, signal);
    progress.finish();
    return pdf;
  } finally {
    progress.stop();
    restore?.();
    cover.remove();
  }
}

/**
 * Lays the note out as it is drawn until put back, under the cover: at the
 * width of a sheet, in the light theme (the colours of what is drawn are
 * read from the screen).
 */
function prepare(body: HTMLElement): () => void {
  const scrolled = [window.scrollX, window.scrollY] as const;
  const scroller = body.closest<HTMLElement>("[data-scroll]");
  const scrollerTop = scroller?.scrollTop ?? 0;
  const { width, maxWidth, minWidth } = body.style;
  body.style.width = `${LAYOUT_WIDTH}px`;
  body.style.maxWidth = "none";
  body.style.minWidth = `${LAYOUT_WIDTH}px`;
  const light = asLight(body);
  return () => {
    light();
    body.style.width = width;
    body.style.maxWidth = maxWidth;
    body.style.minWidth = minWidth;
    if (scroller) scroller.scrollTop = scrollerTop;
    window.scrollTo(...scrolled);
  };
}

/** Shows the app in its light theme until put back. */
function asLight(body: HTMLElement): () => void {
  const root = document.documentElement;
  const dark = root.classList.contains("dark");
  const container = body.closest<HTMLElement>("[data-color-scheme]") ?? body;
  const scheme = container.getAttribute("data-color-scheme");
  const colorScheme = root.style.colorScheme;
  if (dark) root.classList.remove("dark");
  root.style.colorScheme = "light";
  container.setAttribute("data-color-scheme", "light");
  return () => {
    if (dark) root.classList.add("dark");
    root.style.colorScheme = colorScheme;
    if (scheme !== null) container.setAttribute("data-color-scheme", scheme);
  };
}

/**
 * Waits, up to {@link SETTLE_MS}, for the note's images to load and its
 * PDFs to be drawn, saying how many of them are.
 */
async function settle(body: HTMLElement, progress: ProgressPart, signal: AbortSignal): Promise<void> {
  const until = Date.now() + SETTLE_MS;
  while (Date.now() < until) {
    signal.throwIfAborted();
    const images = [...body.querySelectorAll("img")].map((image) => image.complete);
    const pdfs = [...body.querySelectorAll<HTMLElement>(".memoca-pdf")].map(
      (card) => card.dataset.drawn === "true",
    );
    const ready = [...images, ...pdfs];
    const done = ready.filter(Boolean).length;
    progress.to(ready.length > 0 ? done / ready.length : 1);
    if (done === ready.length) return;
    await sleep(100);
  }
  progress.to(1);
}

/** Where a sheet may end: the foot of every block, in pixels from the top of the note. */
function breaksOf(body: HTMLElement): { breaks: number[]; end: number } {
  const top = body.getBoundingClientRect().top;
  const breaks = new Set<number>();
  for (const block of body.querySelectorAll(".bn-block-outer")) {
    const { bottom, height } = block.getBoundingClientRect();
    if (height > 0) breaks.add(Math.round(bottom - top));
  }
  const sorted = [...breaks].sort((a, b) => a - b);
  const padding = parseFloat(getComputedStyle(body).paddingTop) || 0;
  return { breaks: sorted, end: (sorted.at(-1) ?? 0) + padding };
}

/** The slices of the note a sheet each, as [from, to) in pixels. */
export function paginate(
  breaks: readonly number[],
  end: number,
  { first, rest }: { first: number; rest: number },
): [number, number][] {
  const slices: [number, number][] = [];
  let from = 0;
  while (from < end) {
    const room = slices.length === 0 ? first : rest;
    if (room <= 0) {
      // A title as tall as a sheet has the first to itself. A sheet with no
      // room at all, of a note not laid out, would never get to the end.
      if (slices.length > 0) throw new RangeError("A sheet has no room for the note");
      slices.push([0, 0]);
      continue;
    }
    const limit = from + room;
    if (limit >= end) {
      slices.push([from, end]);
      break;
    }
    // The last foot of a block that fits; a block taller than the sheet is
    // cut where the sheet ends.
    const fits = breaks.filter((at) => at > from && at <= limit);
    const to = fits.length > 0 ? fits.at(-1)! : limit;
    slices.push([from, to]);
    from = to;
  }
  return slices.length > 0 ? slices : [[0, 0]];
}

/** The title as the header shows it, with its line beneath, `width` CSS pixels wide. */
function drawTitle(
  ctx: CanvasRenderingContext2D,
  title: string,
  field: HTMLElement | null,
  width: number,
): number {
  const style = field ? getComputedStyle(field) : null;
  const header = field?.closest("header");
  const fontSize = style ? parseFloat(style.fontSize) : 16;
  const lineHeight = fontSize * 1.5;
  ctx.font = style ? `${style.fontWeight} ${style.fontSize} ${style.fontFamily}` : `500 16px sans-serif`;
  ctx.fillStyle = style?.color ?? "#0a0a0a";
  ctx.textBaseline = "middle";
  const inset = 16;
  // A long title goes on over more lines, rather than out of the sheet.
  const lines: string[] = [];
  let line = "";
  for (const character of title) {
    if (line && ctx.measureText(line + character).width > width - inset * 2) {
      lines.push(line);
      line = "";
    }
    line += character;
  }
  lines.push(line);
  const height = Math.max(header?.getBoundingClientRect().height ?? 52, lines.length * lineHeight + 20);
  const top = (height - lines.length * lineHeight) / 2;
  lines.forEach((text, index) => ctx.fillText(text, inset, top + lineHeight * (index + 0.5)));
  ctx.fillStyle = header ? getComputedStyle(header).borderBottomColor : "#e5e5e5";
  ctx.fillRect(0, height - 1, width, 1);
  return height;
}

/** How tall the title is drawn, measured on a canvas of its own. */
function titleHeight(title: string, field: HTMLElement | null, width: number): number {
  const ctx = document.createElement("canvas").getContext("2d")!;
  return drawTitle(ctx, title, field, width);
}

async function draw(
  body: HTMLElement,
  field: HTMLElement | null,
  title: string,
  progress: { starting: ProgressPart; pages: ProgressPart; writing: ProgressPart },
  signal: AbortSignal,
): Promise<Blob> {
  const { createContext, destroyContext, domToCanvas } = await import("modern-screenshot");
  signal.throwIfAborted();
  progress.starting.to(0.5);
  const width = Math.round(body.getBoundingClientRect().width);
  const scale = Math.min(SCALE, MAX_WIDTH / width);
  const contentWidth = A4.width - MARGIN * 2;
  const pixelsPerPoint = width / contentWidth;
  const sheet = Math.floor((A4.height - MARGIN * 2) * pixelsPerPoint);
  const heading = titleHeight(title, field, width);

  const { breaks, end } = breaksOf(body);
  const slices = paginate(breaks, end, { first: sheet - heading, rest: sheet });
  progress.starting.to(0.75);

  const context = await createContext(body, {
    scale,
    width,
    filter: (node) => !(node instanceof Element && node.matches(NOT_OF_THE_NOTE)),
    onCloneEachNode: (cloned) => {
      if (!(cloned instanceof HTMLElement)) return;
      cloned.classList.remove(...TRANSIENT);
      // A line's text is as wide as it is on the screen, and is copied so.
      // Safari draws a picture's text a hair wider, and at that width its
      // last character went onto a line of its own, over the next block.
      if (cloned.classList.contains("bn-inline-content")) {
        for (const size of ["width", "height", "inline-size", "block-size"]) cloned.style.removeProperty(size);
      }
    },
    timeout: 30_000,
  });
  progress.starting.to(1);
  // A page each, as long as one another: each draws the whole note again.
  const sheets = progress.pages.split(...slices.map(() => 1));
  const pages: PageImage[] = [];
  let paper: [number, number, number] | null = null;
  try {
    for (const [index, [from, to]] of slices.entries()) {
      signal.throwIfAborted();
      const [drawing, encoding] = sheets[index].split(PAGE_STEPS.drawing, PAGE_STEPS.encoding);
      const top = index === 0 ? heading : 0;
      const height = Math.max(1, to - from);
      context.height = height;
      context.style = { transform: `translateY(${-from}px)`, margin: "0" } as Partial<CSSStyleDeclaration>;
      // Its fonts and images taken in (the first page's fetched), then the whole drawn.
      context.progress = (done, total) => drawing.to(total > 0 ? (done / total) / 2 : 0);
      const slice = await domToCanvas(context);
      drawing.to(1);
      paper ??= paperOf(slice);

      const page = document.createElement("canvas");
      page.width = Math.round(width * scale);
      page.height = Math.round((top + height) * scale);
      const ctx = page.getContext("2d")!;
      ctx.fillStyle = `rgb(${paper.join(" ")})`;
      ctx.fillRect(0, 0, page.width, page.height);
      ctx.scale(scale, scale);
      if (index === 0) drawTitle(ctx, title, field, width);
      ctx.drawImage(slice, 0, top, width, height);
      pages.push(await encode(page, (top + height) / pixelsPerPoint, encoding));
      slice.width = 0;
      page.width = 0;
    }
  } finally {
    destroyContext(context);
  }
  const pdf = writePdf(pages, { title, paper: paper ?? [255, 255, 255] });
  progress.writing.to(1);
  return pdf;
}

/**
 * The colour a note is drawn on, as RGB: the corner of its first slice,
 * which is always its own margin. Taken from the picture, so the sheet
 * round it is exactly the same.
 */
function paperOf(slice: HTMLCanvasElement): [number, number, number] {
  const [r, g, b, a] = slice.getContext("2d")!.getImageData(1, 1, 1, 1).data;
  // Drawn on nothing, the picture's own background is the sheet's white.
  return a === 0 ? [255, 255, 255] : [r!, g!, b!];
}

/**
 * A page's picture as the PDF keeps it: lossless, unless a JPEG is much
 * smaller (a page that is mostly a photo).
 */
async function encode(canvas: HTMLCanvasElement, heightPt: number, progress: ProgressPart): Promise<PageImage> {
  const { width, height } = canvas;
  const place = { x: MARGIN, y: MARGIN, width: A4.width - MARGIN * 2, height: heightPt };
  const rgba = canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
  const rgb = new Uint8Array(width * height * 3);
  for (let from = 0, to = 0; from < rgba.length; from += 4, to += 3) {
    rgb[to] = rgba[from]!;
    rgb[to + 1] = rgba[from + 1]!;
    rgb[to + 2] = rgba[from + 2]!;
  }
  progress.to(0.2);
  const lossless = await deflate(rgb);
  progress.to(0.7);
  const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  progress.to(1);
  if (jpeg && jpeg.size < lossless.length * JPEG_GAIN) {
    return { width, height, encoding: "jpeg", data: new Uint8Array(await jpeg.arrayBuffer()), place };
  }
  return { width, height, encoding: "deflate", data: lossless, place };
}

/** zlib's deflate, as a PDF's FlateDecode reads it. */
async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
