import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import type { Node } from "prosemirror-model";
import { Slice } from "prosemirror-model";
import { type EditorState, NodeSelection, Selection, TextSelection } from "prosemirror-state";
import { describe, expect, test } from "vitest";
import {
  caretOutOfClosed,
  copyRange as copyRangeOf,
  cutRange,
  dropByToggle,
  enterInToggle,
  draggedFrom,
  isToggle,
  toggleAt,
  toggleToFlip,
  backspaceInToggle,
  emptiedToggles,
  enterInEmptyLine,
} from "@/components/editor/toggles";

/** The range to copy, every toggle closed. */
const copyRange = (doc: Node, from: number, to: number) => copyRangeOf(doc, from, to, () => false);

/** A note of these blocks, as the editor holds it. */
function stateOf(blocks: PartialBlock[]): EditorState {
  const editor = BlockNoteEditor.create();
  editor.replaceBlocks(editor.document, blocks);
  return editor.prosemirrorState;
}

/** Each block a line: its type and text, indented by how deep it is. */
function outline(doc: Node): string[] {
  const lines: string[] = [];
  const walk = (group: Node, depth: number) =>
    group.forEach((container) => {
      const content = container.firstChild!;
      lines.push(`${"  ".repeat(depth)}${content.type.name}:${content.textContent}`);
      if (container.childCount > 1) walk(container.child(1), depth + 1);
    });
  walk(doc.firstChild!, 0);
  return lines;
}

/** Where each textblock's text starts, by its text. */
function textAt(doc: Node, text: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isTextblock && node.textContent === text) found = pos + 1;
    return found < 0;
  });
  if (found < 0) throw new Error(`no line "${text}"`);
  return found;
}

const withCaret = (state: EditorState, pos: number, to = pos) =>
  state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos, to)));

/** Blocks selected whole, as BlockNote's side menu selects more than one to drag them. */
class Blocks extends Selection {
  constructor(doc: Node, from: number, to: number) {
    super(doc.resolve(from), doc.resolve(to));
  }
  content() {
    return new Slice(this.$from.doc.slice(this.from, this.to).content, 0, 0);
  }
  map() {
    return this;
  }
  eq() {
    return false;
  }
  toJSON() {
    return { type: "blocks" };
  }
}

/** A toggle "親" with "子" inside, then "後". */
const TOGGLE: PartialBlock[] = [
  { type: "toggleListItem", content: "親見出し", children: [{ type: "paragraph", content: "子" }] },
  { type: "paragraph", content: "後" },
];

/** The caret after the line's text, the line after Enter, and the caret's line. */
function enter(state: EditorState, open: boolean) {
  const tr = enterInToggle(state, () => open);
  if (!tr) return null;
  const next = state.apply(tr);
  return { lines: outline(next.doc), caret: next.selection.$from.parent.textContent, next };
}

describe("Enter in a toggle's line", () => {
  test("open: the rest of the line goes first inside it, and what was inside stays", () => {
    const state = stateOf(TOGGLE);
    const done = enter(withCaret(state, textAt(state.doc, "親見出し") + 1), true)!;
    expect(done.lines).toEqual([
      "toggleListItem:親",
      "  paragraph:見出し",
      "  paragraph:子",
      "paragraph:後",
    ]);
    expect(done.caret).toBe("見出し");
    expect(done.next.selection.$from.parentOffset).toBe(0);
  });

  test("open, at the end: an empty line first inside it", () => {
    const state = stateOf(TOGGLE);
    const at = textAt(state.doc, "親見出し") + "親見出し".length;
    expect(enter(withCaret(state, at), true)!.lines).toEqual([
      "toggleListItem:親見出し",
      "  paragraph:",
      "  paragraph:子",
      "paragraph:後",
    ]);
  });

  test("open with nothing inside: a first line inside it", () => {
    const state = stateOf([
      { type: "toggleListItem", content: "空" },
      { type: "paragraph", content: "後" },
    ]);
    const done = enter(withCaret(state, textAt(state.doc, "空") + 1), true)!;
    expect(done.lines).toEqual(["toggleListItem:空", "  paragraph:", "paragraph:後"]);
    expect(done.next.selection.$from.depth).toBeGreaterThan(3);
  });

  test("closed: a new toggle after it, after all that is inside it", () => {
    const state = stateOf(TOGGLE);
    const done = enter(withCaret(state, textAt(state.doc, "親見出し") + 1), false)!;
    expect(done.lines).toEqual([
      "toggleListItem:親",
      "  paragraph:子",
      "toggleListItem:見出し",
      "paragraph:後",
    ]);
    expect(done.caret).toBe("見出し");
  });

  test("a toggle heading, closed: a paragraph after it", () => {
    const state = stateOf([
      {
        type: "heading",
        props: { level: 2, isToggleable: true },
        content: "章",
        children: [{ type: "paragraph", content: "本文" }],
      },
    ]);
    const at = textAt(state.doc, "章") + 1;
    expect(enter(withCaret(state, at), false)!.lines).toEqual([
      "heading:章",
      "  paragraph:本文",
      "paragraph:",
    ]);
    expect(enter(withCaret(state, at), true)!.lines).toEqual([
      "heading:章",
      "  paragraph:",
      "  paragraph:本文",
    ]);
  });

  test("at the start of the line: an empty line before it, the caret staying with its text", () => {
    const state = stateOf(TOGGLE);
    const done = enter(withCaret(state, textAt(state.doc, "親見出し")), true)!;
    expect(done.lines).toEqual([
      "toggleListItem:",
      "toggleListItem:親見出し",
      "  paragraph:子",
      "paragraph:後",
    ]);
    expect(done.caret).toBe("親見出し");
  });

  test("text of the line selected: taken out, then as with the caret there", () => {
    const state = stateOf(TOGGLE);
    const start = textAt(state.doc, "親見出し");
    expect(enter(withCaret(state, start + 1, start + 2), true)!.lines).toEqual([
      "toggleListItem:親",
      "  paragraph:出し",
      "  paragraph:子",
      "paragraph:後",
    ]);
  });

  test("an empty line with something inside: kept inside, as with text", () => {
    const state = stateOf([
      { type: "toggleListItem", children: [{ type: "paragraph", content: "子" }] },
      {
        type: "heading",
        props: { level: 2, isToggleable: true },
        children: [{ type: "paragraph", content: "本文" }],
      },
    ]);
    const toggle = withCaret(state, 3);
    expect(enter(toggle, true)!.lines.slice(0, 3)).toEqual([
      "toggleListItem:",
      "  paragraph:",
      "  paragraph:子",
    ]);
    expect(enter(toggle, false)!.lines.slice(0, 3)).toEqual([
      "toggleListItem:",
      "  paragraph:子",
      "toggleListItem:",
    ]);
    const heading = withCaret(state, textAt(state.doc, "本文") - 4);
    expect(heading.selection.$from.parent.type.name).toBe("heading");
    expect(enter(heading, false)!.lines.slice(2)).toEqual([
      "heading:",
      "  paragraph:本文",
      "paragraph:",
    ]);
  });

  test("left to BlockNote: an empty line with nothing inside, closed with nothing inside, not a toggle", () => {
    const empty = stateOf([{ type: "toggleListItem" }]);
    expect(enter(withCaret(empty, 3), true)).toBeNull();
    const bare = stateOf([{ type: "toggleListItem", content: "空" }]);
    expect(enter(withCaret(bare, textAt(bare.doc, "空") + 1), false)).toBeNull();
    const list = stateOf([
      { type: "bulletListItem", content: "箇条", children: [{ type: "paragraph", content: "子" }] },
    ]);
    expect(enter(withCaret(list, textAt(list.doc, "箇条") + 1), true)).toBeNull();
    const heading = stateOf([
      { type: "heading", content: "見出し", children: [{ type: "paragraph", content: "子" }] },
    ]);
    expect(enter(withCaret(heading, textAt(heading.doc, "見出し") + 1), true)).toBeNull();
  });
});

describe("copying a toggle", () => {
  const ALL: PartialBlock[] = [
    { type: "paragraph", content: "前" },
    {
      type: "toggleListItem",
      content: "親",
      children: [
        { type: "paragraph", content: "子" },
        {
          type: "toggleListItem",
          content: "孫の親",
          children: [{ type: "paragraph", content: "孫" }],
        },
      ],
    },
    { type: "paragraph", content: "後" },
  ];

  test("its line all selected: to the end of what is inside it", () => {
    const { doc } = stateOf(ALL);
    const line = textAt(doc, "親");
    const range = copyRange(doc, line, line + 1)!;
    expect(range.from).toBe(line);
    expect(doc.textBetween(range.from, range.to, "|")).toBe("親|子|孫の親|孫");
    // From a line before it, too; and ending at the start of the next line.
    expect(copyRange(doc, textAt(doc, "前"), line + 1)!.to).toBe(range.to);
    expect(copyRange(doc, line, textAt(doc, "子"))!.to).toBe(range.to);
  });

  test("a nested toggle's line, selected with lines before it: to the end of it", () => {
    const { doc } = stateOf(ALL);
    const inner = textAt(doc, "孫の親");
    const range = copyRange(doc, textAt(doc, "子"), inner + "孫の親".length)!;
    expect(doc.textBetween(range.from, range.to, "|")).toBe("子|孫の親|孫");
  });

  test("otherwise, the selection as it is", () => {
    const { doc } = stateOf(ALL);
    const line = textAt(doc, "孫の親");
    // Part of the line.
    expect(copyRange(doc, line + 1, line + 3)).toBeNull();
    expect(copyRange(doc, line, line + 2)).toBeNull();
    // Into what is inside it.
    expect(copyRange(doc, textAt(doc, "親"), textAt(doc, "子") + 1)).toBeNull();
    // A toggle with nothing inside, or not a toggle.
    const bare = stateOf([
      { type: "toggleListItem", content: "空" },
      { type: "paragraph", content: "後" },
    ]).doc;
    expect(copyRange(bare, textAt(bare, "空"), textAt(bare, "空") + 1)).toBeNull();
    const list = stateOf([
      { type: "bulletListItem", content: "箇条", children: [{ type: "paragraph", content: "子" }] },
    ]).doc;
    expect(copyRange(list, textAt(list, "箇条"), textAt(list, "箇条") + 2)).toBeNull();
    expect(copyRange(doc, line, line)).toBeNull();
  });
});

describe("copying a toggle, open or empty", () => {
  test("open: its line as selected, what is inside it there to select or not", () => {
    const { doc } = stateOf(TOGGLE);
    const line = textAt(doc, "親見出し");
    expect(copyRangeOf(doc, line, line + 4, () => true)).toBeNull();
    expect(copyRangeOf(doc, line, line + 4, () => false)).not.toBeNull();
  });

  test("an empty line only touched at its start is not taken, nor what is hidden inside it", () => {
    const { doc } = stateOf([
      { type: "paragraph", content: "前" },
      { type: "toggleListItem", children: [{ type: "paragraph", content: "隠れた子" }] },
    ]);
    // From the start of 前 to the start of the next line, as Shift+↓ selects.
    const next = doc.firstChild!.child(0).nodeSize + 3;
    expect(copyRange(doc, textAt(doc, "前"), next)).toBeNull();
  });
});

describe("cutting a closed toggle", () => {
  const cut = (blocks: PartialBlock[], from: string, to: string, toOffset: number) => {
    const state = stateOf(blocks);
    const range = copyRange(state.doc, textAt(state.doc, from), textAt(state.doc, to) + toOffset)!;
    return outline(state.apply(cutRange(state, range)).doc);
  };
  const BOX: PartialBlock = {
    type: "toggleListItem",
    content: "箱",
    children: [{ type: "paragraph", content: "中" }],
  };

  test("its line all selected: it goes whole, with what is hidden inside it", () => {
    expect(
      cut(
        [{ type: "paragraph", content: "前" }, BOX, { type: "paragraph", content: "後" }],
        "箱",
        "箱",
        1,
      ),
    ).toEqual(["paragraph:前", "paragraph:後"]);
  });

  test("all there was: an empty line in its place", () => {
    expect(cut([BOX], "箱", "箱", 1)).toEqual(["paragraph:"]);
  });

  test("all there was under an item: nothing left under it, not an empty line", () => {
    expect(
      cut([{ type: "bulletListItem", content: "上", children: [BOX] }], "箱", "箱", 1),
    ).toEqual(["bulletListItem:上"]);
  });

  test("from a line before it: what is left of that line stays", () => {
    const state = stateOf([
      { type: "paragraph", content: "前の行" },
      BOX,
      { type: "paragraph", content: "後" },
    ]);
    const range = copyRange(
      state.doc,
      textAt(state.doc, "前の行") + 1,
      textAt(state.doc, "箱") + 1,
    )!;
    expect(outline(state.apply(cutRange(state, range)).doc)).toEqual([
      "paragraph:前",
      "paragraph:後",
    ]);
  });
});

describe("dropping a block by a toggle", () => {
  /** The blockContainer holding a line, and where it is. */
  function blockOf(doc: Node, text: string) {
    const $pos = doc.resolve(textAt(doc, text));
    return { node: $pos.node($pos.depth - 1), pos: $pos.before($pos.depth - 1) };
  }
  /** The state with a block selected, as its handle has it when dragged. */
  function dragging(state: EditorState, text: string) {
    const selected = state.apply(
      state.tr.setSelection(NodeSelection.create(state.doc, blockOf(state.doc, text).pos)),
    );
    return { state: selected, slice: selected.selection.content() };
  }
  const inside = (doc: Node, text: string) => ({
    block: blockOf(doc, text),
    where: "inside" as const,
  });

  test("goes first inside it, and leaves where it was", () => {
    const state = stateOf([
      { type: "toggleListItem", content: "箱", children: [{ type: "paragraph", content: "中" }] },
      { type: "paragraph", content: "動かす" },
    ]);
    const { state: drag, slice } = dragging(state, "動かす");
    const tr = dropByToggle(drag, inside(drag.doc, "箱"), slice)!;
    expect(outline(drag.apply(tr).doc)).toEqual([
      "toggleListItem:箱",
      "  paragraph:動かす",
      "  paragraph:中",
    ]);
  });

  test("into a toggle with nothing inside, from below or above it", () => {
    const state = stateOf([
      { type: "paragraph", content: "上" },
      { type: "toggleListItem", content: "箱" },
      { type: "image", props: { url: "memoca://att/0190" } },
    ]);
    // The image's block: after the first two, inside the note's group.
    const group = state.doc.firstChild!;
    const imagePos = 1 + group.child(0).nodeSize + group.child(1).nodeSize;
    const selected = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, imagePos)));
    const slice = selected.selection.content();
    const tr = dropByToggle(selected, inside(selected.doc, "箱"), slice)!;
    expect(outline(selected.apply(tr).doc)).toEqual([
      "paragraph:上",
      "toggleListItem:箱",
      "  image:",
    ]);

    const { state: drag, slice: above } = dragging(state, "上");
    const moved = drag.apply(dropByToggle(drag, inside(drag.doc, "箱"), above)!);
    expect(outline(moved.doc)).toEqual(["toggleListItem:箱", "  paragraph:上", "image:"]);
  });

  test("closed: after it, and after all hidden inside it", () => {
    const state = stateOf([
      { type: "paragraph", content: "動かす" },
      { type: "toggleListItem", content: "箱", children: [{ type: "paragraph", content: "中" }] },
      { type: "paragraph", content: "後" },
    ]);
    const { state: drag, slice } = dragging(state, "動かす");
    const after = { block: blockOf(drag.doc, "箱"), where: "after" as const };
    const moved = drag.apply(dropByToggle(drag, after, slice)!);
    expect(outline(moved.doc)).toEqual([
      "toggleListItem:箱",
      "  paragraph:中",
      "paragraph:動かす",
      "paragraph:後",
    ]);
    expect(moved.selection.$from.nodeAfter?.firstChild?.textContent).toBe("動かす");
  });

  test("two blocks at once, first inside it in their order", () => {
    const state = stateOf([
      { type: "paragraph", content: "一" },
      { type: "paragraph", content: "二" },
      { type: "toggleListItem", content: "箱", children: [{ type: "paragraph", content: "中" }] },
    ]);
    // As the handle selects two blocks: from before the first to after the last.
    const group = state.doc.firstChild!;
    const end = 1 + group.child(0).nodeSize + group.child(1).nodeSize;
    const blocks = state.apply(state.tr.setSelection(new Blocks(state.doc, 1, end)));
    const slice = blocks.selection.content();
    expect(draggedFrom(blocks.doc, slice)).toEqual({ from: 1, to: end });
    const moved = blocks.apply(dropByToggle(blocks, inside(blocks.doc, "箱"), slice)!);
    expect(outline(moved.doc)).toEqual([
      "toggleListItem:箱",
      "  paragraph:一",
      "  paragraph:二",
      "  paragraph:中",
    ]);
  });

  test("all there was under an item: nothing left under it, not an empty line", () => {
    const state = stateOf([
      {
        type: "bulletListItem",
        content: "親",
        children: [{ type: "bulletListItem", content: "子" }],
      },
      { type: "toggleListItem", content: "箱", children: [{ type: "paragraph", content: "中" }] },
    ]);
    const { state: drag, slice } = dragging(state, "子");
    const moved = drag.apply(dropByToggle(drag, inside(drag.doc, "箱"), slice)!);
    expect(outline(moved.doc)).toEqual([
      "bulletListItem:親",
      "toggleListItem:箱",
      "  bulletListItem:子",
      "  paragraph:中",
    ]);
  });

  test("a toggle into itself, or into one inside it: left as it is", () => {
    const state = stateOf([
      {
        type: "toggleListItem",
        content: "箱",
        children: [{ type: "toggleListItem", content: "小箱" }],
      },
    ]);
    const { state: drag, slice } = dragging(state, "箱");
    expect(dropByToggle(drag, inside(drag.doc, "箱"), slice)).toBeNull();
    expect(dropByToggle(drag, inside(drag.doc, "小箱"), slice)).toBeNull();
    // Nor into the toggle after it, which is where it was, once it is taken out.
    const two = stateOf([
      { type: "toggleListItem", content: "箱" },
      { type: "toggleListItem", content: "次の箱" },
    ]);
    const { state: drag2, slice: slice2 } = dragging(two, "箱");
    expect(dropByToggle(drag2, inside(drag2.doc, "箱"), slice2)).toBeNull();
  });

  test("not what is selected, or not whole blocks: left to BlockNote", () => {
    const state = stateOf([
      { type: "toggleListItem", content: "箱" },
      { type: "paragraph", content: "動かす" },
    ]);
    const { state: drag } = dragging(state, "動かす");
    const other = stateOf([{ type: "paragraph", content: "別" }]);
    expect(dropByToggle(drag, inside(drag.doc, "箱"), dragging(other, "別").slice)).toBeNull();
    const text = withCaret(state, textAt(state.doc, "動かす"), textAt(state.doc, "動かす") + 2);
    expect(dropByToggle(text, inside(text.doc, "箱"), text.selection.content())).toBeNull();
  });
});

test("a toggle is a toggle list item, or a heading made one", () => {
  const { doc } = stateOf([
    { type: "toggleListItem", content: "a" },
    { type: "heading", props: { isToggleable: true }, content: "b" },
    { type: "heading", content: "c" },
    { type: "paragraph", content: "d" },
  ]);
  const kinds: boolean[] = [];
  doc.firstChild!.forEach((container) => kinds.push(isToggle(container.firstChild)));
  expect(kinds).toEqual([true, true, false, false]);
});

describe("closing a toggle", () => {
  /** The blockContainer holding a line, and where it is. */
  function around(doc: Node, text: string) {
    const $pos = doc.resolve(textAt(doc, text));
    return { node: $pos.node($pos.depth - 1), pos: $pos.before($pos.depth - 1) };
  }

  test("with the caret inside it: the caret to the end of its line", () => {
    const state = stateOf(TOGGLE);
    const inside = withCaret(state, textAt(state.doc, "子") + 1);
    const tr = caretOutOfClosed(inside, around(inside.doc, "親見出し"))!;
    const next = inside.apply(tr);
    expect(next.selection.$from.parent.textContent).toBe("親見出し");
    expect(next.selection.$from.parentOffset).toBe("親見出し".length);
  });

  test("with the caret elsewhere: left where it is", () => {
    const state = stateOf(TOGGLE);
    const block = around(state.doc, "親見出し");
    expect(caretOutOfClosed(withCaret(state, textAt(state.doc, "親見出し") + 1), block)).toBeNull();
    expect(caretOutOfClosed(withCaret(state, textAt(state.doc, "後")), block)).toBeNull();
  });
});

describe("the toggle ⌘/Ctrl+Enter opens or closes", () => {
  /** That toggle's line, for a caret at `pos`, or null. */
  const lineFor = (state: EditorState, pos: number) =>
    toggleAt(state, pos)?.node.firstChild?.textContent ?? null;

  test("in its line, or anywhere inside it, however far down: the nearest", () => {
    const state = stateOf([
      {
        type: "toggleListItem",
        content: "外",
        children: [
          {
            type: "paragraph",
            content: "外の子",
            children: [{ type: "paragraph", content: "孫" }],
          },
          {
            type: "heading",
            props: { isToggleable: true },
            content: "内",
            children: [{ type: "paragraph", content: "内の子" }],
          },
        ],
      },
      { type: "paragraph", content: "後" },
    ]);
    const { doc } = state;
    expect(lineFor(state, textAt(doc, "外") + 1)).toBe("外");
    expect(lineFor(state, textAt(doc, "外の子"))).toBe("外");
    expect(lineFor(state, textAt(doc, "孫") + 1)).toBe("外");
    expect(lineFor(state, textAt(doc, "内"))).toBe("内");
    expect(lineFor(state, textAt(doc, "内の子") + 2)).toBe("内");
    expect(lineFor(state, textAt(doc, "後"))).toBeNull();
  });

  test("an image inside it, selected: it", () => {
    const state = stateOf([
      { type: "toggleListItem", content: "親", children: [{ type: "image" }] },
    ]);
    let image = -1;
    state.doc.descendants((node, pos) => {
      if (node.type.name === "image") image = pos;
      return image < 0;
    });
    const selected = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, image)));
    expect(toggleToFlip(selected)?.node.firstChild?.textContent).toBe("親");
  });

  test("a toggle selected whole, as one is once dropped: it, not the one it is in", () => {
    const state = stateOf([
      {
        type: "toggleListItem",
        content: "外",
        children: [
          {
            type: "toggleListItem",
            content: "内",
            children: [{ type: "paragraph", content: "子" }],
          },
        ],
      },
      { type: "toggleListItem", content: "上の段" },
    ]);
    const containerOf = (text: string) => textAt(state.doc, text) - 2;
    for (const text of ["内", "上の段"]) {
      const selected = state.apply(
        state.tr.setSelection(NodeSelection.create(state.doc, containerOf(text))),
      );
      expect(toggleToFlip(selected)?.node.firstChild?.textContent).toBe(text);
    }
    // A caret, or text selected: where it ends.
    const caret = withCaret(state, textAt(state.doc, "子"));
    expect(toggleToFlip(caret)?.node.firstChild?.textContent).toBe("内");
  });

  test("a heading not made a toggle, with lines inside it: not one, the toggle it is in", () => {
    const state = stateOf([
      {
        type: "toggleListItem",
        content: "外",
        children: [
          { type: "heading", content: "見出し", children: [{ type: "paragraph", content: "下" }] },
        ],
      },
    ]);
    expect(lineFor(state, textAt(state.doc, "見出し"))).toBe("外");
    expect(lineFor(state, textAt(state.doc, "下"))).toBe("外");
  });
});

describe("Backspace in an empty line inside an open toggle", () => {
  /** Backspace with the caret where `at` finds in the note, its toggles open (or not). */
  function backspace(blocks: PartialBlock[], at: (doc: Node) => number, open = true) {
    const state = stateOf(blocks);
    const ready = withCaret(state, at(state.doc));
    const tr = backspaceInToggle(ready, () => open);
    if (!tr) return null;
    const next = ready.apply(tr);
    return {
      lines: outline(next.doc),
      caret: `${next.selection.$from.parent.textContent}@${next.selection.$from.parentOffset}`,
    };
  }
  /** Where the n-th empty textblock is. */
  const empty =
    (n = 0) =>
    (doc: Node) => {
      let seen = -1;
      let found = -1;
      doc.descendants((node, pos) => {
        if (found < 0 && node.isTextblock && node.content.size === 0 && ++seen === n)
          found = pos + 1;
        return found < 0;
      });
      return found;
    };

  test("among others: the line gone, the caret to the end of the line above", () => {
    expect(
      backspace(
        [
          {
            type: "toggleListItem",
            content: "箱",
            children: [
              { type: "paragraph", content: "一" },
              { type: "paragraph" },
              { type: "paragraph", content: "三" },
            ],
          },
        ],
        empty(),
      ),
    ).toEqual({
      lines: ["toggleListItem:箱", "  paragraph:一", "  paragraph:三"],
      caret: "一@1",
    });
  });

  test("first inside it: the caret to the end of the toggle's line; the only one, it empty", () => {
    expect(
      backspace(
        [
          {
            type: "toggleListItem",
            content: "箱",
            children: [{ type: "paragraph" }, { type: "paragraph", content: "二" }],
          },
        ],
        empty(),
      ),
    ).toEqual({ lines: ["toggleListItem:箱", "  paragraph:二"], caret: "箱@1" });
    expect(
      backspace(
        [{ type: "toggleListItem", content: "箱", children: [{ type: "paragraph" }] }],
        empty(),
      ),
    ).toEqual({ lines: ["toggleListItem:箱"], caret: "箱@1" });
  });

  test("after a block with lines inside it: the end of the last of them, however deep", () => {
    expect(
      backspace(
        [
          {
            type: "toggleListItem",
            content: "箱",
            children: [
              {
                type: "paragraph",
                content: "上",
                children: [
                  {
                    type: "paragraph",
                    content: "下",
                    children: [{ type: "paragraph", content: "底" }],
                  },
                ],
              },
              { type: "paragraph" },
            ],
          },
        ],
        empty(),
      )?.caret,
    ).toBe("底@1");
  });

  test("after a closed toggle: the end of its line, not of what is hidden in it", () => {
    const state = stateOf([
      {
        type: "toggleListItem",
        content: "箱",
        children: [
          {
            type: "toggleListItem",
            content: "閉",
            children: [{ type: "paragraph", content: "隠" }],
          },
          { type: "paragraph" },
        ],
      },
    ]);
    const ready = withCaret(state, empty()(state.doc));
    const tr = backspaceInToggle(ready, (block) => block.node.firstChild!.textContent === "箱")!;
    const next = ready.apply(tr);
    expect(next.selection.$from.parent.textContent).toBe("閉");
  });

  test("left to BlockNote: text in the line, a closed toggle, not in a toggle, a line with lines inside", () => {
    const inToggle: PartialBlock[] = [
      { type: "toggleListItem", content: "箱", children: [{ type: "paragraph", content: "字" }] },
    ];
    expect(backspace(inToggle, (doc) => textAt(doc, "字") + 1)).toBeNull();
    expect(
      backspace(
        [{ type: "toggleListItem", content: "箱", children: [{ type: "paragraph" }] }],
        empty(),
        false,
      ),
    ).toBeNull();
    expect(
      backspace([{ type: "paragraph", content: "親", children: [{ type: "paragraph" }] }], empty()),
    ).toBeNull();
    expect(
      backspace(
        [
          {
            type: "toggleListItem",
            content: "箱",
            children: [{ type: "paragraph", children: [{ type: "paragraph", content: "子" }] }],
          },
        ],
        empty(),
      ),
    ).toBeNull();
  });
});

describe("Backspace at the start of a line inside an open toggle", () => {
  /** Backspace at the start of the line saying `text`. */
  function backspaceAt(blocks: PartialBlock[], text: string) {
    const state = stateOf(blocks);
    const ready = withCaret(state, textAt(state.doc, text));
    const tr = backspaceInToggle(ready, () => true);
    if (!tr) return null;
    const next = ready.apply(tr);
    next.doc.check();
    return {
      lines: outline(next.doc),
      caret: `${next.selection.$from.parent.textContent}@${next.selection.$from.parentOffset}`,
      selected: next.selection instanceof NodeSelection ? next.selection.node.type.name : null,
    };
  }
  const box = (children: PartialBlock[]): PartialBlock[] => [
    { type: "toggleListItem", content: "箱", children },
    { type: "paragraph", content: "後" },
  ];

  test("joined to the line above, the lines after it staying inside", () => {
    expect(
      backspaceAt(
        box([
          { type: "paragraph", content: "一" },
          { type: "paragraph", content: "二" },
          { type: "paragraph", content: "三" },
        ]),
        "二",
      ),
    ).toEqual({
      lines: ["toggleListItem:箱", "  paragraph:一二", "  paragraph:三", "paragraph:後"],
      caret: "一二@1",
      selected: null,
    });
  });

  test("the first: joined to the toggle's own line; the only one, the toggle left empty", () => {
    expect(
      backspaceAt(
        box([
          { type: "paragraph", content: "一" },
          { type: "paragraph", content: "二" },
        ]),
        "一",
      ),
    ).toEqual({
      lines: ["toggleListItem:箱一", "  paragraph:二", "paragraph:後"],
      caret: "箱一@1",
      selected: null,
    });
    expect(backspaceAt(box([{ type: "paragraph", content: "一" }]), "一")?.lines).toEqual([
      "toggleListItem:箱一",
      "paragraph:後",
    ]);
  });

  test("below an image: it selected, the line left as it is", () => {
    const result = backspaceAt(
      box([{ type: "image" }, { type: "paragraph", content: "下" }]),
      "下",
    );
    expect(result?.selected).toBe("image");
    expect(result?.lines).toEqual([
      "toggleListItem:箱",
      "  image:",
      "  paragraph:下",
      "paragraph:後",
    ]);
  });

  test("below a table: the caret to the end of its last cell; an empty line, taken away", () => {
    const table: PartialBlock = {
      type: "table",
      content: {
        type: "tableContent",
        rows: [{ cells: ["a", "b"] }, { cells: ["c", "d"] }],
      },
    };
    const kept = backspaceAt(box([table, { type: "paragraph", content: "下" }]), "下");
    expect(kept?.caret).toBe("d@1");
    expect(kept?.lines).toContain("  paragraph:下");
    const state = stateOf(box([table, { type: "paragraph" }]));
    let empty = -1;
    state.doc.descendants((node, pos) => {
      if (empty < 0 && node.type.name === "paragraph" && node.content.size === 0) empty = pos + 1;
      return empty < 0;
    });
    const next = withCaret(state, empty);
    const after = next.apply(backspaceInToggle(next, () => true)!);
    after.doc.check();
    expect(
      `${after.selection.$from.parent.textContent}@${after.selection.$from.parentOffset}`,
    ).toBe("d@1");
    expect(outline(after.doc)).not.toContain("  paragraph:");
  });

  test("below a code block, marked text not joined to it", () => {
    const result = backspaceAt(
      box([
        { type: "codeBlock", content: "code" },
        { type: "paragraph", content: [{ type: "text", text: "太字", styles: { bold: true } }] },
      ]),
      "太字",
    );
    expect(result?.caret).toBe("code@4");
    expect(result?.lines).toContain("  paragraph:太字");
  });
});

describe("Enter in an empty line inside an open toggle", () => {
  const enter = (children: PartialBlock[], n: number) => {
    const state = stateOf([{ type: "toggleListItem", content: "箱", children }]);
    let seen = -1;
    let at = -1;
    state.doc.descendants((node, pos) => {
      if (at < 0 && node.isTextblock && node.content.size === 0 && ++seen === n) at = pos + 1;
      return at < 0;
    });
    const ready = withCaret(state, at);
    const tr = enterInEmptyLine(ready, () => true);
    return tr ? outline(ready.apply(tr).doc) : null;
  };

  test("lines after it there: a new line after it, inside", () => {
    expect(
      enter(
        [
          { type: "paragraph", content: "一" },
          { type: "paragraph" },
          { type: "paragraph", content: "三" },
        ],
        0,
      ),
    ).toEqual([
      "toggleListItem:箱",
      "  paragraph:一",
      "  paragraph:",
      "  paragraph:",
      "  paragraph:三",
    ]);
  });

  test("the last line: left to BlockNote, a way out of it", () => {
    expect(enter([{ type: "paragraph", content: "一" }, { type: "paragraph" }], 0)).toBeNull();
  });
});

test("toggles emptied by a change: those with lines inside before, none after", () => {
  const before = stateOf([
    {
      id: "a",
      type: "toggleListItem",
      content: "a",
      children: [{ type: "paragraph", content: "1" }],
    },
    {
      id: "b",
      type: "toggleListItem",
      content: "b",
      children: [{ type: "paragraph", content: "2" }],
    },
    { id: "c", type: "toggleListItem", content: "c" },
  ]).doc;
  const after = stateOf([
    { id: "a", type: "toggleListItem", content: "a" },
    {
      id: "b",
      type: "toggleListItem",
      content: "b",
      children: [{ type: "paragraph", content: "2" }],
    },
    { id: "c", type: "toggleListItem", content: "c" },
  ]).doc;
  expect(emptiedToggles(before, after)).toEqual(["a"]);
  expect(emptiedToggles(after, before)).toEqual([]);
});
