import { BlockNoteEditor } from "@blocknote/core";
import { TextSelection } from "prosemirror-state";
import { ySyncPluginKey } from "y-prosemirror";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { TODO_TIDY, todoOnly } from "@/components/editor/todo-only";

let editor: BlockNoteEditor;
let host: HTMLDivElement;

beforeEach(() => {
  editor = BlockNoteEditor.create({ extensions: [todoOnly()], trailingBlock: false });
  host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
});

afterEach(() => {
  editor.unmount();
  host.remove();
});

const view = () => editor.prosemirrorView!;
const textOf = (block: { content?: unknown }) =>
  Array.isArray(block.content) ? (block.content as { text?: string }[]).map((run) => run.text ?? "").join("") : "";
/** The list as it reads: "[x] 卵" for one done, "[ ] 牛乳" for one to do. */
const list = () =>
  editor.document.map((block) =>
    block.type === "checkListItem"
      ? `[${(block.props as { checked: boolean }).checked ? "x" : " "}] ${textOf(block)}`
      : `${block.type}: ${textOf(block)}`,
  );
const items = (...lines: string[]) =>
  editor.replaceBlocks(
    editor.document,
    lines.map((line) => ({
      type: "checkListItem" as const,
      props: { checked: line.startsWith("[x]") },
      content: line.slice(4),
    })),
  );
const blockWith = (text: string) => editor.document.find((block) => textOf(block) === text)!;
/** The caret into the item of this text, at `offset`. */
function caretIn(text: string, offset: number) {
  let found = -1;
  view().state.doc.descendants((node, pos) => {
    if (found < 0 && node.type.name === "checkListItem" && node.textContent === text) found = pos + 1;
    return found < 0;
  });
  view().dispatch(view().state.tr.setSelection(TextSelection.create(view().state.doc, found + offset)));
}
const caret = () => {
  const { $from } = view().state.selection;
  return { text: $from.parent.textContent, offset: $from.parentOffset };
};
const press = (key: string, init: KeyboardEventInit = {}) =>
  view().dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));

describe("the Todo's blocks", () => {
  test("a line of text, pasted or made, becomes an item, its text kept", () => {
    editor.replaceBlocks(editor.document, [
      { type: "paragraph", content: "牛乳" },
      { type: "heading", content: "卵" },
    ]);
    expect(list()).toEqual(["[ ] 牛乳", "[ ] 卵"]);
  });

  test("anything else (an image) is taken out", () => {
    items("[ ] 牛乳");
    editor.insertBlocks([{ type: "image", props: { url: "https://example.com/a.png" } }], blockWith("牛乳"), "after");
    expect(list()).toEqual(["[ ] 牛乳"]);
  });

  test("the editor's own first, empty line is made an item as the Todo is shown", () => {
    editor.replaceBlocks(editor.document, [{ type: "paragraph" }]);
    view().dispatch(view().state.tr.setMeta(TODO_TIDY, true));
    expect(list()).toEqual(["[ ] "]);
  });
});

describe("the Todo's done", () => {
  test("one ticked goes to the top of the done; one unticked to the foot of those to do", () => {
    items("[ ] 牛乳", "[ ] 卵", "[ ] パン", "[x] 洗剤");
    editor.updateBlock(blockWith("卵"), { props: { checked: true } });
    expect(list()).toEqual(["[ ] 牛乳", "[ ] パン", "[x] 卵", "[x] 洗剤"]);
    editor.updateBlock(blockWith("洗剤"), { props: { checked: false } });
    expect(list()).toEqual(["[ ] 牛乳", "[ ] パン", "[ ] 洗剤", "[x] 卵"]);
  });

  test("ticked with the caret in it (by its box), the caret goes with it, where it was in the text", () => {
    items("[ ] 牛乳", "[ ] 卵焼き", "[ ] パン");
    caretIn("卵焼き", 1);
    editor.updateBlock(blockWith("卵焼き"), { props: { checked: true } });
    expect(list()).toEqual(["[ ] 牛乳", "[ ] パン", "[x] 卵焼き"]);
    expect(caret()).toEqual({ text: "卵焼き", offset: 1 });
  });

  test("another device's change (or an undo), Yjs's own, is left as it came", () => {
    items("[ ] 牛乳", "[ ] 卵");
    const state = view().state;
    let first = -1;
    state.doc.descendants((node, pos) => {
      if (first < 0 && node.type.name === "checkListItem") first = pos;
      return first < 0;
    });
    const tr = state.tr
      .setNodeMarkup(first, undefined, { ...state.doc.nodeAt(first)!.attrs, checked: true })
      .setMeta(ySyncPluginKey, { isChangeOrigin: true });
    view().dispatch(tr);
    // Left where it was: not sorted on top of the other device's own sorting.
    expect(list()).toEqual(["[x] 牛乳", "[ ] 卵"]);
  });
});

describe("the Todo's keys", () => {
  test("⌘ + Enter ticks the item, and the caret goes on to the next to do", () => {
    items("[ ] 牛乳", "[ ] 卵", "[ ] パン");
    caretIn("牛乳", 2);
    press("Enter", { ctrlKey: true });
    expect(list()).toEqual(["[ ] 卵", "[ ] パン", "[x] 牛乳"]);
    expect(caret()).toEqual({ text: "卵", offset: 0 });
    press("Enter", { ctrlKey: true });
    expect(list()).toEqual(["[ ] パン", "[x] 卵", "[x] 牛乳"]);
  });

  test("Backspace at an item's start joins it to the one above; an empty one goes", () => {
    items("[ ] 牛乳", "[ ] と卵", "[ ] ");
    caretIn("", 0);
    press("Backspace");
    expect(list()).toEqual(["[ ] 牛乳", "[ ] と卵"]);
    expect(caret()).toEqual({ text: "と卵", offset: 2 });
    caretIn("と卵", 0);
    press("Backspace");
    expect(list()).toEqual(["[ ] 牛乳と卵"]);
    expect(caret()).toEqual({ text: "牛乳と卵", offset: 2 });
  });

  test("Backspace in the first item, and Enter in an empty one, leave the list as it is", () => {
    items("[ ] 牛乳", "[ ] ");
    caretIn("牛乳", 0);
    press("Backspace");
    caretIn("", 0);
    press("Enter");
    expect(list()).toEqual(["[ ] 牛乳", "[ ] "]);
  });
});

describe("the Todo's ids", () => {
  test("the editor's one first id is not kept: an item of the Todo's has an id of its own", () => {
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "牛乳" }]);
    const view = editor.prosemirrorView!;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === "blockContainer") at = pos;
      return at < 0;
    });
    view.dispatch(view.state.tr.setNodeMarkup(at, undefined, { ...view.state.doc.nodeAt(at)!.attrs, id: "initialBlockId" }));
    expect(editor.document[0]!.id).not.toBe("initialBlockId");
  });
});
