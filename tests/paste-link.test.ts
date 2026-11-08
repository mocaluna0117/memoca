import { BlockNoteEditor } from "@blocknote/core";
import { TextSelection } from "prosemirror-state";
import { afterEach, describe, expect, test } from "vitest";
import { pasteLink, pastedAddress } from "@/components/editor/paste-link";

const data = (types: Record<string, string>) => ({
  types: Object.keys(types),
  getData: (type: string) => types[type] ?? "",
});

describe("what is taken for an address pasted", () => {
  test("one address alone, http or https", () => {
    expect(pastedAddress(data({ "text/plain": "https://example.com/a?b=1#c" }))).toBe(
      "https://example.com/a?b=1#c",
    );
    expect(pastedAddress(data({ "text/plain": "  http://example.com  " }))).toBe("http://example.com");
  });

  test("not text with more in it, nor another scheme, nor Memoca's own copy", () => {
    expect(pastedAddress(data({ "text/plain": "見て https://example.com" }))).toBeNull();
    expect(pastedAddress(data({ "text/plain": "https://example.com。" }))).toBeNull();
    expect(pastedAddress(data({ "text/plain": "javascript:alert(1)" }))).toBeNull();
    expect(pastedAddress(data({ "text/plain": "ftp://example.com" }))).toBeNull();
    expect(
      pastedAddress(data({ "text/plain": "https://example.com", "blocknote/html": "<p></p>" })),
    ).toBeNull();
  });

  test("a page's HTML that is the link alone is the same; with more in it, left to the ordinary paste", () => {
    expect(
      pastedAddress(
        data({ "text/plain": "https://example.com", "text/html": '<a href="https://example.com">https://example.com</a>' }),
      ),
    ).toBe("https://example.com");
    expect(
      pastedAddress(
        data({ "text/plain": "https://example.com", "text/html": "<h1>題</h1><a href='https://example.com'>https://example.com</a>" }),
      ),
    ).toBeNull();
  });
});

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

function editorWith(text: string) {
  const editor = BlockNoteEditor.create();
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  unmount = () => {
    editor.unmount();
    host.remove();
  };
  editor.replaceBlocks(editor.document, [{ type: "paragraph", content: text }]);
  return editor;
}

const paste = (text: string) =>
  ({ clipboardData: data({ "text/plain": text }) }) as unknown as ClipboardEvent;

const links = (editor: BlockNoteEditor) =>
  editor.document.flatMap((block) =>
    (block.content as { type: string; href?: string; content?: { text: string }[] }[])
      .filter((part) => part.type === "link")
      .map((part) => ({ href: part.href, text: part.content?.map((each) => each.text).join("") })),
  );

describe("an address pasted into a note", () => {
  test("with nothing selected, goes in as a link to itself", () => {
    const editor = editorWith("前 ");
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    expect(pasteLink(paste("https://example.com/x"), editor)).toBe(true);
    expect(links(editor)).toEqual([{ href: "https://example.com/x", text: "https://example.com/x" }]);
  });

  test("over text selected, makes that text the link", () => {
    const editor = editorWith("資料はこちら");
    const view = editor.prosemirrorView!;
    // 「こちら」 selected.
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6, 9)));
    expect(pasteLink(paste("https://example.com/doc"), editor)).toBe(true);
    expect(links(editor)).toEqual([{ href: "https://example.com/doc", text: "こちら" }]);
  });

  test("anything else is left to the ordinary paste", () => {
    const editor = editorWith("");
    expect(pasteLink(paste("ただの文"), editor)).toBe(false);
    expect(links(editor)).toEqual([]);
  });
});
