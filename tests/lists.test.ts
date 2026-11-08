import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { TextSelection } from "prosemirror-state";
import { afterEach, describe, expect, test } from "vitest";
import { japaneseLists } from "@/components/editor/japanese-lists";
import { listKeys } from "@/components/editor/list-keys";
import { DISABLED_EXTENSIONS, quoteShortcuts } from "@/components/editor/quotes";
import { SCHEMA } from "@/components/editor/schema";
import { toggles } from "@/components/editor/toggles";

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

/** An editor with Memoca's list and toggle keys, shown (its keys work only then), holding these blocks. */
function editorOf(blocks: PartialBlock[]) {
  const editor = BlockNoteEditor.create({
    schema: SCHEMA as never,
    disableExtensions: DISABLED_EXTENSIONS,
    extensions: [japaneseLists, quoteShortcuts, listKeys(), toggles()],
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

/** Each block a line: its type, text and the props it has set, indented by how deep it is. */
function outline(editor: BlockNoteEditor): string[] {
  const lines: string[] = [];
  const walk = (blocks: typeof editor.document, depth: number) =>
    blocks.forEach((block) => {
      const text = Array.isArray(block.content)
        ? block.content.map((part) => ("text" in part ? part.text : "")).join("")
        : "";
      const set = Object.entries(block.props as Record<string, unknown>)
        .filter(([, value]) => value !== "default" && value !== "left" && value !== false)
        .map(([name, value]) => ` ${name}=${String(value)}`)
        .join("");
      lines.push(`${"  ".repeat(depth)}${block.type}:${text}${set}`);
      walk(block.children, depth + 1);
    });
  walk(editor.document, 0);
  return lines;
}

/** The caret in the line of this text, `offset` in, with `length` of it selected. */
function caret(editor: BlockNoteEditor, text: string, offset = 0, length = 0) {
  const view = editor.prosemirrorView!;
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isTextblock && node.textContent === text) at = pos + 1;
    return at < 0;
  });
  if (at < 0) throw new Error(`no line "${text}"`);
  const { doc } = view.state;
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(doc, at + offset, at + offset + length)),
  );
}

/** A key pressed, as the editor takes it: whether it did, and so kept it from the browser. */
function press(editor: BlockNoteEditor, key: string, init: KeyboardEventInit = {}): boolean {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent("keydown", { key, ...init, cancelable: true });
  return view.someProp("handleKeyDown", (handle) => handle(view, event)) ?? false;
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

describe("・ typed at the start of a line", () => {
  test("makes a line of text a bullet", () => {
    const editor = editorOf([{ type: "paragraph", content: "牛乳" }]);
    caret(editor, "牛乳");
    type(editor, "・");
    expect(outline(editor)).toEqual(["bulletListItem:牛乳"]);
  });

  test("stays in a list item, a quote or a toggle, which stay as they were", () => {
    for (const [kind, props] of [
      ["bulletListItem", {}],
      ["numberedListItem", {}],
      ["checkListItem", { checked: true }],
      ["toggleListItem", {}],
      ["quote", {}],
    ] as const) {
      const editor = editorOf([{ type: kind, content: "項目", props } as PartialBlock]);
      caret(editor, "項目");
      type(editor, "・");
      expect(outline(editor)).toEqual([
        `${kind}:・項目${kind === "checkListItem" ? " checked=true" : ""}`,
      ]);
      unmount?.();
      unmount = null;
    }
  });
});

describe("- and Enter, then Backspace", () => {
  test("gives back the - alone, with no line break in its text", () => {
    const editor = editorOf([{ type: "paragraph", content: "" }]);
    caret(editor, "");
    type(editor, "-");
    press(editor, "Enter");
    expect(outline(editor)).toEqual(["bulletListItem:"]);
    press(editor, "Backspace");
    expect(outline(editor)).toEqual(["paragraph:-"]);
  });
});

describe("Enter in a list item", () => {
  test("with text selected: the selected text gone, and a new item of the same kind", () => {
    const editor = editorOf([{ type: "bulletListItem", content: "hello world" }]);
    caret(editor, "hello world", 6, 5);
    press(editor, "Enter");
    expect(outline(editor)).toEqual(["bulletListItem:hello ", "bulletListItem:"]);
  });

  test("selected across two items: one item each side, of the same kind", () => {
    const editor = editorOf([
      { type: "numberedListItem", content: "一つ目" },
      { type: "numberedListItem", content: "二つ目" },
    ]);
    const view = editor.prosemirrorView!;
    caret(editor, "一つ目", 2);
    const from = view.state.selection.from;
    caret(editor, "二つ目", 1);
    const to = view.state.selection.from;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    press(editor, "Enter");
    expect(outline(editor)).toEqual(["numberedListItem:一つ", "numberedListItem:つ目"]);
  });

  test("in its text: the colours and alignment go on into the new item, each with an id of its own", () => {
    const editor = editorOf([
      {
        type: "bulletListItem",
        content: "赤い文字",
        props: { textColor: "red", backgroundColor: "blue", textAlignment: "center" },
      },
    ]);
    caret(editor, "赤い文字", 2);
    press(editor, "Enter");
    const props = " backgroundColor=blue textColor=red textAlignment=center";
    expect(outline(editor)).toEqual([`bulletListItem:赤い${props}`, `bulletListItem:文字${props}`]);
    const [first, second] = editor.document;
    expect(second!.id).toBeTruthy();
    expect(second!.id).not.toBe(first!.id);
  });

  test("a check item's tick, and where numbers start, stay with the first", () => {
    const editor = editorOf([
      { type: "checkListItem", content: "済み", props: { checked: true } },
      { type: "numberedListItem", content: "五から", props: { start: 5 } },
    ]);
    caret(editor, "済み", 2);
    press(editor, "Enter");
    caret(editor, "五から", 3);
    press(editor, "Enter");
    expect(outline(editor)).toEqual([
      "checkListItem:済み checked=true",
      "checkListItem:",
      "numberedListItem:五から start=5",
      "numberedListItem:",
    ]);
  });

  test("an empty one is still made a line of text, as BlockNote has it", () => {
    const editor = editorOf([{ type: "bulletListItem", content: "" }]);
    caret(editor, "");
    press(editor, "Enter");
    expect(outline(editor)).toEqual(["paragraph:"]);
  });
});

describe("Tab and Shift+Tab", () => {
  test("where the line cannot go in or out a step, are kept from the browser", () => {
    const editor = editorOf([
      { type: "bulletListItem", content: "一" },
      { type: "bulletListItem", content: "二" },
    ]);
    caret(editor, "一");
    expect(press(editor, "Tab")).toBe(true);
    expect(press(editor, "Tab", { shiftKey: true })).toBe(true);
    expect(outline(editor)).toEqual(["bulletListItem:一", "bulletListItem:二"]);
  });

  test("still put an item in and out a step", () => {
    const editor = editorOf([
      { type: "bulletListItem", content: "一" },
      { type: "bulletListItem", content: "二" },
    ]);
    caret(editor, "二");
    expect(press(editor, "Tab")).toBe(true);
    expect(outline(editor)).toEqual(["bulletListItem:一", "  bulletListItem:二"]);
    expect(press(editor, "Tab", { shiftKey: true })).toBe(true);
    expect(outline(editor)).toEqual(["bulletListItem:一", "bulletListItem:二"]);
  });

  test("with text selected, are left to BlockNote (to go to the toolbar)", () => {
    const editor = editorOf([{ type: "bulletListItem", content: "一" }]);
    caret(editor, "一", 0, 1);
    expect(press(editor, "Tab")).toBe(false);
  });
});

describe("Backspace at the start of an item after a closed toggle", () => {
  test("makes it a line of text, then joins it to the toggle's own line, not to a line out of sight", () => {
    const editor = editorOf([
      { type: "toggleListItem", content: "箱", children: [{ type: "paragraph", content: "隠れ" }] },
      { type: "bulletListItem", content: "次" },
    ]);
    caret(editor, "次");
    press(editor, "Backspace");
    expect(outline(editor)).toEqual(["toggleListItem:箱", "  paragraph:隠れ", "paragraph:次"]);
    press(editor, "Backspace");
    expect(outline(editor)).toEqual(["toggleListItem:箱次", "  paragraph:隠れ"]);
  });
});

describe("what the input method makes of the list shortcuts", () => {
  test("ー, －, ＊ or ＋ and a space, half or full width, make a bullet", () => {
    for (const typed of ["ー ", "ー　", "－ ", "‐ ", "− ", "＊ ", "＋　"]) {
      const editor = editorOf([{ type: "paragraph", content: "" }]);
      caret(editor, "");
      type(editor, typed);
      expect(outline(editor), typed).toEqual(["bulletListItem:"]);
      unmount?.();
      unmount = null;
    }
  });

  test("not in the middle of a line, nor in a heading", () => {
    const editor = editorOf([{ type: "paragraph", content: "前" }]);
    caret(editor, "前", 1);
    type(editor, "ー ");
    expect(outline(editor)).toEqual(["paragraph:前ー "]);
    unmount?.();
    unmount = null;
    const heading = editorOf([{ type: "heading", content: "" }]);
    caret(heading, "");
    type(heading, "ー ");
    expect(outline(heading)[0]).toMatch(/^heading:ー /);
  });

  test("１．, 1。 or 12． and a space make a numbered list, from that number", () => {
    const cases: [string, string][] = [
      ["１． ", "numberedListItem:"],
      ["1。　", "numberedListItem:"],
      ["12．　", "numberedListItem: start=12"],
      ["５。 ", "numberedListItem: start=5"],
    ];
    for (const [typed, expected] of cases) {
      const editor = editorOf([{ type: "paragraph", content: "" }]);
      caret(editor, "");
      type(editor, typed);
      expect(outline(editor), typed).toEqual([expected]);
      unmount?.();
      unmount = null;
    }
  });

  test("１、 and ① stay as typed: they begin sentences", () => {
    for (const typed of ["１、 ", "① "]) {
      const editor = editorOf([{ type: "paragraph", content: "" }]);
      caret(editor, "");
      type(editor, typed);
      expect(outline(editor), typed).toEqual([`paragraph:${typed}`]);
      unmount?.();
      unmount = null;
    }
  });

  test("「」 and a space make a check list item; 「x」 or 「×」 one ticked", () => {
    const cases: [string, string][] = [
      ["「」 ", "checkListItem:"],
      ["「　」　", "checkListItem:"],
      ["「x」 ", "checkListItem: checked=true"],
      ["「×」　", "checkListItem: checked=true"],
    ];
    for (const [typed, expected] of cases) {
      const editor = editorOf([{ type: "paragraph", content: "" }]);
      caret(editor, "");
      type(editor, typed);
      expect(outline(editor), typed).toEqual([expected]);
      unmount?.();
      unmount = null;
    }
  });

  test("a line beginning with 「 and a space is a line, not a quote; > and a space still is", () => {
    const editor = editorOf([{ type: "paragraph", content: "" }]);
    caret(editor, "");
    type(editor, "「 ");
    expect(outline(editor)).toEqual(["paragraph:「 "]);
    unmount?.();
    unmount = null;
    const quoted = editorOf([{ type: "paragraph", content: "" }]);
    caret(quoted, "");
    type(quoted, "> ");
    expect(outline(quoted)).toEqual(["quote:"]);
  });

  test("while a word is being composed, nothing is made; once it is, it is", async () => {
    const editor = editorOf([{ type: "paragraph", content: "" }]);
    const view = editor.prosemirrorView!;
    caret(editor, "");
    type(editor, "ー");
    view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    type(editor, "　");
    expect(outline(editor)).toEqual(["paragraph:ー　"]);
    view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "　" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(outline(editor)).toEqual(["bulletListItem:"]);
  });
});

describe("Enter at the start of a list item with text", () => {
  test("puts the empty item above, and the tick stays with the text", () => {
    const editor = editorOf([{ type: "checkListItem", content: "済み", props: { checked: true } }]);
    caret(editor, "済み", 0);
    expect(press(editor, "Enter")).toBe(true);
    expect(outline(editor)).toEqual(["checkListItem:", "checkListItem:済み checked=true"]);
    type(editor, "次");
    expect(outline(editor)).toEqual(["checkListItem:", "checkListItem:次済み checked=true"]);
  });

  test("and where the numbers start stays with the text", () => {
    const editor = editorOf([{ type: "numberedListItem", content: "五から", props: { start: 5 } }]);
    caret(editor, "五から", 0);
    expect(press(editor, "Enter")).toBe(true);
    expect(outline(editor)).toEqual(["numberedListItem:", "numberedListItem:五から start=5"]);
  });
});

describe("Backspace at the start of a closed toggle's own line", () => {
  test("opens it, instead of making it a line and bringing what was inside out", () => {
    const editor = editorOf([
      { type: "toggleListItem", content: "箱", children: [{ type: "paragraph", content: "隠れ" }] },
    ]);
    const wrapper = () =>
      editor.prosemirrorView!.dom.querySelector(".bn-toggle-wrapper")?.getAttribute("data-show-children");
    expect(wrapper()).toBe("false");
    caret(editor, "箱", 0);
    expect(press(editor, "Backspace")).toBe(true);
    expect(outline(editor)).toEqual(["toggleListItem:箱", "  paragraph:隠れ"]);
    expect(wrapper()).toBe("true");
  });

  test("one with nothing inside is left to BlockNote, as a list item's is", () => {
    const editor = editorOf([{ type: "toggleListItem", content: "空" }]);
    caret(editor, "空", 0);
    press(editor, "Backspace");
    expect(outline(editor)).toEqual(["paragraph:空"]);
  });
});
