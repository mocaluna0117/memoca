import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { NodeSelection, TextSelection } from "prosemirror-state";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  asFile,
  asPng,
  forgetImageCopy,
  imageAlone,
  imagesAlone,
  isWebKit,
  pasteOwnImage,
  rememberImageCopy,
} from "@/components/editor/copy-image";

const IMAGE: PartialBlock = { type: "image", props: { url: "memoca://att/0190" } };
const OTHER: PartialBlock = { type: "image", props: { url: "memoca://att/0192", name: "図.jpg" } };

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

describe("images copied alone", () => {
  const endOf = (doc: ReturnType<typeof docOf>, pos: number) => pos + doc.nodeAt(pos)!.nodeSize - 1;

  test("several, with empty lines between them: each, in order", () => {
    const doc = docOf([{ type: "paragraph", content: "上" }, IMAGE, { type: "paragraph" }, OTHER]);
    const [, first, , second] = starts(doc);
    expect(imagesAlone(doc, TextSelection.create(doc, first! - 2, endOf(doc, second!)))).toEqual([
      { url: "memoca://att/0190", name: "" },
      { url: "memoca://att/0192", name: "図.jpg" },
    ]);
  });

  test("with text or a file among them: none", () => {
    const doc = docOf([
      IMAGE,
      { type: "paragraph", content: "間" },
      OTHER,
      { type: "file", props: { url: "memoca://att/0191" } },
    ]);
    const [first, , second, file] = starts(doc);
    expect(imagesAlone(doc, TextSelection.create(doc, first! + 1, endOf(doc, second!)))).toBeNull();
    expect(imagesAlone(doc, TextSelection.create(doc, second! + 1, endOf(doc, file!)))).toBeNull();
  });
});

describe("an image as a file of its own", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("named as it was added, its bytes as they are", async () => {
    vi.stubGlobal("createImageBitmap", async () => ({ width: 40, height: 30, close: () => {} }));
    const jpeg = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
    expect(await asFile(jpeg, "図.jpeg", 0)).toEqual({
      file: { name: "図.jpg", data: "AQID" },
      size: { width: 40, height: 30 },
    });
    expect((await asFile(jpeg, "", 2)).file.name).toBe("画像-3.jpg");
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

  /** A paste of image files (one by default), and whatever else is given. */
  function pasteOf(types: Record<string, string> = {}, count = 1) {
    const files = Array.from(
      { length: count },
      (_, at) => new File([new Uint8Array(4)], `image-${at}.png`, { type: "image/png" }),
    );
    return {
      clipboardData: {
        files,
        types: ["Files", ...Object.keys(types)],
        getData: (type: string) => types[type] ?? "",
      },
    } as unknown as ClipboardEvent;
  }

  test("pasted back, an image Memoca copied alone is the block it was", async () => {
    vi.stubGlobal("createImageBitmap", async () => ({ width: 40, height: 30, close: () => {} }));
    const pasteHTML = vi.fn();
    const editor = { pasteHTML } as unknown as Parameters<typeof pasteOwnImage>[1];
    rememberImageCopy({ html: "<div>block</div>", sizes: [{ width: 40, height: 30 }] });
    expect(pasteOwnImage(pasteOf(), editor)).toBe(true);
    await vi.waitFor(() => expect(pasteHTML).toHaveBeenCalledWith("<div>block</div>", true));
  });

  test("pasted back, images Memoca copied as files of their own are the blocks they were", async () => {
    const sizes = [
      { width: 40, height: 30 },
      { width: 20, height: 10 },
    ];
    let next = 0;
    // Handed over in another order than copied.
    vi.stubGlobal("createImageBitmap", async () => ({ ...sizes[1 - next++]!, close: () => {} }));
    const pasteHTML = vi.fn();
    const editor = { pasteHTML } as unknown as Parameters<typeof pasteOwnImage>[1];
    rememberImageCopy({ html: "<div>blocks</div>", sizes });
    expect(pasteOwnImage(pasteOf({}, 1), editor)).toBe(false);
    expect(pasteOwnImage(pasteOf({}, 2), editor)).toBe(true);
    await vi.waitFor(() => expect(pasteHTML).toHaveBeenCalledWith("<div>blocks</div>", true));
  });

  test("not taken on: with HTML on the clipboard too, with nothing copied, or long after", () => {
    const editor = { pasteHTML: vi.fn() } as unknown as Parameters<typeof pasteOwnImage>[1];
    expect(pasteOwnImage(pasteOf(), editor)).toBe(false);
    rememberImageCopy({ html: "<div>block</div>", sizes: [{ width: 40, height: 30 }] });
    expect(pasteOwnImage(pasteOf({ "text/html": "<img>" }), editor)).toBe(false);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    expect(pasteOwnImage(pasteOf(), editor)).toBe(false);
    vi.useRealTimers();
  });
});
