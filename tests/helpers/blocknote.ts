import { BlockNoteEditor } from "@blocknote/core";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import { bodyFragment } from "@/lib/sync/ydoc";

/** An editor with nothing added, for BlockNote's own schema and its own way of writing. */
export const editor = BlockNoteEditor.create();

/** The body's shape as text, block ids left out: they are new each time. */
export function shape(node: Y.XmlFragment | Y.XmlElement | Y.XmlText, depth = 0): string {
  const pad = "  ".repeat(depth);
  if (node instanceof Y.XmlText) return `${pad}"${node.toString()}"\n`;
  const own =
    node instanceof Y.XmlElement
      ? `${pad}${node.nodeName} ${JSON.stringify(
          Object.entries(node.getAttributes())
            .filter(([name]) => name !== "id")
            .sort(),
        )}\n`
      : "";
  const inner = depth + (node instanceof Y.XmlElement ? 1 : 0);
  return (
    own +
    node
      .toArray()
      .map((child) => shape(child as Y.XmlElement | Y.XmlText, inner))
      .join("")
  );
}

/** Whether the body is one BlockNote's schema accepts, as the editor would load it. */
export const valid = (doc: Y.Doc) => {
  yXmlFragmentToProseMirrorRootNode(bodyFragment(doc), editor.pmSchema).check();
  return true;
};
