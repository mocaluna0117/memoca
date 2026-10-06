import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { bodyFragment } from "@/lib/sync/ydoc";

const h = vi.hoisted(() => ({ doc: null as unknown }));
vi.mock("@/lib/db", () => ({
  db: () => ({ notes: { get: async () => ({ preview: "見出し" }) } }),
}));
vi.mock("@/lib/sync/docs", () => ({
  withStoredDoc: async (_id: string, read: (doc: unknown) => unknown) => read(h.doc),
  acquireDoc: vi.fn(),
  releaseDoc: vi.fn(),
}));
vi.mock("@/lib/sync/mutations", () => ({
  TEMPLATES_FOLDER_ID: "templates",
  createNote: vi.fn(),
  ensureTemplatesFolder: vi.fn(),
  renameNote: vi.fn(),
}));

const { insertTemplate } = await import("@/lib/templates");
const { SCHEMA } = await import("@/components/editor/schema");

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

/** A note open on the screen, holding these blocks, the caret in the one at `caretAt`. */
function noteOf(blocks: PartialBlock[], caretAt: number) {
  const editor = BlockNoteEditor.create({ schema: SCHEMA as never }) as unknown as BlockNoteEditor;
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  unmount = () => {
    editor.unmount();
    host.remove();
  };
  editor.replaceBlocks(editor.document, blocks);
  editor.setTextCursorPosition(editor.document[caretAt]!, "end");
  return editor;
}

/** A template whose body is these blocks. */
function templateOf(blocks: PartialBlock[]) {
  const doc = new Y.Doc();
  // As the editor writes it: with ids, which a block given to it has none of yet.
  const editor = BlockNoteEditor.create({ schema: SCHEMA as never }) as unknown as BlockNoteEditor;
  editor.replaceBlocks(editor.document, blocks);
  blocksToYXmlFragment(editor, editor.document, bodyFragment(doc));
  h.doc = doc;
}

const types = (editor: BlockNoteEditor) => editor.document.map((block) => block.type);

describe("a template put into a note from the / menu", () => {
  test("takes the place of the empty line it is put in, a list item's too", async () => {
    templateOf([
      { type: "heading", content: "見出し" },
      { type: "paragraph", content: "本文" },
    ]);
    for (const kind of ["paragraph", "bulletListItem", "numberedListItem", "checkListItem"]) {
      const editor = noteOf(
        [{ type: "paragraph", content: "前" }, { type: kind } as PartialBlock],
        1,
      );
      await insertTemplate(editor as never, "t");
      expect(types(editor)).toEqual(["paragraph", "heading", "paragraph"]);
      unmount?.();
      unmount = null;
    }
  });

  test("goes after a line with text in it", async () => {
    templateOf([{ type: "paragraph", content: "本文" }]);
    const editor = noteOf([{ type: "bulletListItem", content: "項目" }], 0);
    await insertTemplate(editor as never, "t");
    expect(types(editor)).toEqual(["bulletListItem", "paragraph"]);
  });
});
