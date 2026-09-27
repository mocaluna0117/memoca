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
