import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  inset: 0,
  selectedBlocks: vi.fn(() => [] as unknown[]),
  updateBlock: vi.fn(),
  removeBlocks: vi.fn(),
}));
vi.mock("@blocknote/react", () => ({
  useBlockNoteEditor: () => ({
    isEditable: true,
    schema: { blockSchema: { paragraph: { content: "inline" }, codeBlock: { content: "plain" } } },
    transact: (change: () => void) => change(),
    updateBlock: h.updateBlock,
    removeBlocks: h.removeBlocks,
    focus: () => {},
    canNestBlock: () => false,
    canUnnestBlock: () => false,
  }),
  useSelectedBlocks: h.selectedBlocks,
}));
vi.mock("@/lib/hooks/use-keyboard-inset", () => ({ useKeyboardInset: () => h.inset }));
vi.mock("@/components/editor/image-crop", () => ({
  useCropTarget: () => null,
  useOpenCrop: () => () => {},
}));

import { MobileBlockToolbar } from "@/components/editor/mobile-block-toolbar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  h.inset = 0;
  h.selectedBlocks.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

test("with the keyboard down (a computer, always), the blocks selected are not followed", async () => {
  await act(() => root.render(<MobileBlockToolbar />));
  expect(h.selectedBlocks).not.toHaveBeenCalled();
});

test("with the keyboard up, they are", async () => {
  h.inset = 300;
  await act(() => root.render(<MobileBlockToolbar />));
  expect(h.selectedBlocks).toHaveBeenCalled();
});

test("a code block made a line again, its text kept, by its button pressed once more", async () => {
  h.inset = 300;
  const text = [{ type: "text", text: "x = 1", styles: {} }];
  h.selectedBlocks.mockReturnValue([{ id: "c", type: "codeBlock", props: {}, content: text, children: [] }]);
  await act(() => root.render(<MobileBlockToolbar />));
  const code = host.querySelector<HTMLButtonElement>('button[aria-label="コード"]')!;
  await act(async () => code.click());
  expect(h.updateBlock).toHaveBeenCalledWith(expect.objectContaining({ id: "c" }), { type: "paragraph", content: text });
});

test("ブロックを削除 with several blocks selected takes them all, as 複製 and コピー do", async () => {
  h.inset = 300;
  const line = (id: string) => ({ id, type: "paragraph", props: {}, content: [], children: [] });
  h.selectedBlocks.mockReturnValue([line("a"), line("b"), line("c")]);
  await act(() => root.render(<MobileBlockToolbar />));
  const remove = host.querySelector<HTMLButtonElement>('button[aria-label="ブロックを削除"]')!;
  await act(async () => remove.click());
  // Before: the first alone, the others left selected.
  expect(h.removeBlocks).toHaveBeenCalledTimes(1);
  expect((h.removeBlocks.mock.calls[0]![0] as { id: string }[]).map((block) => block.id)).toEqual(["a", "b", "c"]);
});
