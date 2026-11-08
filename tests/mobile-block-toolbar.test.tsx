import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  inset: 0,
  selectedBlocks: vi.fn(() => [] as unknown[]),
}));
vi.mock("@blocknote/react", () => ({
  useBlockNoteEditor: () => ({ isEditable: true, schema: { blockSchema: {} }, transact: () => {} }),
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
