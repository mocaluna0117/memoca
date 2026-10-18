import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { type Node, Slice } from "prosemirror-model";
import { type EditorState, TextSelection } from "prosemirror-state";
import { afterEach, describe, expect, test } from "vitest";
import {
  type Chosen,
  blockSelect,
  blockSelectKey,
  chosenBlocks,
  chosenFrom,
  chosenRange,
  movedChoice,
  placeBlocks,
  wholeBlocks,
} from "@/components/editor/block-select";

/** A note of these blocks, as the editor holds it. */
function stateOf(blocks: PartialBlock[]): EditorState {
  // With blocks to be chosen in it, as a note has: shown, as its plugins are only then.
  const editor = BlockNoteEditor.create({ extensions: [blockSelect()] });
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  unmounts.push(() => {
    editor.unmount();
    host.remove();
  });
  editor.replaceBlocks(editor.document, blocks);
  return editor.prosemirrorState;
}

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

/** Where the block whose line reads `text` is. */
function blockOf(doc: Node, text: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.type.name === "blockContainer" && node.firstChild!.textContent === text) {
      found = pos;
    }
    return found < 0;
  });
  if (found < 0) throw new Error(`no line "${text}"`);
  return found;
}

/** The lines of the blocks chosen, each block's own line only. */
function chosenLines(doc: Node, chosen: Chosen | null): string[] {
  const range = chosen ? chosenRange(doc, chosen) : null;
  return range ? chosenBlocks(doc, range).map((block) => block.node.firstChild!.textContent) : [];
}

const between = (doc: Node, from: string, to: string): Chosen => ({
  anchor: blockOf(doc, from),
  head: blockOf(doc, to),
});

/** 一, 二 (with 二の中 inside it), 三, as bullets. */
const NOTE: PartialBlock[] = [
  { type: "bulletListItem", content: "一" },
  {
    type: "toggleListItem",
    content: "二",
    children: [
      { type: "paragraph", content: "二の中1" },
      { type: "paragraph", content: "二の中2" },
    ],
  },
  { type: "bulletListItem", content: "三" },
];

describe("blocks chosen", () => {
  test("from one to another: both, and those between, side by side", () => {
    const { doc } = stateOf(NOTE);
    expect(chosenLines(doc, between(doc, "一", "三"))).toEqual(["一", "二", "三"]);
    // Taken upward the same.
    expect(chosenLines(doc, between(doc, "三", "一"))).toEqual(["一", "二", "三"]);
  });

  test("one with what is inside it, which goes with it", () => {
    const { doc } = stateOf(NOTE);
    const chosen = between(doc, "二", "二");
    const range = chosenRange(doc, chosen)!;
    expect(doc.textBetween(range.from, range.to, "|")).toBe("二|二の中1|二の中2");
  });

  test("from inside a block to past it: the block it is in, and on", () => {
    const { doc } = stateOf(NOTE);
    expect(chosenLines(doc, between(doc, "二の中2", "三"))).toEqual(["二", "三"]);
    // From a block to one inside it: the outer one.
    expect(chosenLines(doc, between(doc, "二", "二の中1"))).toEqual(["二"]);
  });

  test("from the caret: its block; from a selection over lines: those blocks", () => {
    const state = stateOf(NOTE);
    const { doc } = state;
    const at = (text: string) => blockOf(doc, text) + 2;
    const caret = state.apply(state.tr.setSelection(TextSelection.create(doc, at("二の中1"))));
    expect(chosenLines(doc, chosenFrom(caret))).toEqual(["二の中1"]);
    const over = state.apply(
      state.tr.setSelection(TextSelection.create(doc, at("一"), at("三") + 1)),
    );
    expect(chosenLines(doc, chosenFrom(over))).toEqual(["一", "二", "三"]);
  });
});

describe("blocks chosen, ↑ and ↓", () => {
  const open = () => true;
  const closed = () => false;

  test("alone: the next block as read, into an open toggle and out of it", () => {
    const { doc } = stateOf(NOTE);
    const down = (text: string, shown = open) =>
      chosenLines(doc, movedChoice(doc, between(doc, text, text), "down", false, shown));
    const up = (text: string, shown = open) =>
      chosenLines(doc, movedChoice(doc, between(doc, text, text), "up", false, shown));
    expect(down("一")).toEqual(["二"]);
    // The toggle chosen with what is inside it: past all of it.
    expect(down("二")).toEqual(["三"]);
    expect(down("二の中2")).toEqual(["三"]);
    expect(up("三")).toEqual(["二の中2"]);
    // Closed, what is inside it is not read.
    expect(up("三", closed)).toEqual(["二"]);
    expect(up("二の中1")).toEqual(["二"]);
    // At the top and the bottom: none.
    expect(movedChoice(doc, between(doc, "一", "一"), "up", false, open)).toBeNull();
    expect(movedChoice(doc, between(doc, "三", "三"), "down", false, open)).toBeNull();
  });

  test("with Shift: one more, past what is inside the chosen, and back a block", () => {
    const { doc } = stateOf(NOTE);
    const one = between(doc, "一", "一");
    const two = movedChoice(doc, one, "down", true, open)!;
    expect(chosenLines(doc, two)).toEqual(["一", "二"]);
    const three = movedChoice(doc, two, "down", true, open)!;
    expect(chosenLines(doc, three)).toEqual(["一", "二", "三"]);
    // Back towards where it started: the toggle's last line, which takes the toggle in.
    expect(chosenLines(doc, movedChoice(doc, three, "up", true, open))).toEqual(["一", "二"]);
    // Up from the first: at the top, none.
    expect(movedChoice(doc, one, "up", true, open)).toBeNull();
  });

  test("with Shift, from inside a toggle past its end: the toggle and on", () => {
    const { doc } = stateOf(NOTE);
    const inside = between(doc, "二の中2", "二の中2");
    expect(chosenLines(doc, movedChoice(doc, inside, "down", true, open))).toEqual(["二", "三"]);
  });
});

describe("blocks pasted", () => {
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
  /** 一 (a bullet), as a slice of the note, as a copy of it reads back. */
  const copied = (state: EditorState) => {
    const at = blockOf(state.doc, "一");
    return state.doc.slice(at, at + state.doc.nodeAt(at)!.nodeSize);
  };
  const NOTE2: PartialBlock[] = [
    { type: "bulletListItem", content: "一" },
    { type: "paragraph", content: "文の行" },
    { type: "paragraph" },
  ];
  const caretAt = (state: EditorState, text: string, offset = 0) =>
    state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, blockOf(state.doc, text) + 2 + offset)),
    );
  const pasted = (state: EditorState) => {
    const content = wholeBlocks(copied(state))!;
    return outline(state.apply(placeBlocks(state, content)!).doc);
  };

  test("are whole blocks; text from within a line is not", () => {
    const state = stateOf(NOTE2);
    expect(wholeBlocks(copied(state))?.childCount).toBe(1);
    const at = blockOf(state.doc, "文の行") + 2;
    expect(wholeBlocks(state.doc.slice(at, at + 2))).toBeNull();
    expect(wholeBlocks(Slice.empty)).toBeNull();
  });

  test("into an empty line, in its place; into a line of text, after it, mid-line too", () => {
    const state = stateOf(NOTE2);
    expect(pasted(caretAt(state, ""))).toEqual([
      "bulletListItem:一",
      "paragraph:文の行",
      "bulletListItem:一",
    ]);
    expect(pasted(caretAt(state, "文の行", 1))).toEqual([
      "bulletListItem:一",
      "paragraph:文の行",
      "bulletListItem:一",
      "paragraph:",
    ]);
  });

  test("over blocks chosen, in their place", () => {
    const state = stateOf(NOTE2);
    const at = blockOf(state.doc, "文の行");
    const chosen = state.apply(state.tr.setMeta(blockSelectKey, { anchor: at, head: at }));
    expect(pasted(chosen)).toEqual(["bulletListItem:一", "bulletListItem:一", "paragraph:"]);
  });
});
