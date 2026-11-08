import { BlockNoteEditor } from "@blocknote/core";
import { TextSelection } from "prosemirror-state";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ trace: vi.fn() }));
vi.mock("@/lib/debug/ime-trace", () => ({ traceIme: h.trace }));

import { imeCommit } from "@/components/editor/ime-commit";

let editor: BlockNoteEditor;
let host: HTMLDivElement;

beforeEach(() => {
  h.trace.mockClear();
  editor = BlockNoteEditor.create({ extensions: [imeCommit()] });
  host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "行" }]);
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
});

afterEach(() => {
  editor.unmount();
  host.remove();
});

const results = () => h.trace.mock.calls.map(([entry]) => entry).filter((e) => e.type === "ime:repair").map((e) => e.result);
/** What ProseMirror says of composing, held as told here (its own timers would clear it). */
const composing = (on: boolean) => {
  Object.defineProperty(editor.prosemirrorView!, "composing", { get: () => on, configurable: true });
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a repair that finds the editor still composing tries again, and does its work once it is not", async () => {
  const view = editor.prosemirrorView!;
  view.dom.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
  view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: "行" }));
  // The next word begun already, as ProseMirror sees it.
  composing(true);
  await wait(120);
  expect(results()).toContain("retry");
  expect(results()).not.toContain("none");
  composing(false);
  await wait(120);
  expect(results().at(-1)).toBe("none");
});

test("a repair still waiting stands down once another commit has come", async () => {
  const view = editor.prosemirrorView!;
  view.dom.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
  view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: "行" }));
  composing(true);
  await wait(60);
  view.dom.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
  composing(false);
  view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: "列" }));
  await wait(120);
  expect(results()).toContain("superseded");
  expect(results()).toContain("none");
});
