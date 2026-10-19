import type { BlockNoteEditor } from "@blocknote/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { showUploadPreview } from "@/components/editor/upload-preview";

/**
 * An editor's DOM with one image block in it, as BlockNote has it from an
 * upload's start: the block's content, its file wrapper, and the words
 * "Loading..." in the box the add-file button was in.
 */
function editorWith(blockId: string): { editor: BlockNoteEditor; loading: HTMLElement } {
  const root = document.createElement("div");
  root.innerHTML =
    `<div class="bn-block-content" data-content-type="image" data-file-block="" data-id="${blockId}">` +
    '<div class="bn-file-block-content-wrapper">' +
    '<div class="bn-file-loading-preview">Loading...</div>' +
    "</div></div>";
  document.body.append(root);
  return {
    editor: { domElement: root } as unknown as BlockNoteEditor,
    loading: root.querySelector<HTMLElement>(".bn-file-loading-preview")!,
  };
}

const file = (type: string) => new File([new Uint8Array(4)], "a", { type });

/** jsdom has no object URLs: these stand in, and say what was made and let go. */
const created = vi.fn(() => "blob:memoca/preview");
const revoked = vi.fn();

beforeEach(() => {
  Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked });
});

afterEach(() => {
  vi.useRealTimers();
  created.mockClear();
  revoked.mockClear();
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
  document.body.replaceChildren();
});

describe("an image being added, shown at once", () => {
  test("a PNG is shown from the file itself, dimmed, with a word on what is going on", () => {
    const { editor, loading } = editorWith("b1");
    const png = file("image/png");
    showUploadPreview(editor, "b1", png);
    expect(created).toHaveBeenCalledWith(png);
    const image = loading.querySelector("img.memoca-upload-preview")!;
    expect(image.getAttribute("src")).toBe("blob:memoca/preview");
    expect(image.getAttribute("alt")).toBe("");
    expect(image.getAttribute("draggable")).toBe("false");
    expect(image.getAttribute("contenteditable")).toBe("false");
    expect(loading.querySelector(".memoca-upload-preview-label")?.textContent).toBe("処理中…");
    expect(loading.textContent).not.toContain("Loading...");
  });

  test("not a PDF, not an SVG (never shown as an image), and not where no block is loading", () => {
    const { editor, loading } = editorWith("b1");
    const tried: [string | undefined, string][] = [
      ["b1", "application/pdf"],
      ["b1", "image/svg+xml"],
      ["b1", ""],
      ["other", "image/png"],
      [undefined, "image/png"],
    ];
    for (const [id, type] of tried) showUploadPreview(editor, id, file(type))();
    showUploadPreview(null, "b1", file("image/png"))();
    showUploadPreview({} as BlockNoteEditor, "b1", file("image/png"))();
    expect(created).not.toHaveBeenCalled();
    expect(loading.innerHTML).toBe("Loading...");
  });

  test("the URL is let go a moment after the upload is over, once the block has been drawn again", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { editor } = editorWith("b1");
    const release = showUploadPreview(editor, "b1", file("image/jpeg"));
    vi.advanceTimersByTime(10_000);
    expect(revoked).not.toHaveBeenCalled();
    release();
    vi.advanceTimersByTime(1_999);
    expect(revoked).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revoked).toHaveBeenCalledWith("blob:memoca/preview");
  });

  test("one this browser cannot show after all (a HEIC photo in Chrome) has the words back", () => {
    const { editor, loading } = editorWith("b1");
    showUploadPreview(editor, "b1", file("image/heic"));
    loading.querySelector("img")!.dispatchEvent(new Event("error"));
    expect(loading.querySelector("img")).toBeNull();
    expect(loading.textContent).toBe("Loading...");
  });
});
