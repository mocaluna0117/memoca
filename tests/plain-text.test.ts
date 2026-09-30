import { BlockNoteEditor } from "@blocknote/core";
import { describe, expect, test } from "vitest";
import { plainTextBetween, plainTextOf } from "@/lib/plain-text";

/** A note holding this HTML, as BlockNote reads it. */
async function noteOf(html: string) {
  const editor = BlockNoteEditor.create();
  editor.replaceBlocks(editor.document, await editor.tryParseHTMLToBlocks(html));
  return editor.prosemirrorState.doc;
}

/** The whole note's text. */
const all = async (html: string) => {
  const doc = await noteOf(html);
  return plainTextBetween(doc, 0, doc.content.size);
};

describe("copying from a note, as plain text", () => {
  test("a line break within a paragraph is a line break, not a backslash", async () => {
    expect(await all("<p>一行目<br>二行目</p><p>三行目</p>")).toBe("一行目\n二行目\n三行目");
  });

  test("a block a line, with no blank line between them; an empty block is one", () => {
    const editor = BlockNoteEditor.create();
    editor.replaceBlocks(editor.document, [
      { type: "paragraph", content: "上" },
      { type: "paragraph" },
      { type: "paragraph", content: "下" },
    ]);
    const doc = editor.prosemirrorState.doc;
    expect(plainTextBetween(doc, 0, doc.content.size)).toBe("上\n\n下");
  });

  test("marks in the text stay as they are, with nothing escaped", async () => {
    expect(await all("<p>a_b*c https://example.com/a_b</p><p># 見出しではない</p>")).toBe(
      "a_b*c https://example.com/a_b\n# 見出しではない",
    );
  });

  test("list items keep their marks: ・, numbers from where the list starts, ☐ and ☑", async () => {
    expect(
      await all(
        '<ul><li>牛乳</li><li>卵</li></ul><ol start="3"><li>三</li><li>四</li></ol><p>段落</p><ol><li>一</li></ol>',
      ),
    ).toBe("・牛乳\n・卵\n3. 三\n4. 四\n段落\n1. 一");
    const editor = BlockNoteEditor.create();
    editor.replaceBlocks(editor.document, [
      { type: "checkListItem", content: "済", props: { checked: true } },
      { type: "checkListItem", content: "まだ" },
    ]);
    const checks = editor.prosemirrorState.doc;
    expect(plainTextBetween(checks, 0, checks.content.size)).toBe("☑ 済\n☐ まだ");
  });

  test("a nested block keeps its indent, and a line break in an item goes on under its text", async () => {
    const editor = BlockNoteEditor.create();
    editor.replaceBlocks(editor.document, [
      {
        type: "bulletListItem",
        content: "親",
        children: [{ type: "bulletListItem", content: "子" }],
      },
      { type: "numberedListItem", content: "一行目\n二行目" },
    ]);
    const doc = editor.prosemirrorState.doc;
    expect(plainTextBetween(doc, 0, doc.content.size)).toBe("・親\n  ・子\n1. 一行目\n   二行目");
    const bullets = BlockNoteEditor.create();
    bullets.replaceBlocks(bullets.document, [
      { type: "bulletListItem", content: "上\n下" },
      { type: "bulletListItem", content: "次" },
    ]);
    const list = bullets.prosemirrorState.doc;
    // Under a ・, as wide as it: a full-width space.
    expect(plainTextBetween(list, 0, list.content.size)).toBe("・上\n　下\n・次");
  });

  test("from within one block, just the text selected, with no mark", async () => {
    const doc = await noteOf("<ul><li>牛乳を買う</li></ul>");
    // Inside the item's text: 牛乳を買う starts one past the textblock's start.
    let start = 0;
    doc.descendants((node, pos) => {
      if (node.isTextblock && start === 0) start = pos + 1;
      return true;
    });
    expect(plainTextBetween(doc, start, start + 2)).toBe("牛乳");
  });

  test("an image leaves nothing", async () => {
    const editor = BlockNoteEditor.create();
    editor.replaceBlocks(editor.document, [
      { type: "paragraph", content: "前" },
      { type: "image", props: { url: "memoca://att/0190" } },
      { type: "paragraph", content: "後" },
    ]);
    const doc = editor.prosemirrorState.doc;
    expect(plainTextBetween(doc, 0, doc.content.size)).toBe("前\n後");
  });

  /** Where each textblock's text starts and ends, in order. */
  const textblocks = (doc: BlockNoteEditor["prosemirrorState"]["doc"]) => {
    const found: { start: number; end: number }[] = [];
    doc.descendants((node, pos) => {
      if (node.isTextblock) found.push({ start: pos + 1, end: pos + node.nodeSize - 1 });
      return true;
    });
    return found;
  };

  test("a line the selection only touches the edge of is left out", async () => {
    const editor = BlockNoteEditor.create();
    editor.replaceBlocks(editor.document, [
      { type: "paragraph", content: "Hello" },
      { type: "bulletListItem", content: "it" },
    ]);
    const doc = editor.prosemirrorState.doc;
    const [hello, item] = textblocks(doc);
    // To the start of the next line, as a drag or Shift+↓ ends.
    expect(plainTextBetween(doc, hello!.start, item!.start)).toBe("Hello");
    // From the end of a line into the next.
    expect(plainTextBetween(doc, hello!.end, item!.end)).toBe("it");
  });

  test("the indent is counted from the least nested block taken", () => {
    const editor = BlockNoteEditor.create();
    editor.replaceBlocks(editor.document, [
      {
        type: "bulletListItem",
        content: "親",
        children: [
          { type: "bulletListItem", content: "子一" },
          {
            type: "bulletListItem",
            content: "子二",
            children: [{ type: "bulletListItem", content: "孫" }],
          },
        ],
      },
    ]);
    const doc = editor.prosemirrorState.doc;
    const [, first, , grandchild] = textblocks(doc);
    expect(plainTextBetween(doc, first!.start, grandchild!.end)).toBe("・子一\n・子二\n  ・孫");
  });

  test("a table is a row a line, its cells apart by tabs", () => {
    const editor = BlockNoteEditor.create();
    editor.replaceBlocks(editor.document, [
      { type: "paragraph", content: "表" },
      {
        type: "table",
        content: {
          type: "tableContent",
          rows: [{ cells: ["A1", "B1"] }, { cells: ["A2", "B2"] }],
        },
      },
    ]);
    const doc = editor.prosemirrorState.doc;
    expect(plainTextBetween(doc, 0, doc.content.size)).toBe("表\nA1\tB1\nA2\tB2");

    // Cells of it, selected as cells: all of them, not only the one the
    // selection ends in.
    const cells: { node: typeof doc; pos: number }[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name === "tableCell") cells.push({ node, pos });
      return true;
    });
    const selection = {
      from: cells[3]!.pos,
      to: cells[3]!.pos + cells[3]!.node.nodeSize,
      forEachCell: (f: (cell: typeof doc, pos: number) => void) =>
        cells.forEach(({ node, pos }) => f(node, pos)),
    };
    expect(plainTextOf(doc, selection)).toBe("A1\tB1\nA2\tB2");
    expect(plainTextOf(doc, { from: 0, to: doc.content.size })).toBe("表\nA1\tB1\nA2\tB2");
  });

  test("from the middle of a line into the next, from where it starts", () => {
    const editor = BlockNoteEditor.create();
    editor.replaceBlocks(editor.document, [
      { type: "paragraph", content: "Hello" },
      { type: "bulletListItem", content: "it" },
    ]);
    const doc = editor.prosemirrorState.doc;
    const [hello, item] = textblocks(doc);
    expect(plainTextBetween(doc, hello!.start + 2, item!.end)).toBe("llo\n・it");
  });

  test("a line break in a nested item goes on under its text, indented with it", () => {
    const editor = BlockNoteEditor.create();
    editor.replaceBlocks(editor.document, [
      { type: "paragraph", content: "上" },
      {
        type: "bulletListItem",
        content: "親",
        children: [{ type: "bulletListItem", content: "a\nb" }],
      },
    ]);
    const doc = editor.prosemirrorState.doc;
    expect(plainTextBetween(doc, 0, doc.content.size)).toBe("上\n・親\n  ・a\n  　b");
  });

  test("a nested numbered list counts on its own", () => {
    const editor = BlockNoteEditor.create();
    editor.replaceBlocks(editor.document, [
      {
        type: "numberedListItem",
        content: "一",
        children: [{ type: "numberedListItem", content: "子" }],
      },
      { type: "numberedListItem", content: "二" },
    ]);
    const doc = editor.prosemirrorState.doc;
    expect(plainTextBetween(doc, 0, doc.content.size)).toBe("1. 一\n  1. 子\n2. 二");
  });

  test("a table's cells: a line break in one is a space, and only cells taken are there", () => {
    const editor = BlockNoteEditor.create();
    editor.replaceBlocks(editor.document, [
      { type: "paragraph", content: "表" },
      {
        type: "table",
        content: { type: "tableContent", rows: [{ cells: ["A\nB", "C"] }, { cells: ["D", "E"] }] },
      },
    ]);
    const doc = editor.prosemirrorState.doc;
    expect(plainTextBetween(doc, 0, doc.content.size)).toBe("表\nA B\tC\nD\tE");
    const [line, a1, c1] = textblocks(doc);
    // Ending at the start of the table's first cell: the table is not taken.
    expect(plainTextBetween(doc, line!.start, a1!.start)).toBe("表");
    // Ending within its first cell: that cell, and not the rest of its row.
    expect(plainTextBetween(doc, line!.start, a1!.start + 1)).toBe("表\nA B");
    expect(c1).toBeDefined();
  });
});
