import { shownType } from "./shown-type";

/**
 * Whether files are handed on through the share sheet here, rather than
 * saved: an iPhone or an iPad (iPadOS says it is a Mac; only the touch screen
 * gives it away). Saved as a download there, a file opens as it is, under the
 * site's address ("memoca-app.vercel.app"); the sheet shows its name, and
 * saves it to Files or opens it in another app. Anywhere else a download is
 * kept under its name.
 */
export function sharesFiles(userAgent: string, touchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1);
}

/** The extension a file of each type is saved with. */
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/bmp": "bmp",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "application/pdf": "pdf",
  "text/plain": "txt",
};
const KNOWN = new Set([...Object.values(EXTENSIONS), "jpeg"]);

/**
 * The name a file is saved under: its own, with the extension of what it is.
 * A photo pasted as 景色.png and stored as WebP is 景色.webp; an image with
 * no name (pasted from a web page) is file.png. A file of a type not shown
 * as it is keeps its name as it is.
 */
export function nameFor(name: string, type: string): string {
  const base = name.trim() || "file";
  const extension = EXTENSIONS[type.split(";")[0]!.trim().toLowerCase()];
  if (!extension) return base;
  const current = /\.([A-Za-z0-9]{1,5})$/.exec(base)?.[1]?.toLowerCase();
  if (current === extension || (extension === "jpg" && current === "jpeg")) return base;
  if (current && KNOWN.has(current)) return `${base.slice(0, -current.length)}${extension}`;
  return `${base}.${extension}`;
}

/** What became of a file the download button was pressed for. */
export type Opened =
  /** Saved, handed to the share sheet (or the sheet put away), or opened where it is. */
  | { kind: "done" }
  /**
   * On an iPhone, ready, but too long after the press for the share sheet,
   * which is shown only just after one: to be handed on at the next press.
   */
  | { kind: "ready"; share: () => Promise<void> }
  /** Nothing this tab can save: not on this device yet, gone, or not a file's address. */
  | { kind: "unavailable" };

const DONE: Opened = { kind: "done" };
const UNAVAILABLE: Opened = { kind: "unavailable" };

type Here = Window & typeof globalThis;

/**
 * Whether a download is under way. A press meanwhile is let go: a second
 * share sheet asked for while one is up is turned away, and the file would
 * be saved instead, to open as it is on an iPhone.
 */
let running = false;

/**
 * Downloads a file a note shows, from its download button, under its name:
 * on an iPhone or an iPad through the share sheet, anywhere else as a
 * download. One of this tab's own (a blob: URL, a locked note's file
 * decrypted here) or one from a server (stored readable, or an image pasted
 * from a web page), whose own address would have it open in a tab instead.
 *
 * What a server sends is given a type this tab shows as it is, or none at
 * all: a web page saved here as it said it was would run as a page of this
 * app. It is asked for with no cookies and no Referer. A file this tab may
 * not read (one from a site that does not allow it, say) opens where it is,
 * in a window with no hold on this one; anything but a file's address opens
 * nothing. `href` may be on its way still: a press meanwhile is let go too.
 */
export async function downloadFile(
  href: string | Promise<string>,
  name: string,
  here: Here = window,
): Promise<Opened> {
  if (running) return DONE;
  running = true;
  try {
    return await download(await href, name, here);
  } finally {
    running = false;
  }
}

async function download(href: string, name: string, here: Here): Promise<Opened> {
  let url: URL;
  try {
    url = new URL(href, here.location.href);
  } catch {
    return UNAVAILABLE;
  }
  const own = url.protocol === "blob:";
  if (own ? url.origin !== here.location.origin : !/^https?:$/.test(url.protocol)) {
    return UNAVAILABLE;
  }
  let blob: Blob;
  try {
    const response = await here.fetch(
      url.href,
      own ? undefined : { credentials: "omit", referrerPolicy: "no-referrer" },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    blob = await response.blob();
  } catch {
    // One of this tab's own that has gone (the vault closed) is not opened.
    if (own) return UNAVAILABLE;
    here.open(url.href, "_blank", "noopener,noreferrer");
    return DONE;
  }
  const type = shownType(blob.type);
  const file = new File([blob], nameFor(name, type), { type });
  // A URL of this tab's own already has a type safe to show (attachments.ts).
  const save = () => saveFile(file, here, own ? url.href : null);

  if (
    sharesFiles(here.navigator.userAgent, here.navigator.maxTouchPoints) &&
    here.navigator.canShare?.({ files: [file] })
  ) {
    const later: Opened = { kind: "ready", share: () => shareFile(file, here, save) };
    if (here.navigator.userActivation?.isActive === false) return later;
    try {
      await here.navigator.share({ files: [file] });
      return DONE;
    } catch (cause) {
      const reason = (cause as { name?: unknown } | null)?.name;
      // Put away without choosing: nothing more to do.
      if (reason === "AbortError") return DONE;
      // The press was too long ago after all.
      if (reason === "NotAllowedError") return later;
    }
  }
  save();
  return DONE;
}

/** Hands a file to the share sheet, at a press of its own; saved if the sheet will not have it. */
async function shareFile(file: File, here: Here, save: () => void): Promise<void> {
  try {
    await here.navigator.share({ files: [file] });
  } catch (cause) {
    if ((cause as { name?: unknown } | null)?.name !== "AbortError") save();
  }
}

/** Saves a file as a download under its name, from `url` when it has one already. */
function saveFile(file: File, here: Here, url: string | null): void {
  const href = url ?? here.URL.createObjectURL(file);
  const link = here.document.createElement("a");
  link.href = href;
  link.download = file.name;
  link.rel = "noopener";
  here.document.body.append(link);
  link.click();
  link.remove();
  if (!url) here.setTimeout(() => here.URL.revokeObjectURL(href), 60_000);
}
