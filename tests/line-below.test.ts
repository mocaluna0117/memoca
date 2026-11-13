import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import type { EditorState } from "prosemirror-state";
import { TextSelection } from "prosemirror-state";
import { describe, expect, test } from "vitest";
import { caretAtEnd, lineBelow } from "@/components/editor/line-below";

const IMAGE: PartialBlock = { type: "image", props: { url: "memoca://att/0190" } };
const TABLE: PartialBlock = {
  type: "table",
  content: { type: "tableContent", rows: [{ cells: ["左上", "右上"] }, { cells: ["左下", "右下"] }] },
};

function stateOf(blocks: PartialBlock[]): EditorState {
  const editor = BlockNoteEditor.create();
  editor.replaceBlocks(editor.document, blocks);
  return editor.prosemirrorState;
}

/** Each block a line: its type and text, those under another put in. */
const outline = (state: EditorState) => {
  const lines: string[] = [];
  const walk = (group: EditorState["doc"], depth: number) =>
    group.forEach((container) => {
      const content = container.firstChild!;
      lines.push(`${"  ".repeat(depth)}${content.type.name}:${content.textContent}`);
      if (container.childCount > 1) walk(container.lastChild!, depth + 1);
    });
  walk(state.doc.firstChild!, 0);
  return lines;
};

/** The state with the caret in the line of this text, `offset` in (its end by default). */
function caretIn(state: EditorState, text: string, offset?: number): EditorState {
  let at = -1;
  state.doc.descendants((node, pos) => {
    if (at < 0 && node.isTextblock && node.textContent === text) at = pos + 1;
    return at < 0;
  });
  if (at < 0) throw new Error(`no line "${text}"`);
  return state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, at + (offset ?? text.length))),
  );
}

const where = (state: EditorState) =>
  `${state.selection.$from.parent.type.name}:${state.selection.$from.parent.textContent}@${state.selection.$from.parentOffset}`;

describe("↓ at the end of a block Enter does not leave", () => {
  test("a code block the note ends in, on its last line: a line under it, the caret there", () => {
    const state = caretIn(stateOf([{ type: "codeBlock", content: "x = 1\ny = 2" }]), "x = 1\ny = 2");
    const tr = lineBelow(state, () => true);
    expect(tr).not.toBeNull();
    const made = state.apply(tr!);
    expect(outline(made)).toEqual(["codeBlock:x = 1\ny = 2", "paragraph:"]);
    expect(where(made)).toBe("paragraph:@0");
  });

  test("on a line of the code above its last: ↓ is the browser's", () => {
    const state = caretIn(stateOf([{ type: "codeBlock", content: "x = 1\ny = 2" }]), "x = 1\ny = 2", 2);
    expect(lineBelow(state, () => true)).toBeNull();
  });

  test("with a line under it already, or blocks of its own under it: the browser's", () => {
    const followed = caretIn(
      stateOf([{ type: "codeBlock", content: "x" }, { type: "paragraph", content: "" }]),
      "x",
    );
    expect(lineBelow(followed, () => true)).toBeNull();
    const before = caretIn(stateOf([{ type: "codeBlock", content: "x" }, IMAGE, { type: "paragraph", content: "下" }]), "x");
    expect(lineBelow(before, () => true)).toBeNull();
  });

  test("a code block under a list item, the last of the note: a line under it, in the same step", () => {
    const state = caretIn(
      stateOf([{ type: "bulletListItem", content: "項目", children: [{ type: "codeBlock", content: "x" }] }]),
      "x",
    );
    const made = state.apply(lineBelow(state, () => true)!);
    expect(outline(made)).toEqual(["bulletListItem:項目", "  codeBlock:x", "  paragraph:"]);
  });

  test("a table the note ends in: from its last row only, and the last line of its cell", () => {
    const table = stateOf([TABLE]);
    expect(lineBelow(caretIn(table, "右上"), () => true)).toBeNull();
    expect(lineBelow(caretIn(table, "左下"), () => false)).toBeNull();
    const state = caretIn(table, "左下");
    const made = state.apply(lineBelow(state, () => true)!);
    expect(outline(made).at(-1)).toBe("paragraph:");
    expect(outline(made)).toHaveLength(2);
    expect(where(made)).toBe("paragraph:@0");
  });

  test("a line of text, a heading, a list item: the browser's", () => {
    for (const type of ["paragraph", "heading", "bulletListItem"] as const) {
      const state = caretIn(stateOf([{ type, content: "文" }]), "文");
      expect(lineBelow(state, () => true)).toBeNull();
    }
  });
});

describe("the caret put at the note's end", () => {
  test("at the end of its last line, a code block's too; nothing made", () => {
    for (const blocks of [
      [{ type: "paragraph", content: "一" }, { type: "heading", content: "二" }],
      [{ type: "paragraph", content: "一" }, { type: "codeBlock", content: "二" }],
      [{ type: "bulletListItem", content: "一", children: [{ type: "bulletListItem", content: "二" }] }],
    ] as PartialBlock[][]) {
      const state = stateOf(blocks);
      const made = state.apply(caretAtEnd(state));
      expect(outline(made)).toEqual(outline(state));
      expect(where(made).endsWith(":二@1")).toBe(true);
    }
  });

  test("not inside a toggle that is closed: at the end of the toggle's own line", () => {
    const state = stateOf([
      { type: "paragraph", content: "一" },
      { type: "toggleListItem", content: "題", children: [{ type: "paragraph", content: "隠れた行" }] },
    ]);
    // Open: the last line in sight is the one inside it.
    expect(where(state.apply(caretAtEnd(state)))).toBe("paragraph:隠れた行@4");
    // Closed: its own line. In the hidden one, what was typed went out of sight.
    const made = state.apply(caretAtEnd(state, (block) => block.node.firstChild!.type.name === "toggleListItem"));
    expect(where(made)).toBe("toggleListItem:題@1");
    expect(outline(made)).toEqual(outline(state));
  });

  test("in a new line where the note ends in an image or a table", () => {
    for (const last of [IMAGE, TABLE]) {
      const state = stateOf([{ type: "paragraph", content: "一" }, last]);
      const made = state.apply(caretAtEnd(state));
      expect(outline(made)).toHaveLength(3);
      expect(outline(made).at(-1)).toBe("paragraph:");
      expect(where(made)).toBe("paragraph:@0");
    }
  });
});
