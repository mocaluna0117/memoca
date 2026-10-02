import { type Locator, type Page } from "@playwright/test";
import { editor } from "./helpers";

/**
 * A PDF of `pages` pages, A4 upright, each a red band across its top and
 * its number as text below, written by hand so no file has to be kept: the
 * band is what a drawn page is told by.
 */
export function makePdf(pages: number): string {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) - 1 + 1;
  const catalog = add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // The page tree, written once its pages are known.
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  for (let page = 1; page <= pages; page += 1) {
    const content = `1 0 0 rg 0 742 595 100 re f 0 0 0 rg BT /F1 48 Tf 72 600 Td (Page ${page}) Tj ET`;
    const stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${stream} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
      ),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${pages} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

/** Pastes a PDF of `pages` pages into the open note, as a file from another app would be. */
export async function pastePdf(page: Page, { name, pages }: { name: string; pages: number }): Promise<void> {
  await editor(page).click();
  await editor(page).evaluate(
    (target, options) => {
      const data = new DataTransfer();
      data.items.add(new File([options.body], options.name, { type: "application/pdf" }));
      target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    },
    { name, body: makePdf(pages) },
  );
}

/** Whether a canvas has been drawn on: the red band across the top of a page. */
export const drawnRed = (canvas: Locator) =>
  canvas.evaluate((element: HTMLCanvasElement) => {
    if (element.width === 0) return false;
    const pixel = element.getContext("2d")!.getImageData(element.width / 2, 2, 1, 1).data;
    return pixel[0]! > 200 && pixel[1]! < 60 && pixel[2]! < 60;
  });
