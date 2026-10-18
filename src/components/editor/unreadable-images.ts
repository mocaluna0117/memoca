import type { BlockNoteEditor } from "@blocknote/core";
import { toast } from "sonner";
import { REF_PREFIX } from "@/lib/media/ref";

/** What holds a line's text: an image in one is marked in it. */
const IN_LINE = "p, li, h1, h2, h3, h4, h5, h6, td, th, span, a, strong, em, b, i, u, s, code";

/** Where an image can be read from: the web, the page itself, or Memoca's own files. */
const READABLE = /^(https?:|data:|blob:)/i;

/**
 * Pasted HTML with the images in it that cannot be read marked by a line in
 * their place, and how many there were. Notion copies a selection's images
 * as `attachment:<id>:<name>`, which only Notion can read, with nothing on
 * the clipboard to read them by; pasted as they are, they became image blocks
 * showing only their name. Notion's are marked as Notion's.
 */
export function markUnreadableImages(html: string): {
  html: string;
  count: number;
  fromNotion: boolean;
} {
  const page = new DOMParser().parseFromString(html, "text/html");
  let count = 0;
  let fromNotion = false;
  for (const image of [...page.querySelectorAll("img")]) {
    const src = image.getAttribute("src")?.trim() ?? "";
    if (READABLE.test(src) || src.startsWith(REF_PREFIX)) continue;
    const notion = src.startsWith("attachment:");
    const name = image.getAttribute("alt")?.trim() || src.split(":").at(-1) || "画像";
    const mark = notion ? `（Notion の画像：${name}）` : `（貼り付けられなかった画像：${name}）`;
    // In a line (a paragraph, an item): its text there; on its own, as Notion
    // has them, a line of its own, for two side by side not to be one.
    const inLine = image.parentElement?.closest(IN_LINE);
    const line = inLine ? page.createTextNode(mark) : page.createElement("p");
    if (!inLine) line.textContent = mark;
    image.replaceWith(line);
    count += 1;
    fromNotion ||= notion;
  }
  return { html: count > 0 ? page.body.innerHTML : html, count, fromNotion };
}

/**
 * A paste of HTML with images that cannot be read: pasted with a line in
 * each one's place, and said so, with how to bring them over. False for any
 * other, left to BlockNote.
 */
export function pasteMarkingUnreadableImages(
  event: ClipboardEvent,
  editor: BlockNoteEditor,
): boolean {
  const data = event.clipboardData;
  // Memoca's own copies are read as they are.
  if (!data || data.types.includes("blocknote/html")) return false;
  const html = data.getData("text/html");
  if (!html) return false;
  const marked = markUnreadableImages(html);
  if (marked.count === 0) return false;
  editor.pasteHTML(marked.html);
  toast.info(
    marked.fromNotion
      ? `画像 ${marked.count} 枚は Notion から一緒にはコピーされないため、目印の行にしました`
      : `画像 ${marked.count} 枚は読み込めないため、目印の行にしました`,
    {
      description: marked.fromNotion
        ? "画像は Notion で1枚ずつコピー（右クリックの「画像をコピー」など）して、目印の所に貼り付けてください。"
        : "画像そのものをコピーして、目印の所に貼り付けてください。",
    },
  );
  return true;
}
