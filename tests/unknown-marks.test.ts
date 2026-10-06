import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { describe, expect, test } from "vitest";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import { bodyFragment, extractText } from "@/lib/sync/ydoc";

/** The first piece of text in a body, however deep. */
function firstText(node: Y.XmlFragment | Y.XmlElement): Y.XmlText | null {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) return child;
    const found = firstText(child as Y.XmlElement);
    if (found) return found;
  }
  return null;
}

describe("a note written by a later version, with a mark this one does not know", () => {
  test("opens with its text, the mark left out, and nothing taken out of the note", () => {
    const editor = BlockNoteEditor.create();
    const doc = new Y.Doc();
    blocksToYXmlFragment(editor, [{ type: "paragraph", content: "大きな文字" }], bodyFragment(doc));
    // As a later version marks it: a style this one has no such mark for.
    firstText(bodyFragment(doc))!.format(0, 3, { fontSize: { stringValue: "1.5em" } });

    const node = yXmlFragmentToProseMirrorRootNode(bodyFragment(doc), editor.pmSchema);
    expect(node.textContent).toBe("大きな文字");
    expect(extractText(doc)).toContain("大きな文字");
  });
});
