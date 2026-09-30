import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { EditorState } from "prosemirror-state";
import { afterEach, describe, expect, test } from "vitest";
import { japaneseLists, listFromMarks } from "@/components/editor/japanese-lists";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

/** An editor with the extension, shown (its plugins run only then), holding these blocks. */
function editorOf(blocks: PartialBlock[]) {
  const editor = BlockNoteEditor.create({ extensions: [japaneseLists] });
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  unmount = () => {
    editor.unmount();
    host.remove();
  };
  editor.replaceBlocks(editor.document, blocks);
  return editor;
}

/** Each block a line: its type and text, indented by how deep it is. */
function outline(editor: BlockNoteEditor): string[] {
  const lines: string[] = [];
  const walk = (blocks: typeof editor.document, depth: number) =>
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

/** Every block made a bullet list item at once, as the toolbar does for those selected. */
function toBullets(editor: BlockNoteEditor, count = editor.document.length) {
  editor.transact(() => {
    for (const block of editor.document.slice(0, count)) {
      editor.updateBlock(block, { type: "bulletListItem" });
    }
  });
}

describe("lines written with ・, made a bullet list", () => {
  test("lose the ・, and whatever space follows it", () => {
    const editor = editorOf([
      { type: "paragraph", content: "・牛乳" },
      { type: "paragraph", content: "･ 卵" },
      { type: "paragraph", content: "•　パン" },
      { type: "paragraph", content: "バター" },
    ]);
    toBullets(editor);
    expect(outline(editor)).toEqual([
      "bulletListItem:牛乳",
      "bulletListItem:卵",
      "bulletListItem:パン",
      "bulletListItem:バター",
    ]);
  });

  test("lines of one block, each starting with ・: an item each", () => {
    const editor = editorOf([
      { type: "paragraph", content: "・牛乳\n・卵\n（二パック）\n・パン" },
      { type: "paragraph", content: "後" },
    ]);
    toBullets(editor, 1);
    expect(outline(editor)).toEqual([
      "bulletListItem:牛乳",
      "bulletListItem:卵\n（二パック）",
      "bulletListItem:パン",
      "paragraph:後",
    ]);
    // Each its own block, the first keeping the block's id.
    expect(new Set(editor.document.map((block) => block.id)).size).toBe(4);
  });

  test("the style of the text and what is inside the block stay", () => {
    const editor = editorOf([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "・", styles: {} },
          { type: "text", text: "太字", styles: { bold: true } },
        ],
        children: [{ type: "paragraph", content: "子" }],
      },
    ]);
    toBullets(editor, 1);
    const [item] = editor.document;
    expect(item!.content).toEqual([{ type: "text", text: "太字", styles: { bold: true } }]);
    expect(outline(editor)).toEqual(["bulletListItem:太字", "  paragraph:子"]);
  });

  test("a ・ typed at the start of an item already in a list stays", () => {
    const editor = editorOf([{ type: "bulletListItem", content: "項目" }]);
    const [item] = editor.document;
    editor.updateBlock(item!, { content: "・項目" });
    expect(outline(editor)).toEqual(["bulletListItem:・項目"]);
  });

  test("a numbered list, or a line with no ・, is left as it is", () => {
    const editor = editorOf([
      { type: "paragraph", content: "・一" },
      { type: "paragraph", content: "二" },
    ]);
    editor.transact(() => {
      for (const block of editor.document) editor.updateBlock(block, { type: "numberedListItem" });
    });
    expect(outline(editor)).toEqual(["numberedListItem:・一", "numberedListItem:二"]);
  });

  test("undone in one step", () => {
    const editor = editorOf([
      { type: "paragraph", content: "・牛乳" },
      { type: "paragraph", content: "・卵" },
    ]);
    toBullets(editor);
    expect(outline(editor)).toEqual(["bulletListItem:牛乳", "bulletListItem:卵"]);
    editor.undo();
    expect(outline(editor)).toEqual(["paragraph:・牛乳", "paragraph:・卵"]);
  });

  test("a first line with no ・ stays the first item, and each line with one is an item", () => {
    const editor = editorOf([{ type: "paragraph", content: "買い物リスト\n　・牛乳\n・卵" }]);
    toBullets(editor);
    expect(outline(editor)).toEqual([
      "bulletListItem:買い物リスト",
      "bulletListItem:牛乳",
      "bulletListItem:卵",
    ]);
  });

  test("empty lines before an item go, and ・・・ is not a bullet", () => {
    const editor = editorOf([
      { type: "paragraph", content: "・牛乳\n\n\n・卵" },
      { type: "paragraph", content: "・・・続く" },
    ]);
    toBullets(editor);
    expect(outline(editor)).toEqual([
      "bulletListItem:牛乳",
      "bulletListItem:卵",
      "bulletListItem:・・・続く",
    ]);
  });

  test("what was selected stays selected", () => {
    const editor = editorOf([
      { type: "paragraph", content: "・牛乳を買う" },
      { type: "paragraph", content: "・卵を買う" },
      { type: "paragraph", content: "おわり" },
    ]);
    const [first, second] = editor.document;
    editor.setSelection(first!, second!);
    const before = editor.prosemirrorState.selection;
    const text = editor.prosemirrorState.doc.textBetween(before.from, before.to, "|");
    toBullets(editor, 2);
    const after = editor.prosemirrorState.selection;
    expect(after.empty).toBe(false);
    expect(editor.prosemirrorState.doc.textBetween(after.from, after.to, "|")).toBe(
      text.replace(/・/g, ""),
    );
  });

  test("an item inside another, both made items at once, both lose theirs", () => {
    const editor = editorOf([
      {
        type: "paragraph",
        content: "・親",
        children: [{ type: "paragraph", content: "・子一\n・子二" }],
      },
    ]);
    editor.transact(() => {
      const [parent] = editor.document;
      editor.updateBlock(parent!.children[0]!, { type: "bulletListItem" });
      editor.updateBlock(parent!, { type: "bulletListItem" });
    });
    expect(outline(editor)).toEqual([
      "bulletListItem:親",
      "  bulletListItem:子一",
      "  bulletListItem:子二",
    ]);
  });

  test("pasted into an item, lines with ・ are made items; an item already with one keeps it", () => {
    const editor = editorOf([{ type: "bulletListItem", content: "" }]);
    const view = editor.prosemirrorView!;
    const start = view.state.doc.firstChild!.firstChild!.firstChild!;
    const at = 3 + start.content.size;
    const { schema } = view.state;
    const pasted = view.state.tr.insert(at, [
      schema.text("・牛乳"),
      schema.nodes.hardBreak!.create(),
      schema.text("・卵"),
    ]);
    view.dispatch(pasted.setMeta("uiEvent", "paste"));
    expect(outline(editor)).toEqual(["bulletListItem:牛乳", "bulletListItem:卵"]);

    // Pasted into one already starting with ・ (typed there): left as it is.
    const kept = editorOf([{ type: "bulletListItem", content: "・メモ" }]);
    const keptView = kept.prosemirrorView!;
    keptView.dispatch(
      keptView.state.tr.insertText("追記", 3 + "・メモ".length).setMeta("uiEvent", "paste"),
    );
    expect(outline(kept)).toEqual(["bulletListItem:・メモ追記"]);
  });

  test("a change an input rule made is left as it made it", () => {
    const editor = editorOf([{ type: "paragraph", content: "・a" }]);
    const before = editor.prosemirrorState;
    // The paragraph (inside the note's group and its block) made an item.
    const tr = before.tr.setNodeMarkup(2, before.schema.nodes.bulletListItem!);
    // As an input rule makes it, the change carries its plugin's record, to undo it by.
    const rules = before.plugins.find((plugin) => plugin.props.handleTextInput)!;
    // Not by apply, which would have the plugin's own change made already.
    const after = EditorState.create({ doc: tr.doc, plugins: before.plugins });
    expect(listFromMarks([tr], before, after)).not.toBeNull();
    tr.setMeta(rules, { transform: tr, from: 3, to: 3, text: "・" });
    expect(listFromMarks([tr], before, after)).toBeNull();
  });

  test("a change from another device is left as it came", () => {
    const editor = editorOf([{ type: "paragraph", content: "・a" }]);
    const view = editor.prosemirrorView!;
    const tr = view.state.tr.setNodeMarkup(2, view.state.schema.nodes.bulletListItem!);
    view.dispatch(tr.setMeta("y-sync$", { isChangeOrigin: true }));
    expect(outline(editor)).toEqual(["bulletListItem:・a"]);
  });

  test("a list pasted from elsewhere loses its ・; one Memoca copied keeps it", () => {
    const editor = editorOf([{ type: "paragraph", content: "" }]);
    if (typeof ClipboardEvent === "undefined") {
      (globalThis as { ClipboardEvent?: unknown }).ClipboardEvent = class extends Event {
        clipboardData = null;
      };
    }
    editor.pasteHTML("<ul><li>・りんご</li><li>・みかん</li></ul>");
    expect(outline(editor).filter((line) => line.startsWith("bulletListItem"))).toEqual([
      "bulletListItem:りんご",
      "bulletListItem:みかん",
    ]);

    // The same, as Memoca's own copy.
    const before = editor.prosemirrorState;
    const { schema } = before;
    const item = schema.nodes.blockContainer!.create(
      null,
      schema.nodes.bulletListItem!.create(null, schema.text("・メモ")),
    );
    const tr = before.tr.insert(1, item).setMeta("uiEvent", "paste");
    const after = EditorState.create({ doc: tr.doc, plugins: before.plugins });
    expect(listFromMarks([tr], before, after, false)).not.toBeNull();
    expect(listFromMarks([tr], before, after, true)).toBeNull();
  });

  test("a ・ further in a line, not at its start, is left", () => {
    const editor = editorOf([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "注意", styles: {} },
          { type: "text", text: "・重要", styles: { bold: true } },
        ],
      },
    ]);
    toBullets(editor);
    expect(outline(editor)).toEqual(["bulletListItem:注意・重要"]);
  });

  test("what is inside the block goes with its last item", () => {
    const editor = editorOf([
      { type: "paragraph", content: "・a\n・b", children: [{ type: "paragraph", content: "c" }] },
    ]);
    toBullets(editor);
    expect(outline(editor)).toEqual(["bulletListItem:a", "bulletListItem:b", "  paragraph:c"]);
  });
});
