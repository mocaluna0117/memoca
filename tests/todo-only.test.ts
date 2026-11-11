import { BlockNoteEditor } from "@blocknote/core";
import { TextSelection } from "prosemirror-state";
import { ySyncPluginKey } from "y-prosemirror";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { japaneseChecks } from "@/components/editor/japanese-lists";
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
type Shown = { type: string; props: unknown; content?: unknown; children: Shown[] };
const lineOf = (block: Shown): string =>
  block.type === "checkListItem"
    ? `[${(block.props as { checked: boolean }).checked ? "x" : " "}] ${textOf(block)}`
    : block.type === "paragraph"
      ? `・${textOf(block)}`
      : `${block.type}: ${textOf(block)}`;
/**
 * The list as it reads: "[x] 卵" for one done, "[ ] 牛乳" for one to do, and
 * under an item, its details, a step in: "  ・説明".
 */
const list = () => {
  const lines: string[] = [];
  const walk = (blocks: Shown[], depth: number) => {
    for (const block of blocks) {
      lines.push(`${"  ".repeat(depth)}${lineOf(block)}`);
      walk(block.children, depth + 1);
    }
  };
  walk(editor.document as unknown as Shown[], 0);
  return lines;
};
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
/** The caret into the line (an item's, or a detail's) of this text, at `offset`. */
function caretIn(text: string, offset: number) {
  let found = -1;
  view().state.doc.descendants((node, pos) => {
    if (found < 0 && node.isTextblock && node.textContent === text) found = pos + 1;
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
const type = (text: string) => view().dispatch(view().state.tr.insertText(text));
/** An item, and lines of its details. */
const withDetails = (line: string, ...details: string[]) => ({
  type: "checkListItem" as const,
  props: { checked: line.startsWith("[x]") },
  content: line.slice(4),
  children: details.map((detail) => ({ type: "paragraph" as const, content: detail })),
});

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

describe("an item's details", () => {
  test("tick boxes in an item, as they were before details were, are its details now, however far in", () => {
    editor.replaceBlocks(editor.document, [
      {
        type: "checkListItem",
        content: "株式会社デジタルガレージ",
        children: [
          {
            type: "checkListItem",
            props: { checked: true },
            content: "適性検査",
            children: [{ type: "heading", content: "11/13 23:59" }],
          },
          { type: "image", props: { url: "https://example.com/a.png" } },
        ],
      },
      { type: "checkListItem", content: "TOPPAN" },
    ]);
    expect(list()).toEqual(["[ ] 株式会社デジタルガレージ", "  ・適性検査", "  ・11/13 23:59", "[ ] TOPPAN"]);
  });

  test("Shift + Enter starts a line of them under the item, what is after the caret going into it", () => {
    editor.replaceBlocks(editor.document, [withDetails("[ ] 富士フイルム", "11/30 正午")]);
    caretIn("富士フイルム", 6);
    press("Enter", { shiftKey: true });
    type("https://fujifilm.example/");
    expect(list()).toEqual(["[ ] 富士フイルム", "  ・https://fujifilm.example/", "  ・11/30 正午"]);
    caretIn("富士フイルム", 2);
    press("Enter", { shiftKey: true });
    expect(list()).toEqual(["[ ] 富士", "  ・フイルム", "  ・https://fujifilm.example/", "  ・11/30 正午"]);
    expect(caret()).toEqual({ text: "フイルム", offset: 0 });
  });

  test("Enter in one goes on to the next; in an empty one, out of them, to a new item", () => {
    editor.replaceBlocks(editor.document, [withDetails("[ ] 富士フイルム", "説明"), withDetails("[ ] カプコン")]);
    caretIn("説明", 2);
    press("Enter");
    type("URL");
    expect(list()).toEqual(["[ ] 富士フイルム", "  ・説明", "  ・URL", "[ ] カプコン"]);
    press("Enter");
    press("Enter");
    type("TOPPAN");
    expect(list()).toEqual(["[ ] 富士フイルム", "  ・説明", "  ・URL", "[ ] TOPPAN", "[ ] カプコン"]);
  });

  test("Enter in an item with them: the new item after them, or (at its start) an empty one above", () => {
    editor.replaceBlocks(editor.document, [withDetails("[ ] 富士フイルム", "説明")]);
    caretIn("富士フイルム", 6);
    press("Enter");
    type("カプコン");
    expect(list()).toEqual(["[ ] 富士フイルム", "  ・説明", "[ ] カプコン"]);
    caretIn("富士フイルム", 0);
    press("Enter");
    expect(list()).toEqual(["[ ] ", "[ ] 富士フイルム", "  ・説明", "[ ] カプコン"]);
    expect(caret()).toEqual({ text: "富士フイルム", offset: 0 });
  });

  test("Tab makes an item one of them, of the item above; Shift + Tab makes one an item again", () => {
    editor.replaceBlocks(editor.document, [
      withDetails("[ ] 株式会社デジタルガレージ", "説明"),
      withDetails("[ ] 適性検査", "11/13"),
      withDetails("[ ] TOPPAN"),
    ]);
    caretIn("適性検査", 2);
    press("Tab");
    expect(list()).toEqual(["[ ] 株式会社デジタルガレージ", "  ・説明", "  ・適性検査", "  ・11/13", "[ ] TOPPAN"]);
    expect(caret()).toEqual({ text: "適性検査", offset: 2 });
    caretIn("説明", 1);
    press("Tab", { shiftKey: true });
    // Those after it going with it, as its own.
    expect(list()).toEqual(["[ ] 株式会社デジタルガレージ", "[ ] 説明", "  ・適性検査", "  ・11/13", "[ ] TOPPAN"]);
    expect(caret()).toEqual({ text: "説明", offset: 1 });
  });

  test("Tab in the first item, or in a line of details, leaves the list as it is", () => {
    editor.replaceBlocks(editor.document, [withDetails("[ ] 牛乳", "説明")]);
    caretIn("牛乳", 0);
    press("Tab");
    caretIn("説明", 0);
    press("Tab");
    caretIn("牛乳", 0);
    press("Tab", { shiftKey: true });
    expect(list()).toEqual(["[ ] 牛乳", "  ・説明"]);
  });

  test("Backspace at one's start joins it to the line above; an empty one goes", () => {
    editor.replaceBlocks(editor.document, [withDetails("[ ] 富士", "フイルム", "", "URL")]);
    caretIn("", 0);
    press("Backspace");
    expect(list()).toEqual(["[ ] 富士", "  ・フイルム", "  ・URL"]);
    expect(caret()).toEqual({ text: "フイルム", offset: 4 });
    caretIn("フイルム", 0);
    press("Backspace");
    expect(list()).toEqual(["[ ] 富士フイルム", "  ・URL"]);
    expect(caret()).toEqual({ text: "富士フイルム", offset: 2 });
  });

  test("Backspace at an item's start joins it to the last of the details above; its own go on after", () => {
    editor.replaceBlocks(editor.document, [withDetails("[ ] 富士", "説明"), withDetails("[ ] と URL", "11/30")]);
    caretIn("と URL", 0);
    press("Backspace");
    expect(list()).toEqual(["[ ] 富士", "  ・説明と URL", "  ・11/30"]);
    expect(caret()).toEqual({ text: "説明と URL", offset: 2 });
  });

  test("go with their item as it is ticked; ⌘ + Enter in one ticks its item", () => {
    editor.replaceBlocks(editor.document, [withDetails("[ ] 富士", "説明"), withDetails("[ ] カプコン", "URL")]);
    caretIn("説明", 1);
    press("Enter", { ctrlKey: true });
    expect(list()).toEqual(["[ ] カプコン", "  ・URL", "[x] 富士", "  ・説明"]);
    expect(caret()).toEqual({ text: "カプコン", offset: 0 });
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

describe("⌘A in the Todo", () => {
  test("selects every line, and Backspace then leaves one empty item to write in", () => {
    editor.replaceBlocks(editor.document, [
      withDetails("[ ] 牛乳", "駅前の店で"),
      { type: "checkListItem", props: { checked: false }, content: "卵" },
      { type: "checkListItem", props: { checked: true }, content: "パン" },
    ]);
    caretIn("卵", 1);
    press("a", { ctrlKey: true });
    expect(view().state.selection.toJSON()).toEqual({ type: "all" });
    press("Backspace");
    expect(list()).toEqual(["[ ] "]);
    type("新しい項目");
    expect(list()).toEqual(["[ ] 新しい項目"]);
  });
});

describe("an item started as with a Japanese input method", () => {
  /** Typed a character at a time, as the editor takes it (its input rules among it). */
  const typeAsTyped = (target: BlockNoteEditor, text: string) => {
    const view = target.prosemirrorView!;
    for (const char of text) {
      const { from, to } = view.state.selection;
      const insert = () => view.state.tr.insertText(char, from, to);
      if (!view.someProp("handleTextInput", (handle) => handle(view, from, to, char, insert))) view.dispatch(insert());
    }
  };

  test("「」 and a space go, as [] and a space do; 「x」 ticks it", () => {
    const todo = BlockNoteEditor.create({ extensions: [todoOnly(), japaneseChecks], trailingBlock: false });
    const place = document.createElement("div");
    document.body.append(place);
    todo.mount(place);
    try {
      todo.replaceBlocks(todo.document, [{ type: "checkListItem", props: { checked: false }, content: "" }]);
      const view = todo.prosemirrorView!;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
      typeAsTyped(todo, "「」　りんご");
      expect(todo.document.map((block) => [textOf(block), (block.props as { checked: boolean }).checked])).toEqual([
        ["りんご", false],
      ]);
      todo.replaceBlocks(todo.document, [{ type: "checkListItem", props: { checked: false }, content: "" }]);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
      typeAsTyped(todo, "「x」　済み");
      expect(todo.document.map((block) => [textOf(block), (block.props as { checked: boolean }).checked])).toEqual([
        ["済み", true],
      ]);
    } finally {
      todo.unmount();
      place.remove();
    }
  });
});

describe("Enter at the start of an item", () => {
  test("puts an empty item above it: the item keeps its id (its due, its reminders) and its tick", () => {
    items("[ ] 牛乳を買う", "[ ] 卵");
    const id = blockWith("牛乳を買う").id;
    caretIn("牛乳を買う", 0);
    press("Enter");
    expect(list()).toEqual(["[ ] ", "[ ] 牛乳を買う", "[ ] 卵"]);
    expect(blockWith("牛乳を買う").id).toBe(id);
    // The caret stays with the item's text, to go on writing it.
    expect(caret()).toEqual({ text: "牛乳を買う", offset: 0 });
  });
});
