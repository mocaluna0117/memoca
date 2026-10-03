import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { type EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { describe, expect, test } from "vitest";
import { dragOntoMedia, extendOverMedia, selectAllOfIt } from "@/components/editor/select-media";

const IMAGE: PartialBlock = { type: "image", props: { url: "memoca://att/0190" } };

/** A note of these blocks, the caret (or a selection) in the line saying `text`. */
function stateOf(blocks: PartialBlock[], text: string, at: "start" | "end" = "end"): EditorState {
  const editor = BlockNoteEditor.create();
  editor.replaceBlocks(editor.document, blocks);
  const state = editor.prosemirrorState;
  let pos = -1;
  state.doc.descendants((node, found) => {
    if (pos < 0 && node.isTextblock && node.textContent === text) {
      pos = found + 1 + (at === "end" ? node.content.size : 0);
    }
    return pos < 0;
  });
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

/** What a selection takes, a block a line, images as [image]. */
const taken = (state: EditorState) =>
  state.doc.textBetween(state.selection.from, state.selection.to, "|", (leaf) =>
    leaf.type.name === "image" ? "[image]" : "",
  );

/** Presses Shift+↓ or ↑ as many times as given, at the edge of the lines each time. */
function press(state: EditorState, dir: "down" | "up", times = 1) {
  let next = state;
  for (let i = 0; i < times; i += 1) {
    const tr = extendOverMedia(next, dir, true);
    if (!tr) break;
    next = next.apply(tr);
  }
  return next;
}

describe("Shift and the arrow keys, from an image clicked", () => {
  /** A note of these blocks, the `nth` image selected as itself, as a click on it selects it. */
  function clicked(blocks: PartialBlock[], nth = 0): EditorState {
    const editor = BlockNoteEditor.create();
    editor.replaceBlocks(editor.document, blocks);
    const state = editor.prosemirrorState;
    const found: number[] = [];
    state.doc.descendants((node, pos) => {
      if (node.type.name === "image") found.push(pos);
      return true;
    });
    return state.apply(state.tr.setSelection(NodeSelection.create(state.doc, found[nth])));
  }

  test("↓ takes it and the next image, then the next, a press each", () => {
    const blocks = [IMAGE, IMAGE, IMAGE, { type: "paragraph", content: "下の行" } as PartialBlock];
    let state = press(clicked(blocks), "down");
    expect(taken(state)).toBe("[image]|[image]");
    state = press(state, "down");
    expect(taken(state)).toBe("[image]|[image]|[image]");
    state = press(state, "down");
    expect(taken(state)).toBe("[image]|[image]|[image]|下の行");
  });

  test("in an open toggle, ↓ stays in it, image by image", () => {
    const blocks: PartialBlock[] = [
      {
        type: "toggleListItem",
        content: "箱",
        children: [{ type: "paragraph", content: "中の上" }, IMAGE, IMAGE, IMAGE],
      },
    ];
    let state = press(clicked(blocks, 0), "down");
    expect(taken(state)).toBe("[image]|[image]");
    state = press(state, "down");
    expect(taken(state)).toBe("[image]|[image]|[image]");
    expect(taken(state)).not.toContain("箱");
  });

  test("↑ takes it and the line before", () => {
    const state = press(clicked([{ type: "paragraph", content: "上の行" }, IMAGE]), "up");
    expect(taken(state)).toBe("上の行|[image]");
  });

  test("with nothing that way, the image alone, to go on from (and back off it)", () => {
    const state = press(clicked([{ type: "paragraph", content: "上の行" }, IMAGE]), "down");
    expect(taken(state)).toBe("[image]");
    expect(press(state, "up").selection.empty).toBe(true);
    expect(taken(press(state, "up", 2))).toBe("上の行");
  });
});

describe("Shift and the arrow keys, next to an image", () => {
  test("↓ at the last line before an image at the end: the selection takes it", () => {
    const state = press(
      stateOf([{ type: "paragraph", content: "上の行" }, IMAGE], "上の行"),
      "down",
    );
    expect(taken(state)).toContain("[image]");
    // Inside the image's block, where BlockNote still finds the block it is in.
    expect(state.selection.$head.parent.type.name).toBe("blockContainer");
  });

  test("↑ at the first line after an image at the top: the selection takes it", () => {
    const state = press(
      stateOf([IMAGE, { type: "paragraph", content: "下の行" }], "下の行", "start"),
      "up",
    );
    expect(taken(state)).toContain("[image]");
    expect(state.selection.from).toBe(2);
  });

  test("two images, and a line after them: one a press, then the line whole", () => {
    const start = stateOf(
      [
        { type: "paragraph", content: "上" },
        IMAGE,
        IMAGE,
        { type: "paragraph", content: "下の行" },
      ],
      "上",
    );
    // From the end of 上: a | where one block ends and the next begins.
    expect(taken(press(start, "down", 1))).toBe("|[image]");
    expect(taken(press(start, "down", 2))).toBe("|[image]|[image]");
    expect(taken(press(start, "down", 3))).toBe("|[image]|[image]|下の行");
  });

  test("an image inside a block: after the block's line, first", () => {
    const state = press(
      stateOf([{ type: "paragraph", content: "親", children: [IMAGE] }], "親"),
      "down",
    );
    expect(taken(state)).toBe("|[image]");
  });

  test("an image last inside a block above: before the line below, it is taken first", () => {
    const state = press(
      stateOf(
        [
          { type: "paragraph", content: "親", children: [IMAGE] },
          { type: "paragraph", content: "下" },
        ],
        "下",
        "start",
      ),
      "up",
    );
    expect(taken(state)).toBe("[image]|");
  });

  test("left to the browser: text next, not at the edge of the lines, or a table", () => {
    const text = stateOf(
      [
        { type: "paragraph", content: "上" },
        { type: "paragraph", content: "下" },
      ],
      "上",
    );
    expect(extendOverMedia(text, "down", true)).toBeNull();
    const image = stateOf([{ type: "paragraph", content: "上" }, IMAGE], "上");
    expect(extendOverMedia(image, "down", false)).toBeNull();
    const table = stateOf(
      [
        { type: "paragraph", content: "上" },
        { type: "table", content: { type: "tableContent", rows: [{ cells: ["A"] }] } },
      ],
      "上",
    );
    expect(extendOverMedia(table, "down", true)).toBeNull();
  });

  test("↑ straight after ↓ lets the image go: the caret, where it began", () => {
    const start = stateOf([{ type: "paragraph", content: "上の行" }, IMAGE], "上の行");
    const back = press(press(start, "down"), "up");
    expect(back.selection.empty).toBe(true);
    expect(back.selection.head).toBe(start.selection.head);
  });

  test("what a closed toggle hides is passed over", () => {
    const blocks: PartialBlock[] = [
      { type: "toggleListItem", content: "箱", children: [IMAGE] },
      { type: "paragraph", content: "下" },
    ];
    const closed = () => false;
    const down = stateOf(blocks, "箱");
    expect(extendOverMedia(down, "down", true, closed)).toBeNull();
    const up = stateOf(blocks, "下", "start");
    expect(extendOverMedia(up, "up", true, closed)).toBeNull();
    // Open, it is there to take.
    expect(taken(press(down, "down"))).toBe("|[image]");
  });

  test("an image the last inside a block above an image: out of the block, on to it", () => {
    const state = press(
      stateOf(
        [
          { type: "paragraph", content: "親", children: [{ type: "paragraph", content: "子" }] },
          IMAGE,
        ],
        "子",
      ),
      "down",
    );
    expect(taken(state)).toBe("|[image]");
  });

  test("back up from the first block inside another, over an image, to the other's line", () => {
    const state = press(
      stateOf(
        [
          {
            type: "paragraph",
            content: "親の行",
            children: [IMAGE, { type: "paragraph", content: "子" }],
          },
        ],
        "子",
        "start",
      ),
      "up",
      2,
    );
    expect(taken(state)).toBe("親の行|[image]|");
  });

  test("an image, then a table: on into the table, to its last cell", () => {
    const state = press(
      stateOf(
        [
          { type: "paragraph", content: "上" },
          IMAGE,
          {
            type: "table",
            content: {
              type: "tableContent",
              rows: [{ cells: ["A1", "B1"] }, { cells: ["A2", "B2"] }],
            },
          },
        ],
        "上",
      ),
      "down",
      2,
    );
    expect(taken(state)).toBe("|[image]|A1|B1|A2|B2");
  });

  test("in a table's cell, or an image selected by a click: left to the table, or the browser", () => {
    const table = stateOf(
      [
        {
          type: "table",
          content: { type: "tableContent", rows: [{ cells: ["A1"] }, { cells: ["A2"] }] },
        },
        IMAGE,
      ],
      "A2",
    );
    expect(extendOverMedia(table, "down", true)).toBeNull();
    const image = stateOf([{ type: "paragraph", content: "上" }, IMAGE], "上");
    const group = image.doc.firstChild!;
    const clicked = image.apply(
      image.tr.setSelection(NodeSelection.create(image.doc, 1 + group.child(0).nodeSize)),
    );
    expect(extendOverMedia(clicked, "up", true)).toBeNull();
  });

  test("all the text selected (⌘A): images before the first line and after the last taken too", () => {
    const state = stateOf([IMAGE, { type: "paragraph", content: "本文" }, IMAGE], "本文");
    let first = -1;
    let last = -1;
    state.doc.descendants((node, pos) => {
      if (node.isTextblock) {
        first = first < 0 ? pos + 1 : first;
        last = pos + 1 + node.content.size;
      }
      return true;
    });
    const all = state.apply(state.tr.setSelection(TextSelection.create(state.doc, first, last)));
    const tr = selectAllOfIt(all)!;
    expect(taken(all.apply(tr))).toBe("[image]|本文|[image]");
    // Part of the text only: left as it is.
    const part = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, first, last - 1)),
    );
    expect(selectAllOfIt(part)).toBeNull();
    // Text only, nothing else to take: left as it is.
    const text = stateOf([{ type: "paragraph", content: "本文" }], "本文");
    const allText = text.apply(
      text.tr.setSelection(TextSelection.create(text.doc, 3, 3 + "本文".length)),
    );
    expect(selectAllOfIt(allText)).toBeNull();
  });

  test("a drag let go of over an image, or past it: taken on over it, from where it began", () => {
    const state = stateOf([{ type: "paragraph", content: "上の行" }, IMAGE], "上の行", "start");
    const group = state.doc.firstChild!;
    const image = { node: group.child(1), pos: 1 + group.child(0).nodeSize };
    const down = state.apply(dragOntoMedia(state, state.selection.anchor, image)!);
    expect(taken(down)).toBe("上の行|[image]");
    // Up, from below an image at the top.
    const up = stateOf([IMAGE, { type: "paragraph", content: "下の行" }], "下の行");
    const top = { node: up.doc.firstChild!.child(0), pos: 1 };
    expect(taken(up.apply(dragOntoMedia(up, up.selection.anchor, top)!))).toBe("[image]|下の行");
    // Not an image: nothing.
    const text = { node: group.child(0), pos: 1 };
    expect(dragOntoMedia(state, state.selection.anchor, text)).toBeNull();
  });
});
