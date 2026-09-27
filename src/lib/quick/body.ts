"use client";

import * as Y from "yjs";
import { bodyFragment } from "@/lib/sync/ydoc";

/** BlockNote's default props for a paragraph, which it writes out every time. */
const PARAGRAPH_PROPS = {
  backgroundColor: "default",
  textColor: "default",
  textAlignment: "left",
} as const;

/**
 * Adds a paragraph for each line at the end of a note's body, shaped exactly
 * as BlockNote writes one: in the body's one block group, a container with an
 * id of its own, and in it the paragraph with all its props. The editor then
 * opens on them as they are, rather than on something it has to repair first.
 */
export function appendParagraphs(doc: Y.Doc, lines: string[]): void {
  if (lines.length === 0) return;
  const fragment = bodyFragment(doc);
  doc.transact(() => {
    let group = fragment
      .toArray()
      .find(
        (node): node is Y.XmlElement =>
          node instanceof Y.XmlElement && node.nodeName === "blockGroup",
      );
    if (!group) {
      group = new Y.XmlElement("blockGroup");
      fragment.insert(fragment.length, [group]);
    }
    for (const line of lines) {
      const container = new Y.XmlElement("blockContainer");
      group.insert(group.length, [container]);
      container.setAttribute("id", crypto.randomUUID());
      const paragraph = new Y.XmlElement("paragraph");
      container.insert(0, [paragraph]);
      for (const [name, value] of Object.entries(PARAGRAPH_PROPS)) {
        paragraph.setAttribute(name, value);
      }
      // An empty paragraph has no text in it at all, as BlockNote leaves it.
      if (line.length > 0) {
        const text = new Y.XmlText();
        paragraph.insert(0, [text]);
        text.insert(0, line);
      }
    }
  });
}

/**
 * The lines of a body in the shape quick notes wrote before they wrote it as
 * BlockNote does: a bare paragraph per line straight in the body, holding
 * nothing but its text. Null for any other body, an empty one included.
 */
function oldQuickLines(fragment: Y.XmlFragment): string[] | null {
  const nodes = fragment.toArray();
  if (nodes.length === 0) return null;
  const lines: string[] = [];
  for (const node of nodes) {
    if (!(node instanceof Y.XmlElement) || node.nodeName !== "paragraph") return null;
    let line = "";
    for (const part of node.toArray()) {
      if (!(part instanceof Y.XmlText)) return null;
      for (const chunk of part.toDelta() as { insert?: unknown }[]) {
        if (typeof chunk.insert === "string") line += chunk.insert;
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Rewrites a body in that old shape as BlockNote writes one, line for line,
 * empty lines included. BlockNote cannot open the old shape as it is: it
 * nests each line inside the one before, and saves that at the first
 * keystroke. Any other body is left as it is, so a body rewritten once is
 * never rewritten again.
 */
export function migrateOldQuickBody(doc: Y.Doc): void {
  const fragment = bodyFragment(doc);
  const lines = oldQuickLines(fragment);
  if (!lines) return;
  // One transaction, so that the rewrite is a single edit.
  doc.transact(() => {
    fragment.delete(0, fragment.length);
    appendParagraphs(doc, lines);
  });
}
