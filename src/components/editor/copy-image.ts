import type { BlockNoteEditor } from "@blocknote/core";
import type { Node } from "prosemirror-model";
import { NodeSelection, type Selection, TextSelection } from "prosemirror-state";

/** What holds blocks without being one: a block's group, a row of columns, a column. */
const CONTAINERS = new Set(["blockGroup", "columnList", "column"]);

/** An image block a copy takes: the file it points at, and the name it was added with. */
export type CopiedImage = { url: string; name: string };

/**
 * The images a selection takes and nothing else (no text, no other block),
 * in order: one selected by a click, or any number with Shift and the arrow
 * keys (empty lines between them are let be). Null if it takes anything else,
 * or no image.
 */
export function imagesAlone(doc: Node, selection: Selection): CopiedImage[] | null {
  const copied = (image: Node): CopiedImage | null => {
    const url = String(image.attrs.url || "");
    return url ? { url, name: String(image.attrs.name || "") } : null;
  };
  if (selection instanceof NodeSelection) {
    const node = selection.node;
    const image = node.type.name === "image" ? node : node.firstChild;
    const one = image?.type.name === "image" ? copied(image) : null;
    return one ? [one] : null;
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
  if (found.length === 0 || other) return null;
  const images = found.map(copied);
  return images.every((image) => image !== null) ? (images as CopiedImage[]) : null;
}

/** The image a selection takes and nothing else: its url, or null (see {@link imagesAlone}). */
export function imageAlone(doc: Node, selection: Selection): string | null {
  const images = imagesAlone(doc, selection);
  return images?.length === 1 ? images[0]!.url : null;
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

/** An image's size, in pixels. */
export type ImageSize = { width: number; height: number };

export async function sizeOf(blob: Blob): Promise<ImageSize> {
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  bitmap.close();
  return { width, height };
}

/** Space left between two images joined into one, and around them. */
const STITCH_GAP = 16;

/**
 * The most a canvas may be, in WebKit (Safari, the iPhone): on a side, and
 * in all. Chrome allows more; a canvas past them draws nothing.
 */
const CANVAS_SIDE = 16_384;
const CANVAS_AREA = 16_777_216;

/**
 * Several images joined into one PNG, top to bottom on white, for a
 * browser to put on the clipboard: it takes one image, not several. Made
 * smaller, all alike, only where it would not fit in a canvas.
 */
export async function stitch(blobs: Blob[]): Promise<ClipboardImage> {
  const bitmaps = await Promise.all(blobs.map((blob) => createImageBitmap(blob)));
  try {
    const wide = Math.max(...bitmaps.map((bitmap) => bitmap.width)) + STITCH_GAP * 2;
    const tall =
      bitmaps.reduce((sum, bitmap) => sum + bitmap.height, 0) + STITCH_GAP * (bitmaps.length + 1);
    const scale = Math.min(
      1,
      CANVAS_SIDE / wide,
      CANVAS_SIDE / tall,
      Math.sqrt(CANVAS_AREA / (wide * tall)),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(wide * scale));
    canvas.height = Math.max(1, Math.floor(tall * scale));
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    let top = STITCH_GAP;
    for (const bitmap of bitmaps) {
      context.drawImage(
        bitmap,
        STITCH_GAP * scale,
        top * scale,
        bitmap.width * scale,
        bitmap.height * scale,
      );
      top += bitmap.height + STITCH_GAP;
    }
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((made) => (made ? resolve(made) : reject(new Error("no PNG"))), "image/png"),
    );
    return { png, width: canvas.width, height: canvas.height };
  } finally {
    for (const bitmap of bitmaps) bitmap.close();
  }
}

/** The kinds of image other apps (a chat, a mail) take as they are; any other is sent as PNG. */
const SHARED_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * An image as a file of its own, for the desktop shell to put on the
 * clipboard with the others: named as it was added (or 画像-n), its bytes
 * as they are where other apps take that kind, base64.
 */
export async function asFile(
  blob: Blob,
  name: string,
  index: number,
): Promise<{ file: { name: string; data: string }; size: ImageSize }> {
  let bytes = blob;
  let ext = SHARED_TYPES[blob.type];
  let size: ImageSize;
  if (ext) {
    size = await sizeOf(blob);
  } else {
    const { png, width, height } = await asPng(blob);
    bytes = png;
    ext = "png";
    size = { width, height };
  }
  const stem = name.replace(/\.[^.]*$/, "").trim() || `画像-${index + 1}`;
  return { file: { name: `${stem}.${ext}`, data: await base64Of(bytes) }, size };
}

async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // In pieces: one call with every byte as an argument overflows the stack.
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
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

/**
 * The last images copied alone: the blocks as Memoca copies them, and the
 * size of each image the clipboard has for them (one, joined, from a
 * browser; one each from the desktop shell).
 */
let lastImage: { html: string; sizes: ImageSize[]; at: number } | null = null;

/** Remembers images copied alone, as the clipboard now has them, to know them again when pasted. */
export function rememberImageCopy(copy: { html: string; sizes: ImageSize[] }): void {
  lastImage = { ...copy, at: Date.now() };
}

/** Forgets the last image copied alone: for tests. */
export function forgetImageCopy(): void {
  lastImage = null;
}

/** A paste being put back as the file it held, for BlockNote to take as it takes any file. */
let replaying = false;

/**
 * Pasting images Memoca copied alone (as many images as it put there, and
 * nothing else on the clipboard, each of the size it was): the blocks they
 * were copied from, pointing at the same files, as a copy within Memoca
 * pastes. Otherwise the clipboard would hold new pictures to upload, taking
 * room again and losing the blocks' own widths and captions. Told apart by
 * the images' sizes: the browser writes a PNG again its own way, so its
 * bytes differ.
 *
 * True when it takes the paste on: the images are read after, and ones of
 * another size (a screenshot taken since, say) are pasted as they would
 * have been.
 */
export function pasteOwnImage(event: ClipboardEvent, editor: BlockNoteEditor): boolean {
  const data = event.clipboardData;
  const last = lastImage;
  if (replaying || !data || !last || Date.now() - last.at > RECOGNISED_MS) return false;
  const files = [...data.files];
  if (
    files.length !== last.sizes.length ||
    !files.every((file) => file.type.startsWith("image/"))
  ) {
    return false;
  }
  if (data.types.includes("text/html") || data.types.includes("blocknote/html")) return false;
  // In any order: an app may hand files over in another.
  const key = ({ width, height }: ImageSize) => `${width}x${height}`;
  const wanted = last.sizes.map(key).sort().join();
  void Promise.all(files.map(sizeOf))
    .then((sizes) => sizes.map(key).sort().join() === wanted)
    .catch(() => false)
    .then((same) => {
      if (same) {
        editor.pasteHTML(last.html, true);
        return;
      }
      const again = new DataTransfer();
      for (const file of files) again.items.add(file);
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
