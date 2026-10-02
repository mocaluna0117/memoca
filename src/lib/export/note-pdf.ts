"use client";

import { A4, type PageImage, writePdf } from "./pdf-writer";

/** The margin round each sheet, in points: about 14 mm. */
const MARGIN = 40;
/** How sharp the pictures are: twice the screen's pixels, as a phone shows them. */
const SCALE = 2;
/** The most a page's picture is wide, in pixels, whatever the note's width. */
const MAX_WIDTH = 2000;
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
  const restore = prepare(body);
  try {
    (document.activeElement as HTMLElement | null)?.blur?.();
    getSelection()?.removeAllRanges();
    window.dispatchEvent(new Event(EXPORT_EVENT));
    await settle(body);
    await frame();
    await frame();
    return await draw(body, titleField, title);
  } finally {
    restore();
  }
}

/**
 * Lays the note out as it is drawn until put back, under a cover that says
 * what is happening: at the width of a sheet, in the light theme (the
 * colours of what is drawn are read from the screen).
 */
function prepare(body: HTMLElement): () => void {
  const cover = document.createElement("div");
  cover.setAttribute("role", "status");
  cover.className =
    "memoca-export-cover fixed inset-0 z-[1000] flex items-center justify-center bg-white text-sm text-neutral-600";
  cover.textContent = "PDF を作っています…";
  document.body.append(cover);
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
    cover.remove();
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

/** Waits, up to {@link SETTLE_MS}, for the note's images to load and its PDFs to be drawn. */
async function settle(body: HTMLElement): Promise<void> {
  const until = Date.now() + SETTLE_MS;
  while (Date.now() < until) {
    const images = [...body.querySelectorAll("img")].every((image) => image.complete);
    const pdfs = [...body.querySelectorAll<HTMLElement>(".memoca-pdf")].every(
      (card) => card.dataset.drawn === "true",
    );
    if (images && pdfs) return;
    await sleep(100);
  }
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

async function draw(body: HTMLElement, field: HTMLElement | null, title: string): Promise<Blob> {
  const { createContext, destroyContext, domToCanvas } = await import("modern-screenshot");
  const width = Math.round(body.getBoundingClientRect().width);
  const scale = Math.min(SCALE, MAX_WIDTH / width);
  const contentWidth = A4.width - MARGIN * 2;
  const pixelsPerPoint = width / contentWidth;
  const sheet = Math.floor((A4.height - MARGIN * 2) * pixelsPerPoint);
  const heading = titleHeight(title, field, width);

  const { breaks, end } = breaksOf(body);
  const slices = paginate(breaks, end, { first: sheet - heading, rest: sheet });

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
  const pages: PageImage[] = [];
  let paper: [number, number, number] | null = null;
  try {
    for (const [index, [from, to]] of slices.entries()) {
      const top = index === 0 ? heading : 0;
      const height = Math.max(1, to - from);
      context.height = height;
      context.style = { transform: `translateY(${-from}px)`, margin: "0" } as Partial<CSSStyleDeclaration>;
      const slice = await domToCanvas(context);
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
      pages.push(await encode(page, (top + height) / pixelsPerPoint));
      slice.width = 0;
      page.width = 0;
    }
  } finally {
    destroyContext(context);
  }
  return writePdf(pages, { title, paper: paper ?? [255, 255, 255] });
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
async function encode(canvas: HTMLCanvasElement, heightPt: number): Promise<PageImage> {
  const { width, height } = canvas;
  const place = { x: MARGIN, y: MARGIN, width: A4.width - MARGIN * 2, height: heightPt };
  const rgba = canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
  const rgb = new Uint8Array(width * height * 3);
  for (let from = 0, to = 0; from < rgba.length; from += 4, to += 3) {
    rgb[to] = rgba[from]!;
    rgb[to + 1] = rgba[from + 1]!;
    rgb[to + 2] = rgba[from + 2]!;
  }
  const lossless = await deflate(rgb);
  const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
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
