import { type Block, BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { TextSelection } from "prosemirror-state";
import { afterEach, describe, expect, test } from "vitest";
import { linesForTodo, putBackLines, removeLines } from "@/lib/quick/move-lines";

let editor: BlockNoteEditor;
let host: HTMLDivElement | null = null;

afterEach(() => {
  editor?.unmount();
  host?.remove();
  host = null;
});

function editorOf(blocks: PartialBlock[]) {
  editor = BlockNoteEditor.create();
  host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  editor.replaceBlocks(editor.document, blocks);
  return editor;
}

/** Each block a line, a step in for each level: its type and text. */
function outline(): string[] {
  const lines: string[] = [];
  const walk = (blocks: Block[], depth: number) =>
    blocks.forEach((block) => {
      const text = Array.isArray(block.content)
        ? block.content.map((part) => ("text" in part ? part.text : "")).join("")
        : "";
      lines.push(`${"  ".repeat(depth)}${block.type}:${text}`);
      walk(block.children, depth + 1);
    });
  walk(editor.document, 0);
  return lines;
}

/** The text from the start of `from`'s line to the end of `to`'s selected. */
function select(from: string, to: string) {
  const view = editor.prosemirrorView!;
  const at = (text: string, end: boolean) => {
    let found = -1;
    view.state.doc.descendants((node, pos) => {
      if (found < 0 && node.isTextblock && node.textContent === text) found = pos + 1 + (end ? node.content.size : 0);
      return found < 0;
    });
    return found;
  };
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at(from, false), at(to, true))));
}

const IMAGE = { type: "image", props: { url: "https://example.com/a.png" } } as PartialBlock;

describe("lines indented under another, moved into the Todo", () => {
  test("are taken out of the tab, and put back where they were", () => {
    editorOf([
      { type: "bulletListItem", content: "買い物", children: [
        { type: "bulletListItem", content: "牛乳" },
        { type: "bulletListItem", content: "卵" },
        { type: "bulletListItem", content: "パン" },
      ] },
      { type: "paragraph", content: "あと" },
    ]);
    select("牛乳", "卵");
    const taken = linesForTodo(editor);
    expect(taken.all).toBe(false);
    expect(taken.blocks.map((block) => block.id)).toHaveLength(2);
    removeLines(editor, taken.blocks.map((block) => block.id));
    expect(outline()).toEqual(["bulletListItem:買い物", "  bulletListItem:パン", "paragraph:あと"]);

    putBackLines(editor, taken.blocks, taken.anchor);
    expect(outline()).toEqual([
      "bulletListItem:買い物",
      "  bulletListItem:牛乳",
      "  bulletListItem:卵",
      "  bulletListItem:パン",
      "paragraph:あと",
    ]);
  });

  test("the last of their list: put back after the one before them; all of it: back inside their parent", () => {
    editorOf([
      { type: "bulletListItem", content: "買い物", children: [
        { type: "bulletListItem", content: "牛乳" },
        { type: "bulletListItem", content: "卵" },
      ] },
    ]);
    select("牛乳", "卵");
    const taken = linesForTodo(editor);
    removeLines(editor, taken.blocks.map((block) => block.id));
    expect(outline()).toEqual(["bulletListItem:買い物"]);
    putBackLines(editor, taken.blocks, taken.anchor);
    expect(outline()).toEqual(["bulletListItem:買い物", "  bulletListItem:牛乳", "  bulletListItem:卵"]);
  });
});

describe("an image under a line moved into the Todo", () => {
  test("stays in the tab, where the line was", () => {
    editorOf([
      { type: "bulletListItem", content: "写真", children: [IMAGE] },
      { type: "paragraph", content: "あと" },
    ]);
    const taken = linesForTodo(editor);
    expect(taken.all).toBe(true);
    expect(taken.keepsSomething).toBe(true);
    removeLines(editor, taken.blocks.filter((block) => Array.isArray(block.content)).map((block) => block.id));
    expect(outline()).toEqual(["image:"]);

    // Put back: the lines, not the image a second time.
    putBackLines(editor, taken.blocks.filter((block) => Array.isArray(block.content)), taken.anchor);
    expect(outline().filter((line) => line.startsWith("image")).length + outline().filter((line) => line.includes("  image")).length).toBe(1);
  });

  test("nothing kept, all of it moved: an empty line left to write in", () => {
    editorOf([{ type: "paragraph", content: "一つ" }, { type: "paragraph", content: "二つ" }]);
    const taken = linesForTodo(editor);
    expect(taken.keepsSomething).toBe(false);
    removeLines(editor, taken.blocks.map((block) => block.id));
    expect(outline()).toEqual(["paragraph:"]);
  });
});
