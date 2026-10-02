import type { BlockNoteEditor } from "@blocknote/core";
import type { Node } from "prosemirror-model";
import { NodeSelection, type Selection, TextSelection } from "prosemirror-state";

/** What holds blocks without being one: a block's group, a row of columns, a column. */
const CONTAINERS = new Set(["blockGroup", "columnList", "column"]);

/**
 * The image a selection takes and nothing else (no text, no other block):
 * its url, or null. Selected by a click, or with Shift and the arrow keys
 * from the end of the line before it.
 */
export function imageAlone(doc: Node, selection: Selection): string | null {
  if (selection instanceof NodeSelection) {
    const node = selection.node;
    const image = node.type.name === "image" ? node : node.firstChild;
    return image?.type.name === "image" ? String(image.attrs.url || "") || null : null;
  }
  if (!(selection instanceof TextSelection) || selection.empty) return null;
  const { from, to } = selection;
  if (doc.textBetween(from, to) !== "") return null;
  const found: Node[] = [];
  let other = false;
  doc.nodesBetween(from, to, (node, pos) => {
    // Groups, and columns and the rows of them, hold blocks: looked into.
    if (CONTAINERS.has(node.type.name)) return true;
    if (node.type.name !== "blockContainer") return false;
    const content = node.firstChild!;
    const whole = from <= pos + 1 && pos + 1 + content.nodeSize <= to;
    if (whole && content.type.name === "image") found.push(content);
    else if (whole && !content.isTextblock) other = true;
    return true;
  });
  return found.length === 1 && !other ? String(found[0]!.attrs.url || "") || null : null;
}

/** An image for the clipboard: as PNG, the one kind every browser puts there, and its size. */
export type ClipboardImage = { png: Blob; width: number; height: number };

/** An image as PNG, with its size. */
export async function asPng(blob: Blob): Promise<ClipboardImage> {
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = bitmap;
    if (blob.type === "image/png") return { png: blob, width, height };
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((made) => (made ? resolve(made) : reject(new Error("no PNG"))), "image/png"),
    );
    return { png, width, height };
  } finally {
    bitmap.close();
  }
}

/**
 * Whether this browser is WebKit's (Safari, anything on an iPhone, and the
 * Mac app's window): it refuses a page's own write to the clipboard during
 * a copy that has written the clipboard already.
 */
export const isWebKit = (userAgent = navigator.userAgent) =>
  /AppleWebKit/.test(userAgent) && !/Chrome\/|Chromium|Edg\/|OPR\//.test(userAgent);

/**
 * Puts an image on the clipboard as an image, for other apps (a chat, a
 * mail) to paste: over what the copy itself wrote, which only Memoca can
 * show (a memoca:// address). Started within the copy, as browsers let a
 * page write the clipboard only then; the image itself comes once it is
 * read and made a PNG. Where the browser does not let it, or the image
 * fails or is overtaken by a later copy, the clipboard stays as the copy
 * left it.
 */
export function putImageOnClipboard(png: Promise<Blob>): void {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    png.catch(() => {});
    return;
  }
  navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).catch(() => {});
}

/** How long an image copied alone is still recognised when it is pasted back. */
const RECOGNISED_MS = 30 * 60 * 1000;

/** The last image copied alone: the block as Memoca copies it, and the image's size. */
let lastImage: { html: string; width: number; height: number; at: number } | null = null;

/** Remembers an image copied alone, as the clipboard now has it, to know it again when pasted. */
export function rememberImageCopy(copy: { html: string; width: number; height: number }): void {
  lastImage = { ...copy, at: Date.now() };
}

/** Forgets the last image copied alone: for tests. */
export function forgetImageCopy(): void {
  lastImage = null;
}

/** A paste being put back as the file it held, for BlockNote to take as it takes any file. */
let replaying = false;

/**
 * Pasting an image Memoca copied alone (one image, and nothing else on the
 * clipboard, of the size it was): the block it was copied from, pointing at
 * the same file, as a copy within Memoca pastes. Otherwise the clipboard
 * would hold a new picture to upload, taking room again and losing the
 * block's own width and caption. Told apart by the image's size: the
 * browser writes the PNG again its own way, so its bytes differ.
 *
 * True when it takes the paste on: the image is read after, and one of
 * another size (a screenshot taken since, say) is pasted as it would have
 * been.
 */
export function pasteOwnImage(event: ClipboardEvent, editor: BlockNoteEditor): boolean {
  const data = event.clipboardData;
  const last = lastImage;
  if (replaying || !data || !last || Date.now() - last.at > RECOGNISED_MS) return false;
  const files = [...data.files];
  if (files.length !== 1 || !files[0]!.type.startsWith("image/")) return false;
  if (data.types.includes("text/html") || data.types.includes("blocknote/html")) return false;
  const [file] = files as [File];
  void createImageBitmap(file)
    .then((bitmap) => {
      const same = bitmap.width === last.width && bitmap.height === last.height;
      bitmap.close();
      return same;
    })
    .catch(() => false)
    .then((same) => {
      if (same) {
        editor.pasteHTML(last.html, true);
        return;
      }
      const again = new DataTransfer();
      again.items.add(file);
      replaying = true;
      try {
        editor.prosemirrorView?.dom.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: again, bubbles: true, cancelable: true }),
        );
      } finally {
        replaying = false;
      }
    });
  return true;
}
