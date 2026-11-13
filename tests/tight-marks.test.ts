import { BlockNoteEditor } from "@blocknote/core";
import { afterEach, describe, expect, test } from "vitest";
import { SCHEMA } from "@/components/editor/schema";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

function emptyEditor() {
  const editor = BlockNoteEditor.create({ schema: SCHEMA as never }) as unknown as BlockNoteEditor;
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  unmount = () => {
    editor.unmount();
    host.remove();
  };
  return editor;
}

/** Text typed, a character at a time, as the editor takes it (its input rules among it). */
function type(editor: BlockNoteEditor, text: string) {
  const view = editor.prosemirrorView!;
  for (const char of text) {
    const { from, to } = view.state.selection;
    const insert = () => view.state.tr.insertText(char, from, to);
    if (!view.someProp("handleTextInput", (handle) => handle(view, from, to, char, insert))) {
      view.dispatch(insert());
    }
  }
}

/** The first line: each run of its text, with the styles it has. */
function runs(editor: BlockNoteEditor): string[] {
  const content = editor.document[0]!.content as { text: string; styles: Record<string, unknown> }[];
  return content.map((part) => {
    const styles = Object.keys(part.styles).sort().join("+");
    return styles ? `${styles}:${part.text}` : part.text;
  });
}

describe("bold, italic and strike as typed", () => {
  test("with text right inside the signs: made, the signs gone", () => {
    for (const [typed, made] of [
      ["**太字** あと", ["bold:太字", " あと"]],
      ["*斜体* あと", ["italic:斜体", " あと"]],
      ["_斜体_ あと", ["italic:斜体", " あと"]],
      ["~~消す~~ あと", ["strike:消す", " あと"]],
      ["これは **とても 重要** です", ["これは ", "bold:とても 重要", " です"]],
    ] as const) {
      const editor = emptyEditor();
      type(editor, typed);
      expect(runs(editor), typed).toEqual(made);
      unmount?.();
      unmount = null;
    }
  });

  test("with a space inside a sign: text as typed, every sign kept", () => {
    for (const typed of [
      "2 * 3 * 4 = 24",
      "ls *.txt *.md",
      "SELECT * FROM a; SELECT * FROM b",
      "a _ b _ c",
      "幅 * 高さ * 奥行き",
      "** 見出しではない ** 文",
      "10 ~~ 20 ~~ 30",
      "＊ではなく * と　* の間",
    ]) {
      const editor = emptyEditor();
      type(editor, typed);
      expect(runs(editor), typed).toEqual([typed]);
      unmount?.();
      unmount = null;
    }
  });
});

describe("pasted", () => {
  test("signs with spaces inside them are kept; text right inside them is still styled", () => {
    // jsdom has no ClipboardEvent, which ProseMirror's paste makes one of.
    if (typeof ClipboardEvent === "undefined") {
      (globalThis as { ClipboardEvent?: unknown }).ClipboardEvent = class extends Event {
        clipboardData = null;
      };
    }
    const editor = emptyEditor();
    editor.pasteHTML("<p>2 * 3 * 4 = 24 と a _ b _ c と ls *.txt *.md</p>");
    expect(runs(editor)).toEqual(["2 * 3 * 4 = 24 と a _ b _ c と ls *.txt *.md"]);

    const styled = emptyEditor();
    styled.pasteHTML("<p>これは **重要** です</p>");
    expect(runs(styled)).toEqual(["これは ", "bold:重要", " です"]);
  });
});
