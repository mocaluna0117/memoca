import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { NodeSelection, TextSelection } from "prosemirror-state";
import { afterEach, describe, expect, test } from "vitest";
import { DISABLED_EXTENSIONS } from "@/components/editor/quotes";
import { SCHEMA } from "@/components/editor/schema";
import { mediaKeys } from "@/components/editor/select-media";
import { toggles } from "@/components/editor/toggles";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

const IMAGE: PartialBlock = { type: "image", props: { url: "memoca://att/0190" } };

/** An editor with Memoca's image keys, shown (its keys work only then), holding these blocks. */
function editorOf(blocks: PartialBlock[]) {
  const editor = BlockNoteEditor.create({
    schema: SCHEMA as never,
    disableExtensions: DISABLED_EXTENSIONS,
    extensions: [toggles(), mediaKeys()],
  }) as unknown as BlockNoteEditor;
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  unmount = () => {
    editor.unmount();
    host.remove();
  };
  editor.replaceBlocks(editor.document, blocks);
  return editor;
}

const outline = (editor: BlockNoteEditor): string[] => {
  const lines: string[] = [];
  const walk = (blocks: typeof editor.document, depth: number) =>
    blocks.forEach((block) => {
      const text = Array.isArray(block.content)
        ? block.content.map((part) => ("text" in part ? part.text : "")).join("")
        : "";
      lines.push(`${"  ".repeat(depth)}${block.type}:${text}`);
      walk(block.children, depth + 1);
    });
  walk(editor.document, 0);
  return lines;
};

function caret(editor: BlockNoteEditor, text: string, offset: number) {
  const view = editor.prosemirrorView!;
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isTextblock && node.textContent === text) at = pos + 1;
    return at < 0;
  });
  if (at < 0) throw new Error(`no line "${text}"`);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at + offset)));
}

function press(editor: BlockNoteEditor, key: string): boolean {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent("keydown", { key, cancelable: true });
  return view.someProp("handleKeyDown", (handle) => handle(view, event)) ?? false;
}

const selectedType = (editor: BlockNoteEditor) => {
  const { selection } = editor.prosemirrorState;
  return selection instanceof NodeSelection ? selection.node.type.name : null;
};

describe("Backspace at the start of a line under an image", () => {
  test("selects the image, and the next takes it away, the line kept", () => {
    const editor = editorOf([IMAGE, { type: "paragraph", content: "写真の説明" }]);
    caret(editor, "写真の説明", 0);
    expect(press(editor, "Backspace")).toBe(true);
    expect(outline(editor)).toEqual(["image:", "paragraph:写真の説明"]);
    expect(selectedType(editor)).toBe("image");
    expect(press(editor, "Backspace")).toBe(true);
    expect(outline(editor)).toEqual(["paragraph:写真の説明"]);
  });

  test("an empty line is BlockNote's: it goes, the image selected", () => {
    const editor = editorOf([IMAGE, { type: "paragraph", content: "" }, { type: "paragraph", content: "次" }]);
    const view = editor.prosemirrorView!;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === "paragraph") at = pos + 1;
      return at < 0;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
    press(editor, "Backspace");
    expect(outline(editor)).toEqual(["image:", "paragraph:次"]);
    expect(selectedType(editor)).toBe("image");
  });

  test("in the middle of the line, or under text: as it was", () => {
    const editor = editorOf([{ type: "paragraph", content: "上" }, { type: "paragraph", content: "下の行" }]);
    caret(editor, "下の行", 0);
    press(editor, "Backspace");
    expect(outline(editor)).toEqual(["paragraph:上下の行"]);
  });
});

describe("Delete at the end of a line before an image", () => {
  test("selects the image, and the next takes it away, the line kept", () => {
    const editor = editorOf([{ type: "heading", content: "見出し" }, IMAGE, { type: "paragraph", content: "後" }]);
    caret(editor, "見出し", 3);
    expect(press(editor, "Delete")).toBe(true);
    expect(outline(editor)).toEqual(["heading:見出し", "image:", "paragraph:後"]);
    expect(selectedType(editor)).toBe("image");
    expect(press(editor, "Delete")).toBe(true);
    expect(outline(editor)).toEqual(["heading:見出し", "paragraph:後"]);
  });

  test("an image inside the line's block, its first: selected as well", () => {
    const editor = editorOf([{ type: "paragraph", content: "親", children: [IMAGE] }]);
    caret(editor, "親", 1);
    press(editor, "Delete");
    expect(outline(editor)).toEqual(["paragraph:親", "  image:"]);
    expect(selectedType(editor)).toBe("image");
  });
});
