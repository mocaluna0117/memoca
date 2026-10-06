import * as Y from "yjs";
import { bodyFragment } from "@/lib/sync/ydoc";

/**
 * A link to a note: the app's own address for it, as the note list opens
 * it. An ordinary link, not a kind of block of its own, so every version of
 * Memoca shows it, and pasted into another app it opens the note in a
 * browser. In a note, a click on it opens the note here (note-editor).
 */
export function noteLink(noteId: string, origin = window.location.origin): string {
  return `${origin}/app?n=${encodeURIComponent(noteId)}`;
}

/** The note a link is to, if it is one of {@link noteLink}'s on this app's address. */
export function noteIdFromLink(href: string, origin = window.location.origin): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.pathname !== "/app") return null;
  return url.searchParams.get("n") || null;
}

/** The notes a note's body links to, each once, in the order they come. */
export function linkTargets(doc: Y.Doc, origin = window.location.origin): string[] {
  const found = new Set<string>();
  const walk = (node: Y.XmlFragment | Y.XmlElement | Y.XmlText) => {
    if (node instanceof Y.XmlText) {
      for (const part of node.toDelta() as { attributes?: { link?: { href?: unknown } } }[]) {
        const href = part.attributes?.link?.href;
        const id = typeof href === "string" ? noteIdFromLink(href, origin) : null;
        if (id) found.add(id);
      }
      return;
    }
    for (const child of node.toArray()) walk(child as Y.XmlElement | Y.XmlText);
  };
  walk(bodyFragment(doc));
  return [...found];
}
