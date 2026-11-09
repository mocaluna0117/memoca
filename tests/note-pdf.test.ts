// @vitest-environment node
import { describe, expect, test } from "vitest";
import { deflateSync } from "node:zlib";
import { A4, writePdf } from "@/lib/export/pdf-writer";

describe("a PDF of pictures", () => {
  const picture = (width: number, height: number, rgb: [number, number, number]) => {
    const pixels = new Uint8Array(width * height * 3);
    for (let at = 0; at < pixels.length; at += 3) pixels.set(rgb, at);
    return {
      width,
      height,
      encoding: "deflate" as const,
      data: new Uint8Array(deflateSync(pixels)),
      place: { x: 40, y: 40, width: A4.width - 80, height: 300 },
    };
  };

  test("is read by pdf.js: its pages, A4 each, its title in Japanese, and each page's picture", async () => {
    const blob = writePdf([picture(4, 3, [255, 0, 0]), picture(4, 2, [0, 0, 255])], {
      title: "買い物リスト",
      paper: [250, 250, 250],
    });
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    expect(doc.numPages).toBe(2);
    const { info } = (await doc.getMetadata()) as { info: { Title?: string } };
    expect(info.Title).toBe("買い物リスト");
    const page = await doc.getPage(1);
    expect(page.view.map(Math.round)).toEqual([0, 0, 595, 842]);
    const { fnArray } = await page.getOperatorList();
    // The sheet filled with the paper's colour, then the picture drawn on it.
    expect(fnArray).toContain(pdfjs.OPS.paintImageXObject);
    await doc.loadingTask.destroy();
  });

  test("points its cross-reference table at each object, to the byte", async () => {
    const text = Buffer.from(await writePdf([picture(2, 2, [0, 0, 0])], { title: "a" }).arrayBuffer()).toString(
      "latin1",
    );
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe("xref");
    const offsets = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
    offsets.forEach((offset, index) => expect(text.slice(offset).startsWith(`${index + 1} 0 obj`)).toBe(true));
  });
});

describe("where a note's sheets end", async () => {
  const { paginate } = await import("@/lib/export/note-pdf");

  test("at the foot of the last block that fits, the first sheet shorter by the title", () => {
    // Blocks of 30 pixels; sheets of 100, the first of 70.
    const feet = [30, 60, 90, 120, 150, 180, 210, 240];
    expect(paginate(feet, 240, { first: 70, rest: 100 })).toEqual([
      [0, 60],
      [60, 150],
      [150, 240],
    ]);
  });

  test("a block taller than a sheet is cut where the sheet ends, and what follows starts after it", () => {
    expect(paginate([20, 260, 280], 280, { first: 100, rest: 100 })).toEqual([
      [0, 20],
      [20, 120],
      [120, 220],
      [220, 280],
    ]);
  });

  test("an empty note is one sheet", () => {
    expect(paginate([], 0, { first: 100, rest: 100 })).toEqual([[0, 0]]);
  });

  test("a title as tall as a sheet has the first to itself", () => {
    expect(paginate([50, 100], 100, { first: -20, rest: 100 })).toEqual([
      [0, 0],
      [0, 100],
    ]);
  });

  test("a note not laid out, with sheets of no room, is refused rather than paged for ever", () => {
    expect(() => paginate([], 16, { first: 0, rest: 0 })).toThrow(RangeError);
  });
});

describe("a note's links in its PDF", async () => {
  const { linkTarget, linksOnSheet } = await import("@/lib/export/note-pdf");
  const picture = () => ({
    width: 2,
    height: 2,
    encoding: "deflate" as const,
    data: new Uint8Array(deflateSync(new Uint8Array(12))),
    place: { x: 40, y: 40, width: A4.width - 80, height: 300 },
  });

  test("each a link of the PDF's own over its picture, read by pdf.js as one to press", async () => {
    const page = {
      ...picture(),
      links: [
        { url: "https://example.com/a?q=(1)", x: 50, y: 100, width: 120, height: 14 },
        { url: "mailto:me@example.com", x: 50, y: 130, width: 80, height: 14 },
      ],
    };
    const blob = writePdf([page, picture()], { title: "リンク" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // Its cross-reference table still to the byte, with the links' objects in it.
    const text = Buffer.from(bytes).toString("latin1");
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe("xref");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    const links = (await (await doc.getPage(1)).getAnnotations()) as { subtype: string; url?: string; rect: number[] }[];
    expect(links.map((link) => [link.subtype, link.url])).toEqual([
      ["Link", "https://example.com/a?q=(1)"],
      ["Link", "mailto:me@example.com"],
    ]);
    // From the page's foot, as a PDF counts: 100 points down is 842 - 100 up.
    expect(links[0]!.rect.map(Math.round)).toEqual([50, Math.round(A4.height - 114), 170, Math.round(A4.height - 100)]);
    expect(await (await doc.getPage(2)).getAnnotations()).toEqual([]);
    await doc.loadingTask.destroy();
  });

  test("go to a web page, an address or a number: nothing else (a script) is a link of the PDF's", () => {
    expect(linkTarget("https://example.com/日本語")).toBe("https://example.com/%E6%97%A5%E6%9C%AC%E8%AA%9E");
    expect(linkTarget("http://example.com")).toBe("http://example.com/");
    expect(linkTarget("mailto:me@example.com")).toBe("mailto:me@example.com");
    expect(linkTarget("tel:0312345678")).toBe("tel:0312345678");
    expect(linkTarget("javascript:alert(1)")).toBeNull();
    expect(linkTarget("memoca://attachment/1")).toBeNull();
    expect(linkTarget("not a url")).toBeNull();
  });

  test("on each sheet where they are drawn, under the title on the first, one over two sheets cut in two", () => {
    const links = [
      { url: "https://a.example/", x: 10, y: 20, width: 100, height: 20 },
      { url: "https://b.example/", x: 0, y: 290, width: 50, height: 20 },
    ];
    // Two pixels a point, 40 points of margin, a 30-pixel title over the first.
    const first = linksOnSheet(links, [0, 300], { top: 30, pixelsPerPoint: 2, margin: 40 });
    expect(first).toEqual([
      { url: "https://a.example/", x: 45, y: 65, width: 50, height: 10 },
      { url: "https://b.example/", x: 40, y: 200, width: 25, height: 5 },
    ]);
    const second = linksOnSheet(links, [300, 600], { top: 0, pixelsPerPoint: 2, margin: 40 });
    expect(second).toEqual([{ url: "https://b.example/", x: 40, y: 40, width: 25, height: 5 }]);
  });
});
