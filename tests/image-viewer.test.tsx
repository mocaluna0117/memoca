import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteContext } from "@blocknote/react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ listeners: new Set<(unlocked: boolean) => void>() }));
vi.mock("@/lib/crypto/vault", () => ({
  vault: {
    subscribe: (listener: (unlocked: boolean) => void) => {
      h.listeners.add(listener);
      return () => h.listeners.delete(listener);
    },
  },
}));

import {
  DOUBLE_TAP_MS,
  ImageViewer,
  ImageViewerOnDoubleClick,
  type Tap,
  imageBlockAt,
  isDoubleTap,
} from "@/components/editor/image-viewer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  h.listeners.clear();
  vi.restoreAllMocks();
});

beforeEach(() => {
  // A computer's: back to the note, once closed (see returnFocus). jsdom has none.
  window.matchMedia = (query: string) =>
    ({ matches: query === "(pointer: fine)" }) as MediaQueryList;
});

/** A note of a line, an image with a caption, and another line, on the page. */
function mountNote() {
  const editor = BlockNoteEditor.create();
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  editor.replaceBlocks(editor.document, [
    { type: "paragraph", content: "前の行" },
    {
      type: "image",
      props: { url: "https://example.com/photo.png", name: "景色.png", caption: "海の写真" },
    },
    { type: "paragraph", content: "後の行" },
  ]);
  cleanups.push(() => {
    editor.unmount();
    host.remove();
  });
  const imageId = editor.document[1]!.id;
  const block = host.querySelector<HTMLElement>(`[data-id="${imageId}"]`)!;
  return {
    editor,
    host,
    imageId,
    picture: block.querySelector<HTMLImageElement>("img.bn-visual-media")!,
    caption: block.querySelector<HTMLElement>("figcaption")!,
    handle: block.querySelector<HTMLElement>(".bn-resize-handle")!,
    line: host.querySelector<HTMLElement>('[data-content-type="paragraph"] .bn-inline-content')!,
  };
}

function render(element: React.ReactElement): Root {
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  act(() => root.render(element));
  cleanups.push(() => {
    act(() => root.unmount());
    box.remove();
  });
  return root;
}

/** Lets the promises the viewer waits on (the URL looked up) settle. */
const settle = () => act(async () => {});

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const button = (name: string) =>
  document.querySelector<HTMLButtonElement>(`[role="dialog"] button[aria-label="${name}"]`);

describe("what a double-click on the note opens", () => {
  test("the picture of an image block, by its block", () => {
    const { host, imageId, picture } = mountNote();
    expect(imageBlockAt(picture, host)).toBe(imageId);
  });

  test("not its caption, its resize handles, nor text", () => {
    const { host, caption, handle, line } = mountNote();
    expect(caption.textContent).toBe("海の写真");
    expect(imageBlockAt(caption, host)).toBeNull();
    expect(handle).not.toBeNull();
    expect(imageBlockAt(handle, host)).toBeNull();
    expect(imageBlockAt(line, host)).toBeNull();
    expect(imageBlockAt(line.firstChild, host)).toBeNull();
    expect(imageBlockAt(null, host)).toBeNull();
  });

  test("not the preview of an image still being added, nor an image of another editor", () => {
    const { host, picture } = mountNote();
    const preview = document.createElement("img");
    preview.className = "memoca-upload-preview";
    picture.closest(".bn-file-block-content-wrapper")!.append(preview);
    expect(imageBlockAt(preview, host)).toBeNull();
    const elsewhere = document.createElement("div");
    expect(imageBlockAt(picture, elsewhere)).toBeNull();
    expect(imageBlockAt(picture, null)).toBeNull();
  });
});

describe("a double tap", () => {
  const tap = (over: Partial<Tap> = {}): Tap => ({
    blockId: "a",
    at: 1000,
    x: 100,
    y: 100,
    ...over,
  });

  test("is a second tap on the same image, soon after the first, near it", () => {
    expect(isDoubleTap(tap(), tap({ at: 1000 + DOUBLE_TAP_MS }))).toBe(true);
    expect(isDoubleTap(tap(), tap({ at: 1200, x: 120, y: 110 }))).toBe(true);
  });

  test("is not a first tap, one too late, one far off, or one on another image", () => {
    expect(isDoubleTap(null, tap())).toBe(false);
    expect(isDoubleTap(tap(), tap({ at: 1001 + DOUBLE_TAP_MS }))).toBe(false);
    expect(isDoubleTap(tap(), tap({ at: 1100, x: 200 }))).toBe(false);
    expect(isDoubleTap(tap(), tap({ at: 1100, blockId: "b" }))).toBe(false);
    expect(isDoubleTap(tap(), tap({ at: 900 }))).toBe(false);
  });
});

describe("the viewer", () => {
  function open(over: Partial<React.ComponentProps<typeof ImageViewer>> = {}) {
    const props = {
      url: "memoca://att/one",
      name: "景色.png",
      locked: false,
      resolve: vi.fn(async () => "blob:http://localhost/one"),
      onClose: vi.fn(),
      onDownload: vi.fn(),
      returnFocus: vi.fn(() => true),
      ...over,
    };
    render(<ImageViewer {...props} />);
    return props;
  }

  test("shows the image the URL is looked up as, titled by its name, the focus on 閉じる", async () => {
    const props = open();
    await settle();
    expect(props.resolve).toHaveBeenCalledWith("memoca://att/one");
    expect(dialog()?.getAttribute("aria-labelledby")).toBeTruthy();
    const title = document.getElementById(dialog()!.getAttribute("aria-labelledby")!);
    expect(title?.textContent).toBe("景色.png");
    const picture = dialog()!.querySelector("img")!;
    expect(picture.getAttribute("src")).toBe("blob:http://localhost/one");
    expect(picture.getAttribute("alt")).toBe("景色.png");
    expect(document.activeElement).toBe(button("閉じる"));
  });

  test("an image with no name is called 画像", async () => {
    open({ name: "" });
    await settle();
    expect(dialog()!.querySelector("img")!.getAttribute("alt")).toBe("画像");
  });

  test("closes with ×, Esc, or a click beside the image, not on it", async () => {
    const props = open();
    await settle();
    act(() => dialog()!.querySelector("img")!.click());
    expect(props.onClose).not.toHaveBeenCalled();
    act(() => dialog()!.querySelector<HTMLElement>("[data-image-viewer-stage]")!.click());
    expect(props.onClose).toHaveBeenCalledTimes(1);
    act(() => button("閉じる")!.click());
    expect(props.onClose).toHaveBeenCalledTimes(2);
    act(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(props.onClose).toHaveBeenCalledTimes(3);
  });

  test("ダウンロード saves the file", async () => {
    const props = open();
    await settle();
    act(() => button("ダウンロード")!.click());
    expect(props.onDownload).toHaveBeenCalledTimes(1);
  });

  test("one that cannot be looked up says so, and offers nothing to save", async () => {
    open({ resolve: async (url) => url });
    await settle();
    expect(dialog()!.querySelector("img")).toBeNull();
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toContain(
      "この画像はいま表示できません",
    );
    expect(button("ダウンロード")!.disabled).toBe(true);
  });

  test("goes when the vault closes, shown from a URL of this tab's, or in a locked note", async () => {
    const fromTab = open();
    await settle();
    act(() => h.listeners.forEach((listener) => listener(false)));
    expect(fromTab.onClose).toHaveBeenCalled();
  });

  test("an image from a server in a note not locked stays as the vault closes", async () => {
    const fromServer = open({ resolve: async () => "https://example.com/photo.png" });
    await settle();
    act(() => h.listeners.forEach((listener) => listener(true)));
    act(() => h.listeners.forEach((listener) => listener(false)));
    expect(fromServer.onClose).not.toHaveBeenCalled();
  });

  test("in a locked note, goes as the vault closes whatever it is shown from", async () => {
    const locked = open({ locked: true, resolve: async () => "https://example.com/photo.png" });
    await settle();
    act(() => h.listeners.forEach((listener) => listener(false)));
    expect(locked.onClose).toHaveBeenCalled();
  });
});

describe("in the note", () => {
  function setUp(options: { editable?: boolean } = {}) {
    const note = mountNote();
    if (options.editable === false) note.editor.isEditable = false;
    const resolveFileUrl = vi.fn(async (url: string) => url);
    (note.editor as unknown as { resolveFileUrl: typeof resolveFileUrl }).resolveFileUrl =
      resolveFileUrl;
    render(
      <BlockNoteContext.Provider value={{ editor: note.editor }}>
        <ImageViewerOnDoubleClick locked={false} />
      </BlockNoteContext.Provider>,
    );
    return { ...note, resolveFileUrl };
  }

  const fire = (
    target: Element,
    type: string,
    init: MouseEventInit & { pointerType?: string } = {},
  ) =>
    act(() => {
      const event =
        type === "pointerdown"
          ? new PointerEvent(type, { bubbles: true, cancelable: true, ...init })
          : new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
    });

  test("an image double-clicked opens, from the URL BlockNote shows it from", async () => {
    const { picture, resolveFileUrl } = setUp();
    fire(picture, "dblclick", { button: 0 });
    await settle();
    expect(dialog()).not.toBeNull();
    expect(resolveFileUrl).toHaveBeenCalledWith("https://example.com/photo.png");
    expect(dialog()!.querySelector("img")!.getAttribute("src")).toBe(
      "https://example.com/photo.png",
    );
  });

  test("in a note that cannot be changed too", async () => {
    const { picture } = setUp({ editable: false });
    fire(picture, "dblclick", { button: 0 });
    await settle();
    expect(dialog()).not.toBeNull();
  });

  test("a double-click on text, the caption or a handle opens nothing", async () => {
    const { caption, handle, line } = setUp();
    fire(line, "dblclick", { button: 0 });
    fire(caption, "dblclick", { button: 0 });
    fire(handle, "dblclick", { button: 0 });
    await settle();
    expect(dialog()).toBeNull();
  });

  test("one click opens nothing", async () => {
    const { picture } = setUp();
    fire(picture, "pointerdown", { pointerType: "mouse" });
    fire(picture, "click");
    await settle();
    expect(dialog()).toBeNull();
  });

  test("two taps of a finger open it; one does not, nor does the double-click the browser may add", async () => {
    const { picture } = setUp();
    fire(picture, "pointerdown", { pointerType: "touch" });
    fire(picture, "click", { clientX: 50, clientY: 50 });
    await settle();
    expect(dialog()).toBeNull();
    fire(picture, "dblclick", { button: 0 });
    await settle();
    expect(dialog()).toBeNull();
    fire(picture, "pointerdown", { pointerType: "touch" });
    fire(picture, "click", { clientX: 52, clientY: 51 });
    await settle();
    expect(dialog()).not.toBeNull();
  });

  test("closed, the focus goes back to the note", async () => {
    const { editor, picture } = setUp();
    const focus = vi.spyOn(editor, "focus");
    fire(picture, "dblclick", { button: 0 });
    await settle();
    act(() => button("閉じる")!.click());
    await settle();
    expect(dialog()).toBeNull();
    // Radix gives the focus back a moment after the dialog has gone.
    await vi.waitFor(() => expect(focus).toHaveBeenCalled());
  });
});
