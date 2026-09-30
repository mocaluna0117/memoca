import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { NodeSelection, TextSelection } from "prosemirror-state";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  asPng,
  forgetImageCopy,
  imageAlone,
  isWebKit,
  pasteOwnImage,
  rememberImageCopy,
} from "@/components/editor/copy-image";

const IMAGE: PartialBlock = { type: "image", props: { url: "memoca://att/0190" } };

function docOf(blocks: PartialBlock[]) {
  const editor = BlockNoteEditor.create();
  editor.replaceBlocks(editor.document, blocks);
  return editor.prosemirrorState.doc;
}

/** Where each top-level block starts, in order. */
const starts = (doc: ReturnType<typeof docOf>) => {
  const found: number[] = [];
  let pos = 1;
  doc.firstChild!.forEach((block) => {
    found.push(pos);
    pos += block.nodeSize;
  });
  return found;
};

describe("an image copied alone", () => {
  test("selected by a click: its url", () => {
    const doc = docOf([{ type: "paragraph", content: "上" }, IMAGE]);
    const [, image] = starts(doc);
    expect(imageAlone(doc, NodeSelection.create(doc, image!))).toBe("memoca://att/0190");
    expect(imageAlone(doc, NodeSelection.create(doc, image! + 1))).toBe("memoca://att/0190");
  });

  test("selected from the end of the line before it, with no text: its url", () => {
    const doc = docOf([{ type: "paragraph", content: "上" }, IMAGE]);
    const [, image] = starts(doc);
    const end = image! + doc.nodeAt(image!)!.nodeSize - 1;
    // From the end of 上 (inside its block, after its text) to past the image.
    const selection = TextSelection.create(doc, image! - 2, end);
    expect(imageAlone(doc, selection)).toBe("memoca://att/0190");
  });

  test("with text, with another image, or a file: none", () => {
    const doc = docOf([
      { type: "paragraph", content: "上" },
      IMAGE,
      IMAGE,
      { type: "file", props: { url: "memoca://att/0191" } },
    ]);
    const [text, first, second, file] = starts(doc);
    const endOf = (pos: number) => pos + doc.nodeAt(pos)!.nodeSize - 1;
    expect(imageAlone(doc, TextSelection.create(doc, text! + 2, endOf(first!)))).toBeNull();
    expect(imageAlone(doc, TextSelection.create(doc, first! + 1, endOf(second!)))).toBeNull();
    expect(imageAlone(doc, NodeSelection.create(doc, file!))).toBeNull();
    expect(imageAlone(doc, TextSelection.create(doc, text! + 2))).toBeNull();
  });
});

describe("the image put on the clipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    forgetImageCopy();
  });

  test("a PNG is put there as it is, with its size", async () => {
    vi.stubGlobal("createImageBitmap", async () => ({ width: 40, height: 30, close: () => {} }));
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    expect(await asPng(png)).toEqual({ png, width: 40, height: 30 });
  });

  test("WebKit is told from Chrome, on a Mac and on an iPhone", () => {
    const safari =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
    const chrome =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
    const iphoneChrome =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1";
    expect(isWebKit(safari)).toBe(true);
    expect(isWebKit(iphoneChrome)).toBe(true);
    expect(isWebKit(chrome)).toBe(false);
  });

  /** A paste of one image file, and whatever else is given. */
  function pasteOf(types: Record<string, string> = {}) {
    const file = new File([new Uint8Array(4)], "image.png", { type: "image/png" });
    return {
      clipboardData: {
        files: [file],
        types: ["Files", ...Object.keys(types)],
        getData: (type: string) => types[type] ?? "",
      },
    } as unknown as ClipboardEvent;
  }

  test("pasted back, an image Memoca copied alone is the block it was", async () => {
    vi.stubGlobal("createImageBitmap", async () => ({ width: 40, height: 30, close: () => {} }));
    const pasteHTML = vi.fn();
    const editor = { pasteHTML } as unknown as Parameters<typeof pasteOwnImage>[1];
    rememberImageCopy({ html: "<div>block</div>", width: 40, height: 30 });
    expect(pasteOwnImage(pasteOf(), editor)).toBe(true);
    await vi.waitFor(() => expect(pasteHTML).toHaveBeenCalledWith("<div>block</div>", true));
  });

  test("not taken on: with HTML on the clipboard too, with nothing copied, or long after", () => {
    const editor = { pasteHTML: vi.fn() } as unknown as Parameters<typeof pasteOwnImage>[1];
    expect(pasteOwnImage(pasteOf(), editor)).toBe(false);
    rememberImageCopy({ html: "<div>block</div>", width: 40, height: 30 });
    expect(pasteOwnImage(pasteOf({ "text/html": "<img>" }), editor)).toBe(false);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    expect(pasteOwnImage(pasteOf(), editor)).toBe(false);
    vi.useRealTimers();
  });
});
