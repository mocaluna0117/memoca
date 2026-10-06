import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment, yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { TextSelection } from "prosemirror-state";
import { afterEach, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { SCHEMA } from "@/components/editor/schema";
import { bodyFragment } from "@/lib/sync/ydoc";

type Editor = BlockNoteEditor<
  typeof SCHEMA.blockSchema,
  typeof SCHEMA.inlineContentSchema,
  typeof SCHEMA.styleSchema
>;

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

/** A note on the screen, with Memoca's schema, holding a line of this text, all of it selected. */
function noteOf(text: string): Editor {
  const editor = BlockNoteEditor.create({ schema: SCHEMA });
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  unmount = () => {
    editor.unmount();
    host.remove();
  };
  editor.replaceBlocks(editor.document, [{ type: "paragraph", content: text }]);
  // The line's text: inside the note's group, its block and its paragraph.
  const view = editor.prosemirrorView!;
  const start = 3;
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, start, start + text.length)),
  );
  return editor;
}

/** The size each piece of the first line's text has. */
const sizes = (editor: Editor) =>
  (editor.document[0]!.content as { text: string; styles: { fontSize?: string } }[]).map(
    ({ text, styles }) => [text, styles.fontSize ?? null],
  );

describe("文字の大きさ", () => {
  test("makes the text selected larger, drawn so, and back to the size it was", () => {
    const editor = noteOf("大きくする");
    editor.addStyles({ fontSize: "1.25em" });
    expect(sizes(editor)).toEqual([["大きくする", "1.25em"]]);
    const drawn = editor.domElement!.querySelector<HTMLElement>('[data-style-type="fontSize"]');
    expect(drawn?.style.fontSize).toBe("1.25em");

    editor.removeStyles({ fontSize: "" });
    expect(sizes(editor)).toEqual([["大きくする", null]]);
  });

  test("goes to other devices and comes back, as part of the note", () => {
    const editor = noteOf("残る大きさ");
    editor.addStyles({ fontSize: "0.8em" });
    const doc = new Y.Doc();
    blocksToYXmlFragment(editor, editor.document, bodyFragment(doc));
    const back = yXmlFragmentToBlocks(editor, bodyFragment(doc));
    expect((back[0]!.content as { styles: { fontSize?: string } }[])[0]!.styles.fontSize).toBe(
      "0.8em",
    );
  });

  test("a size not among those offered is not drawn", () => {
    const editor = noteOf("おかしな値");
    editor.addStyles({ fontSize: "999px" });
    const drawn = editor.domElement!.querySelector<HTMLElement>('[data-style-type="fontSize"]');
    expect(drawn?.style.fontSize).toBe("");
  });

  test("text pasted from elsewhere keeps the size of the note's text, whatever size it had there", async () => {
    const editor = noteOf("");
    const blocks = await editor.tryParseHTMLToBlocks(
      '<p><span style="font-size: 32px">よそのページの文字</span></p>',
    );
    expect((blocks[0]!.content as { styles: object }[])[0]!.styles).toEqual({});
  });
});
