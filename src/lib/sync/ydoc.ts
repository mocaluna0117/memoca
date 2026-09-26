"use client";

import * as Y from "yjs";
import { idFromRef } from "@/lib/media/ref";

/** The single Yjs fragment BlockNote edits, per note. */
export const FRAGMENT = "body";

/** Origins we tag our own applications with, so the observer can ignore them. */
export const ORIGIN = {
  remote: Symbol("memoca:remote"),
  load: Symbol("memoca:load"),
} as const;

export function bodyFragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(FRAGMENT);
}

/**
 * Plain text of a note, read straight from the CRDT.
 *
 * Search has to cover notes this device has never opened in the editor, so the
 * text is pulled out of the document structure rather than from a live editor
 * instance.
 */
export function extractText(doc: Y.Doc, limit = 20_000): string {
  const parts: string[] = [];
  let length = 0;

  const walk = (node: Y.XmlFragment | Y.XmlElement | Y.XmlText | Y.AbstractType<unknown>) => {
    if (length >= limit) return;
    if (node instanceof Y.XmlText) {
      for (const chunk of node.toDelta() as { insert?: unknown }[]) {
        if (typeof chunk.insert === "string") {
          parts.push(chunk.insert);
          length += chunk.insert.length;
        }
      }
      return;
    }
    if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
      const children = node.toArray();
      for (const child of children) {
        walk(child as Y.XmlElement | Y.XmlText);
        if (length >= limit) return;
      }
      // Block boundaries become line breaks so search snippets stay readable.
      if (node instanceof Y.XmlElement) parts.push("\n");
    }
  };

  walk(bodyFragment(doc));
  return parts.join("").replace(/\n{2,}/g, "\n").trim().slice(0, limit);
}

/**
 * The files a note uses: every attachment reference in its blocks' props
 * (an image's, video's or file's url) and, to be safe, in text marks such as
 * a link. The server is told these so it knows which files are still in use.
 */
export function attachmentRefs(doc: Y.Doc): string[] {
  const found = new Set<string>();
  const take = (value: unknown) => {
    if (typeof value === "string") {
      const id = idFromRef(value);
      if (id) found.add(id);
    } else if (value && typeof value === "object") {
      for (const inner of Object.values(value)) take(inner);
    }
  };
  const walk = (node: Y.XmlFragment | Y.XmlElement | Y.XmlText | Y.AbstractType<unknown>) => {
    if (node instanceof Y.XmlText) {
      for (const chunk of node.toDelta() as { attributes?: unknown }[]) take(chunk.attributes);
      return;
    }
    if (node instanceof Y.XmlElement) take(node.getAttributes());
    if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
      for (const child of node.toArray()) walk(child as Y.XmlElement | Y.XmlText);
    }
  };
  walk(bodyFragment(doc));
  return [...found].sort();
}

/** First non-empty line, used as the list preview and the quick-note title. */
export function firstLine(text: string, limit = 120): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.trim().slice(0, limit);
}

export function mergeUpdates(updates: Uint8Array[]): Uint8Array {
  if (updates.length === 0) return new Uint8Array();
  if (updates.length === 1) return updates[0]!;
  return Y.mergeUpdates(updates);
}

export { Y };
