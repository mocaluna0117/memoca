/**
 * Writes a PDF of pictures, one a page: what a note looks like, drawn by the
 * browser, put on A4 sheets. Written by hand, as the format for this is
 * small: a page tree, and on each page one image placed in its margins.
 */

/** A4 in points (1/72 inch). */
export const A4 = { width: 595.28, height: 841.89 } as const;

/** One page's picture, its bytes as the PDF keeps them. */
export type PageImage = {
  /** In pixels. */
  width: number;
  height: number;
  /** JPEG bytes as they are, or RGB pixels compressed with zlib's deflate. */
  encoding: "jpeg" | "deflate";
  data: Uint8Array;
  /** Where on the page, in points from its top left, and how large. */
  place: { x: number; y: number; width: number; height: number };
};

const encoder = new TextEncoder();

/** A text string of the PDF's own, in UTF-16 so Japanese titles read as they are. */
function textString(text: string): string {
  let hex = "FEFF";
  for (let at = 0; at < text.length; at += 1) {
    hex += text.charCodeAt(at).toString(16).padStart(4, "0").toUpperCase();
  }
  return `<${hex}>`;
}

/** A number as a PDF writes one: no exponent, a few decimals at most. */
const num = (value: number) => Number(value.toFixed(3)).toString();

/**
 * The PDF of these pages, titled `title`, each sheet `paper` (RGB, 0 to
 * 255) beneath its picture: the note's own background, to its edges.
 */
export function writePdf(
  pages: PageImage[],
  { title, paper = [255, 255, 255] }: { title: string; paper?: readonly [number, number, number] },
): Blob {
  const fill = `${paper.map((channel) => num(channel / 255)).join(" ")} rg 0 0 ${A4.width} ${A4.height} re f`;
  const parts: Uint8Array[] = [];
  let length = 0;
  const write = (chunk: string | Uint8Array) => {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  const offsets: number[] = [];
  /** Starts object `id`: its place is what the cross-reference table points at. */
  const begin = (id: number) => {
    offsets[id] = length;
    write(`${id} 0 obj\n`);
  };

  // 1 catalog, 2 page tree, 3 information, then three objects a page.
  const pageId = (index: number) => 4 + index * 3;
  write("%PDF-1.4\n%âãÏÓ\n");
  begin(1);
  write("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  begin(2);
  write(
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${pageId(index)} 0 R`).join(" ")}] >>\nendobj\n`,
  );
  begin(3);
  write(`<< /Title ${textString(title)} /Producer (Memoca) >>\nendobj\n`);

  pages.forEach((page, index) => {
    const id = pageId(index);
    const { x, y, width, height } = page.place;
    const content = `${fill} q ${num(width)} 0 0 ${num(height)} ${num(x)} ${num(A4.height - y - height)} cm /Page Do Q`;
    begin(id);
    write(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Contents ${id + 1} 0 R /Resources << /XObject << /Page ${id + 2} 0 R >> >> >>\nendobj\n`,
    );
    begin(id + 1);
    write(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
    begin(id + 2);
    const filter = page.encoding === "jpeg" ? "/DCTDecode" : "/FlateDecode";
    write(
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ${filter} /Length ${page.data.length} >>\nstream\n`,
    );
    write(page.data);
    write("\nendstream\nendobj\n");
  });

  const count = pageId(pages.length);
  const xref = length;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id += 1) table += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  write(table);
  write(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}
