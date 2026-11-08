import { BlockNoteEditor } from "@blocknote/core";
import { afterEach, expect, test, vi } from "vitest";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

/**
 * Files pasted, as the browser hands them to the page: readable while the
 * paste event is being handled, and gone (the list empty) once it has been,
 * which the first upload awaited is.
 */
function pasted(files: File[], emptiedBy: () => boolean) {
  const items = {
    get length() {
      return emptiedBy() ? 0 : files.length;
    },
  } as unknown as DataTransferItemList & Record<number, DataTransferItem>;
  files.forEach((file, index) => {
    items[index] = { type: file.type, getAsFile: () => file } as unknown as DataTransferItem;
  });
  return {
    type: "paste",
    clipboardData: { types: ["Files"], items, getData: () => "" },
    preventDefault: () => {},
  } as unknown as ClipboardEvent;
}

test("every file pasted goes in, not only the first, and one turned away does not stop the rest", async () => {
  let uploads = 0;
  const uploadFile = vi.fn(async (file: File) => {
    uploads += 1;
    if (file.name.endsWith(".docx")) throw new Error("unsupported");
    return `memoca://${file.name}`;
  });
  const editor = BlockNoteEditor.create({ uploadFile });
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  unmount = () => {
    editor.unmount();
    host.remove();
  };
  const files = [
    new File([new Uint8Array(4)], "a.png", { type: "image/png" }),
    new File([new Uint8Array(4)], "資料.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
    new File([new Uint8Array(4)], "b.png", { type: "image/png" }),
  ];
  const view = editor.prosemirrorView!;
  // As the browser hands the paste to BlockNote's plugin.
  view.someProp("handleDOMEvents", (handlers) =>
    handlers.paste?.(view, pasted(files, () => uploads > 0)),
  );
  await vi.waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(3));
  await vi.waitFor(() => {
    const urls = editor.document
      .map((block) => (block.props as { url?: string }).url)
      .filter((url) => url);
    expect(urls).toEqual(["memoca://a.png", "memoca://b.png"]);
  });
});
