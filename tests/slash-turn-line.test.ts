import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { SuggestionMenu, getDefaultSlashMenuItems } from "@blocknote/core/extensions";
import { TextSelection } from "prosemirror-state";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { SCHEMA } from "@/components/editor/schema";
import { turningLines } from "@/components/editor/slash-turn-line";

// The / menu keeps where it is to be shown as getBoundingClientRect().toJSON(),
// which jsdom's rectangles have not.
const bounds = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    const rect = bounds.call(this);
    return Object.assign(rect, { toJSON: () => ({ ...rect }) });
  };
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = bounds;
});

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

/** An editor with the / menu, shown (its keys work only then), holding these blocks. */
function editorOf(blocks: PartialBlock[]) {
  const editor = BlockNoteEditor.create({ schema: SCHEMA as never }) as unknown as BlockNoteEditor;
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  unmount = () => {
    editor.unmount();
    host.remove();
  };
  editor.getExtension(SuggestionMenu)!.addSuggestionMenu({ triggerCharacter: "/" });
  editor.replaceBlocks(editor.document, blocks);
  return editor;
}

/** Each block a line: its type, text and the props it has set, indented by how deep it is. */
function outline(editor: BlockNoteEditor): string[] {
  const lines: string[] = [];
  const walk = (blocks: typeof editor.document, depth: number) =>
    blocks.forEach((block) => {
      const text = Array.isArray(block.content)
        ? block.content.map((part) => ("text" in part ? part.text : "")).join("")
        : "";
      const set = Object.entries(block.props as Record<string, unknown>)
        .filter(([, value]) => value !== "default" && value !== "left" && value !== false)
        .map(([name, value]) => ` ${name}=${String(value)}`)
        .join("");
      lines.push(`${"  ".repeat(depth)}${block.type}:${text}${set}`);
      walk(block.children, depth + 1);
    });
  walk(editor.document, 0);
  return lines;
}

/** The caret in the line of this text, `offset` in (at its end when not given). */
function caret(editor: BlockNoteEditor, text: string, offset = text.length) {
  const view = editor.prosemirrorView!;
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isTextblock && node.textContent === text) at = pos + 1;
    return at < 0;
  });
  if (at < 0) throw new Error(`no line "${text}"`);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at + offset)));
}

/** Text typed, a character at a time, as the editor takes it (its / menu among it). */
function type(editor: BlockNoteEditor, text: string) {
  const view = editor.prosemirrorView!;
  for (const char of text) {
    const { from, to } = view.state.selection;
    const insert = () => view.state.tr.insertText(char, from, to);
    if (!view.someProp("handleTextInput", (handle) => handle(view, from, to, char, insert))) {
      view.dispatch(insert());
    }
  }
}

/** The / menu's item of this key chosen, as the menu does: closed, what was typed after / taken away, then the item. */
function choose(editor: BlockNoteEditor, key: string) {
  const menu = editor.getExtension(SuggestionMenu)!;
  const item = turningLines(editor, getDefaultSlashMenuItems(editor)).find(
    (each) => each.key === key,
  );
  if (!item) throw new Error(`no item "${key}"`);
  menu.closeMenu();
  menu.clearQuery();
  item.onItemClick();
}

/** Where the caret is: the text of its line, and how far in. */
function where(editor: BlockNoteEditor) {
  const { $from } = editor.prosemirrorView!.state.selection;
  return { line: $from.parent.textContent, offset: $from.parentOffset };
}

describe("a block with text chosen from the / menu in a line with text", () => {
  test("makes a bullet a toggle, where it is, with its text", () => {
    const editor = editorOf([
      { type: "bulletListItem", content: "買い物" },
      { type: "paragraph", content: "次" },
    ]);
    caret(editor, "買い物");
    type(editor, "/とぐる");
    choose(editor, "toggle_list");
    expect(outline(editor)).toEqual(["toggleListItem:買い物", "paragraph:次"]);
    expect(where(editor)).toEqual({ line: "買い物", offset: 3 });
  });

  test("each kind, from a paragraph", () => {
    for (const [key, made] of [
      ["heading", "heading:行 level=1"],
      ["heading_3", "heading:行 level=3"],
      ["toggle_heading_2", "heading:行 level=2 isToggleable=true"],
      ["quote", "quote:行"],
      ["toggle_list", "toggleListItem:行"],
      ["numbered_list", "numberedListItem:行"],
      ["bullet_list", "bulletListItem:行"],
      ["check_list", "checkListItem:行"],
      ["code_block", "codeBlock:行 language=text"],
    ] as const) {
      const editor = editorOf([{ type: "paragraph", content: "行" }]);
      caret(editor, "行");
      type(editor, "/");
      choose(editor, key);
      expect(outline(editor)).toEqual([made]);
      unmount?.();
      unmount = null;
    }
  });

  test("keeps what is inside the line inside it", () => {
    const editor = editorOf([
      {
        type: "bulletListItem",
        content: "親",
        children: [{ type: "bulletListItem", content: "子" }],
      },
    ]);
    caret(editor, "親");
    type(editor, "/");
    choose(editor, "check_list");
    expect(outline(editor)).toEqual(["checkListItem:親", "  bulletListItem:子"]);
  });

  test("with the caret in the middle of the line, the text on both sides of the / stays", () => {
    const editor = editorOf([{ type: "paragraph", content: "前後" }]);
    caret(editor, "前後", 1);
    type(editor, "/");
    choose(editor, "numbered_list");
    expect(outline(editor)).toEqual(["numberedListItem:前後"]);
    expect(where(editor)).toEqual({ line: "前後", offset: 1 });
  });

  test("a toggle heading made a heading is no longer a toggle", () => {
    const editor = editorOf([
      { type: "heading", content: "章", props: { level: 2, isToggleable: true } },
    ]);
    caret(editor, "章");
    type(editor, "/");
    choose(editor, "heading");
    expect(outline(editor)).toEqual(["heading:章 level=1"]);
  });

  test("テキスト makes a list item plain text again", () => {
    const editor = editorOf([{ type: "checkListItem", content: "済", props: { checked: true } }]);
    caret(editor, "済");
    type(editor, "/");
    choose(editor, "paragraph");
    expect(outline(editor)).toEqual(["paragraph:済"]);
  });

  test("in an empty line, makes it that block, as before", () => {
    const editor = editorOf([{ type: "paragraph", content: "" }]);
    caret(editor, "");
    type(editor, "/");
    choose(editor, "toggle_list");
    expect(outline(editor)).toEqual(["toggleListItem:"]);
  });
});

describe("a block without text chosen in a line with text", () => {
  test("still goes after it, the line as it was", () => {
    const editor = editorOf([{ type: "bulletListItem", content: "買い物" }]);
    caret(editor, "買い物");
    type(editor, "/");
    choose(editor, "divider");
    expect(outline(editor).slice(0, 2)).toEqual(["bulletListItem:買い物", "divider:"]);
  });
});
