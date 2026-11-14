import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { describe, expect, test } from "vitest";
import { SCHEMA } from "@/components/editor/schema";
import { blockAfter, blockBefore, type Found } from "@/components/editor/select-media";

function docOf(blocks: PartialBlock[]) {
  const editor = BlockNoteEditor.create({ schema: SCHEMA as never }) as unknown as BlockNoteEditor;
  editor.replaceBlocks(editor.document, blocks as never);
  return editor.prosemirrorState.doc;
}

const blocks = [
  { type: "paragraph", content: "上" },
  {
    type: "columnList",
    children: [
      { type: "column", children: [{ type: "paragraph", content: "左1" }, { type: "paragraph", content: "左2" }] },
      { type: "column", children: [{ type: "paragraph", content: "右" }] },
    ],
  },
  { type: "paragraph", content: "下" },
] as unknown as PartialBlock[];

function blockOf(doc: ReturnType<typeof docOf>, text: string): Found {
  let found: Found | null = null;
  doc.descendants((node, pos) => {
    if (!found && node.type.name === "blockContainer" && node.firstChild!.textContent === text) found = { node, pos };
    return !found;
  });
  if (!found) throw new Error(text);
  return found;
}

const text = (found: Found | null) => found?.node.firstChild!.textContent ?? null;
const all = () => true;

describe("chosen blocks moved with ↑ and ↓ past columns", () => {
  test("down: into the first column, from one column to the next, and out under them", () => {
    const doc = docOf(blocks);
    const order = ["上", "左1", "左2", "右", "下"];
    for (let i = 0; i < order.length - 1; i += 1) {
      expect(text(blockAfter(doc, blockOf(doc, order[i]!), all))).toBe(order[i + 1]);
    }
    expect(blockAfter(doc, blockOf(doc, "下"), all)).toBeNull();
  });

  test("up: the same way back", () => {
    const doc = docOf(blocks);
    const order = ["下", "右", "左2", "左1", "上"];
    for (let i = 0; i < order.length - 1; i += 1) {
      expect(text(blockBefore(doc, blockOf(doc, order[i]!), all))).toBe(order[i + 1]);
    }
    expect(blockBefore(doc, blockOf(doc, "上"), all)).toBeNull();
  });
});
