import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYDoc, yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { appendParagraphs } from "@/lib/quick/body";
import { FRAGMENT, bodyFragment } from "@/lib/sync/ydoc";

const editor = BlockNoteEditor.create();

/** The body's shape as text, block ids left out: they are new each time. */
function shape(node: Y.XmlFragment | Y.XmlElement | Y.XmlText, depth = 0): string {
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
const valid = (doc: Y.Doc) => {
  yXmlFragmentToProseMirrorRootNode(bodyFragment(doc), editor.pmSchema).check();
  return true;
};

describe("appendParagraphs", () => {
  test("writes exactly what BlockNote writes, ids apart", () => {
    const ours = new Y.Doc();
    appendParagraphs(ours, ["一行目", "", "  三行目"]);
    const theirs = blocksToYDoc(
      editor,
      [
        { type: "paragraph", content: "一行目" },
        { type: "paragraph", content: "" },
        { type: "paragraph", content: "  三行目" },
      ],
      FRAGMENT,
    );
    expect(shape(bodyFragment(ours))).toBe(shape(bodyFragment(theirs)));
    expect(valid(ours)).toBe(true);
  });

  test("gives every block an id of its own, written in the body itself", () => {
    const doc = new Y.Doc();
    appendParagraphs(doc, ["a", "b"]);
    // Read from the body, not through BlockNote, which makes up an id for a block without one.
    const group = bodyFragment(doc).get(0) as Y.XmlElement;
    const ids = group.toArray().map((container) => (container as Y.XmlElement).getAttribute("id"));
    expect(new Set(ids).size).toBe(2);
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("adds after what the body already has, in its one block group", () => {
    const doc = blocksToYDoc(editor, [{ type: "paragraph", content: "前から" }], FRAGMENT);
    appendParagraphs(doc, ["足した"]);
    expect(bodyFragment(doc).length).toBe(1);
    expect(valid(doc)).toBe(true);
    const texts = yXmlFragmentToBlocks(editor, bodyFragment(doc)).map((block) =>
      (block.content as { text: string }[]).map((run) => run.text).join(""),
    );
    expect(texts).toEqual(["前から", "足した"]);
  });

  test("with nothing to add, leaves an empty body as the editor starts one", () => {
    const doc = new Y.Doc();
    appendParagraphs(doc, []);
    expect(bodyFragment(doc).length).toBe(0);
  });

  test("the shape it replaces, paragraphs straight in the body, is not one the schema accepts", () => {
    // What the quick note wrote before: the check above is what tells them apart.
    const doc = new Y.Doc();
    const paragraph = new Y.XmlElement("paragraph");
    bodyFragment(doc).insert(0, [paragraph]);
    paragraph.insert(0, [new Y.XmlText("一行目")]);
    expect(() => valid(doc)).toThrow();
  });
});
