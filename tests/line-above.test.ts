import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import type { EditorState } from "prosemirror-state";
import { NodeSelection, Selection, TextSelection } from "prosemirror-state";
import { describe, expect, test } from "vitest";
import { enterAtGap, fromTitle } from "@/components/editor/line-above";

const IMAGE: PartialBlock = { type: "image", props: { url: "memoca://att/0190" } };

function stateOf(blocks: PartialBlock[]): EditorState {
  const editor = BlockNoteEditor.create();
  editor.replaceBlocks(editor.document, blocks);
  return editor.prosemirrorState;
}

/** Each block a line: its type and text. */
const outline = (state: EditorState) => {
  const lines: string[] = [];
  state.doc.firstChild!.forEach((container) =>
    lines.push(`${container.firstChild!.type.name}:${container.firstChild!.textContent}`),
  );
  return lines;
};

/** The block whose caret the selection is in, as a line. */
const caretIn = (state: EditorState) =>
  `${state.selection.$from.parent.type.name}:${state.selection.$from.parent.textContent}`;

describe("a line above the note's first block", () => {
  test("down from the title: to the first line, or a new one above an image first", () => {
    const text = stateOf([{ type: "paragraph", content: "一行目" }, IMAGE]);
    const down = text.apply(fromTitle(text));
    expect(outline(down)).toEqual(["paragraph:一行目", "image:"]);
    expect(caretIn(down)).toBe("paragraph:一行目");
    expect(down.selection.$from.parentOffset).toBe(0);

    const image = stateOf([IMAGE]);
    const made = image.apply(fromTitle(image));
    expect(outline(made)).toEqual(["paragraph:", "image:"]);
    expect(caretIn(made)).toBe("paragraph:");
  });

  test("with the gap cursor before an image, Enter or a letter typed: a line above it", () => {
    const state = stateOf([IMAGE, IMAGE, { type: "paragraph", content: "下" }]);
    const gapAt = (pos: number) =>
      state.apply(state.tr.setSelection(Selection.fromJSON(state.doc, { type: "gapcursor", pos })));
    const top = gapAt(2);
    const entered = top.apply(enterAtGap(top)!);
    expect(outline(entered)).toEqual(["paragraph:", "image:", "image:", "paragraph:下"]);
    expect(caretIn(entered)).toBe("paragraph:");
    const typed = top.apply(enterAtGap(top, "上")!);
    expect(outline(typed)).toEqual(["paragraph:上", "image:", "image:", "paragraph:下"]);
    expect(caretIn(typed)).toBe("paragraph:上");
    // Before the second image too.
    const second = 1 + state.doc.firstChild!.child(0).nodeSize + 1;
    const between = gapAt(second);
    expect(outline(between.apply(enterAtGap(between)!))).toEqual([
      "image:",
      "paragraph:",
      "image:",
      "paragraph:下",
    ]);
    // Not the gap cursor, nor a block selected: left as it is.
    const text = stateOf([{ type: "paragraph", content: "上" }]);
    expect(
      enterAtGap(text.apply(text.tr.setSelection(TextSelection.create(text.doc, 3)))),
    ).toBeNull();
    expect(
      enterAtGap(state.apply(state.tr.setSelection(NodeSelection.create(state.doc, 1)))),
    ).toBeNull();
  });
});
