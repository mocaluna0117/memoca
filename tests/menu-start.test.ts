import { BlockNoteEditor } from "@blocknote/core";
import { TextSelection } from "prosemirror-state";
import { afterEach, beforeEach, expect, test } from "vitest";
import { atWordStart, slashMenuOpens } from "@/components/editor/menu-start";

let editor: BlockNoteEditor;
let host: HTMLDivElement;

beforeEach(() => {
  editor = BlockNoteEditor.create({ trailingBlock: false });
  host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
});

afterEach(() => {
  editor.unmount();
  host.remove();
});

/** A transaction with the caret after `text`, typed in a line of its own. */
function after(text: string) {
  editor.replaceBlocks(editor.document, [{ type: "paragraph", content: text }]);
  const view = editor.prosemirrorView!;
  let end = -1;
  view.state.doc.descendants((node, pos) => {
    if (end < 0 && node.isTextblock) end = pos + 1 + node.content.size;
    return end < 0;
  });
  return view.state.tr.setSelection(TextSelection.create(view.state.doc, end));
}

test("a menu's character begins a word at a line's start, or after a space (a full-width one too)", () => {
  expect(atWordStart(after(""))).toBe(true);
  expect(atWordStart(after("メモ "))).toBe(true);
  expect(atWordStart(after("メモ　"))).toBe(true);
});

test("the emoji menu's : not in the middle of a word, as a URL's is", () => {
  expect(atWordStart(after("https"))).toBe(false);
  expect(atWordStart(after("メモ"))).toBe(false);
});

test("the / menu after a line's text (to turn it), but not in a URL, a path or a date", () => {
  expect(slashMenuOpens(after(""))).toBe(true);
  expect(slashMenuOpens(after("やること"))).toBe(true);
  expect(slashMenuOpens(after("見出し "))).toBe(true);
  expect(slashMenuOpens(after("https:"))).toBe(false);
  expect(slashMenuOpens(after("https:/"))).toBe(false);
  expect(slashMenuOpens(after("https://example.com"))).toBe(false);
  expect(slashMenuOpens(after("見て example.com"))).toBe(false);
  expect(slashMenuOpens(after("締切 11"))).toBe(false);
});
