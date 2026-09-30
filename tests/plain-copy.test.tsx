import { BlockNoteEditor } from "@blocknote/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { NodeSelection, TextSelection } from "prosemirror-state";
import { afterEach, expect, test, vi } from "vitest";
import { usePlainTextCopy } from "@/components/editor/plain-copy";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Hook({ editor }: { editor: BlockNoteEditor }) {
  usePlainTextCopy(editor);
  return null;
}

/** A copy or cut event as a browser fires it, with a clipboard to write to. */
function clip(kind: "copy" | "cut", target: EventTarget) {
  const data = new Map<string, string>();
  const event = new Event(kind, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      setData: (t: string, v: string) => data.set(t, v),
      getData: (t: string) => data.get(t) ?? "",
      clearData: () => data.clear(),
    },
  });
  target.dispatchEvent(event);
  return { data, event };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

async function setup() {
  const editor = BlockNoteEditor.create();
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  editor.replaceBlocks(editor.document, [
    { type: "paragraph", content: "一行目\n二行目" },
    { type: "bulletListItem", content: "牛乳" },
  ]);
  const view = editor.prosemirrorView!;
  const [a, b] = editor.document;
  editor.setSelection(a!, b!);
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  await act(async () => root.render(createElement(Hook, { editor })));
  cleanup = () => {
    act(() => root.unmount());
    editor.unmount();
    host.remove();
    box.remove();
  };
  return { editor, view };
}

test("a copy from the note gives the text as it reads", async () => {
  const { view } = await setup();
  const { data, event } = clip("copy", view.dom);
  expect(event.defaultPrevented).toBe(true);
  expect(data.get("text/plain")).toBe("一行目\n二行目\n・牛乳");
  expect(data.get("text/html")).toContain("<ul>");
});

test("a cut does too, read before the editor takes the selection away", async () => {
  const { view } = await setup();
  const { data } = clip("cut", view.dom);
  expect(data.get("text/plain")).toBe("一行目\n二行目\n・牛乳");
});

test("a copy outside the note is left alone", async () => {
  await setup();
  const input = document.createElement("input");
  document.body.append(input);
  const { data, event } = clip("copy", input);
  input.remove();
  expect(event.defaultPrevented).toBe(false);
  expect(data.size).toBe(0);
});

test("a selection the editor has not seen yet (select all) is read", async () => {
  const { view, editor } = await setup();
  editor.setTextCursorPosition(editor.document[0]!, "start");
  view.focus();
  // The DOM selection changes with no event ProseMirror has handled yet.
  const sel = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(view.dom);
  sel.removeAllRanges();
  sel.addRange(range);
  const { data } = clip("copy", view.dom);
  expect(data.get("text/plain")).toBe("一行目\n二行目\n・牛乳");
});

test("a later copy outside the note does not reuse a stale text", async () => {
  const { view } = await setup();
  // The editor stops a copy from bubbling: nothing resets the text on the way up.
  const stop = (e: Event) => e.stopPropagation();
  view.dom.addEventListener("copy", stop);
  clip("copy", view.dom);
  view.dom.removeEventListener("copy", stop);
  const input = document.createElement("input");
  document.body.append(input);
  const { data } = clip("copy", input);
  input.remove();
  expect(data.get("text/plain")).toBeUndefined();
});

test("on Windows, lines end as its plain-text apps want them", async () => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  );
  const { view } = await setup();
  const { data } = clip("copy", view.dom);
  vi.restoreAllMocks();
  expect(data.get("text/plain")).toBe("一行目\r\n二行目\r\n・牛乳");
});

test("an editor not shown yet: a copy elsewhere is left alone, and nothing breaks", async () => {
  const editor = BlockNoteEditor.create();
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  await act(async () => root.render(createElement(Hook, { editor })));
  const errors: unknown[] = [];
  const onError = (e: ErrorEvent) => {
    errors.push(e.error);
    e.preventDefault();
  };
  window.addEventListener("error", onError);
  clip("copy", box);
  window.removeEventListener("error", onError);
  act(() => root.unmount());
  expect(errors.map(String)).toEqual([]);
});

test("a toggle's line all selected: copied with what is inside it, for every app, and the selection kept", async () => {
  const { editor, view } = await setup();
  editor.replaceBlocks(editor.document, [
    {
      type: "toggleListItem",
      content: "箱",
      children: [{ type: "paragraph", content: "中身" }],
    },
    { type: "paragraph", content: "後" },
  ]);
  const toggle = editor.document[0]!;
  editor.setTextCursorPosition(toggle, "start");
  const start = view.state.selection.from;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start, start + 1)));
  const before = view.state.selection.toJSON();
  const { data, event } = clip("copy", view.dom);
  expect(event.defaultPrevented).toBe(true);
  expect(data.get("text/plain")).toBe("箱\n  中身");
  expect(data.get("text/html")).toContain("中身");
  expect(data.get("blocknote/html")).toContain("中身");
  expect(data.get("blocknote/html")).toContain("toggleListItem");
  expect(view.state.selection.toJSON()).toEqual(before);

  // A cut takes it all, and leaves nothing of it behind.
  const cut = clip("cut", view.dom);
  expect(cut.event.defaultPrevented).toBe(true);
  expect(cut.data.get("text/plain")).toBe("箱\n  中身");
  expect(editor.document.map((block) => block.type)).toEqual(["paragraph"]);
  expect(JSON.stringify(editor.document)).not.toContain("中身");
});

test("an open toggle's line: copied as selected", async () => {
  const { editor, view } = await setup();
  editor.replaceBlocks(editor.document, [
    { type: "toggleListItem", content: "箱", children: [{ type: "paragraph", content: "中身" }] },
  ]);
  const toggle = editor.document[0]!;
  const wrapper = view.dom.querySelector(".bn-toggle-wrapper")!;
  wrapper.setAttribute("data-show-children", "true");
  editor.setTextCursorPosition(toggle, "start");
  const start = view.state.selection.from;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start, start + 1)));
  const { data } = clip("copy", view.dom);
  expect(data.get("text/plain")).toBe("箱");
});

test("an image alone gives apps that take plain text nothing, not Markdown for it", async () => {
  const { editor, view } = await setup();
  editor.replaceBlocks(editor.document, [
    { type: "paragraph", content: "上" },
    { type: "image", props: { url: "memoca://att/0190", name: "写真.png" } },
  ]);
  const group = view.state.doc.firstChild!;
  const imagePos = 1 + group.child(0).nodeSize;
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, imagePos)));
  const { data } = clip("copy", view.dom);
  expect(data.get("text/html")).toContain("<img");
  expect(data.get("text/plain")).toBe("");
});
