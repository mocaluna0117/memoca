import { BlockNoteEditor } from "@blocknote/core";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { straySelection } from "@/components/editor/stray-selection";

let editor: BlockNoteEditor;
let host: HTMLDivElement;

// jsdom lays nothing out: ProseMirror, scrolling to a selection it reads, asks a range where it is.
const rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 };
Range.prototype.getClientRects ??= () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => rect as DOMRect;

beforeEach(() => {
  editor = BlockNoteEditor.create({ extensions: [straySelection()], trailingBlock: false });
  host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  editor.replaceBlocks(
    editor.document,
    ["上の項目", "下の項目"].map((text) => ({ type: "checkListItem" as const, content: text })),
  );
  // jsdom has no focus for an editable element: the editor's, as it is in the app.
  view().hasFocus = () => true;
});

afterEach(() => {
  editor.unmount();
  host.remove();
});

const view = (): EditorView => editor.prosemirrorView!;
/** A moment: what the person does next comes after what they did. */
const later = () => new Promise((resolve) => setTimeout(resolve, 3));
const lines = () =>
  editor.document.map((block) => (block.content as { text: string }[]).map((part) => part.text).join(""));
function textAt(text: string) {
  let found = -1;
  view().state.doc.descendants((node, pos) => {
    if (found < 0 && node.isTextblock && node.textContent === text) found = pos + 1;
    return found < 0;
  });
  return found;
}
const line = (text: string) => [...host.querySelectorAll(".bn-inline-content")].find((p) => p.textContent === text)!;
const caretAt = (pos: number) => view().dispatch(view().state.tr.setSelection(TextSelection.create(view().state.doc, pos)));
const key = (init: KeyboardEventInit) =>
  view().dom.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
const pointer = (type: string, init: MouseEventInit = {}) =>
  view().dom.dispatchEvent(new MouseEvent(type, { bubbles: true, ...init }));
const selectionChanged = () => document.dispatchEvent(new Event("selectionchange"));
const page = () => getSelection()!;

/**
 * Enter at the end of 上の項目, and the page's selection then taken on, as
 * WebKit takes it on to a pointer pressed there and never let go of: from
 * the new item's start (the caret) back to the end of the item above.
 */
async function enterThenTakenOn() {
  pointer("pointerdown", { buttons: 1 });
  pointer("pointermove", { buttons: 1 });
  await later();
  caretAt(textAt("上の項目") + 4);
  key({ key: "Enter" });
  expect(view().state.selection.$from.parent.textContent).toBe("");
  const above = line("上の項目");
  const made = above.closest(".bn-block-outer")!.nextElementSibling!.querySelector(".bn-inline-content")!;
  page().setBaseAndExtent(made, 0, above.firstChild!, 4);
}

describe("a range the page takes on after typing, from a press never let go of", () => {
  test("is put back to the caret as it comes, before the editor reads it", async () => {
    await enterThenTakenOn();
    selectionChanged();
    expect(page().isCollapsed).toBe(true);
    expect(view().state.selection.empty).toBe(true);
    expect(view().state.selection.$from.parent.textContent).toBe("");
    expect(lines()).toEqual(["上の項目", "", "下の項目"]);
  });

  test("is put back as the next key comes, or a word begins, the new item kept", async () => {
    await enterThenTakenOn();
    key({ key: "a" });
    expect(page().isCollapsed).toBe(true);

    await later();
    const above = line("上の項目");
    const made = above.closest(".bn-block-outer")!.nextElementSibling!.querySelector(".bn-inline-content")!;
    page().setBaseAndExtent(made, 0, above.firstChild!, 4);
    view().dom.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
    expect(lines()).toEqual(["上の項目", "", "下の項目"]);
    expect(view().state.selection.$from.parent.textContent).toBe("");
  });

  test("within the line: the character before the caret, selected after each typed, is put back", async () => {
    pointer("pointerdown", { buttons: 1 });
    await later();
    caretAt(textAt("上の項目") + 4);
    key({ key: "x" });
    const text = line("上の項目").firstChild!;
    page().setBaseAndExtent(text, 4, text, 3);
    selectionChanged();
    expect(page().isCollapsed).toBe(true);
    expect(view().state.selection.empty).toBe(true);
  });
});

describe("a range the person made, or the editor did, is left as it is", () => {
  test("one made by dragging the pointer over the text", async () => {
    caretAt(textAt("上の項目") + 4);
    key({ key: "x" });
    await later();
    pointer("pointerdown", { buttons: 1 });
    pointer("pointermove", { buttons: 1 });
    const text = line("上の項目").firstChild!;
    page().setBaseAndExtent(text, 4, text, 1);
    selectionChanged();
    expect(page().isCollapsed).toBe(false);
    expect(view().state.selection.empty).toBe(false);
  });

  test("one made with Shift and an arrow", async () => {
    caretAt(textAt("上の項目") + 4);
    key({ key: "x" });
    await later();
    key({ key: "ArrowLeft", shiftKey: true });
    const text = line("上の項目").firstChild!;
    page().setBaseAndExtent(text, 4, text, 3);
    selectionChanged();
    expect(page().isCollapsed).toBe(false);
  });

  test("the editor's own (⌘A, a match found)", async () => {
    key({ key: "x" });
    await later();
    const from = textAt("上の項目");
    view().dispatch(view().state.tr.setSelection(TextSelection.create(view().state.doc, from, from + 2)));
    const text = line("上の項目").firstChild!;
    page().setBaseAndExtent(text, 0, text, 2);
    selectionChanged();
    expect(page().isCollapsed).toBe(false);
    expect(view().state.selection.empty).toBe(false);
  });

  test("every line, as the Edit menu's Select All makes it", async () => {
    caretAt(textAt("上の項目") + 4);
    key({ key: "x" });
    await later();
    page().setBaseAndExtent(line("上の項目").firstChild!, 0, line("下の項目").firstChild!, 4);
    selectionChanged();
    expect(page().isCollapsed).toBe(false);
  });

  test("one while a word is being written: the input method's", async () => {
    caretAt(textAt("上の項目") + 4);
    key({ key: "x" });
    await later();
    view().dom.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));
    const text = line("上の項目").firstChild!;
    page().setBaseAndExtent(text, 4, text, 2);
    selectionChanged();
    expect(page().isCollapsed).toBe(false);
  });
});
