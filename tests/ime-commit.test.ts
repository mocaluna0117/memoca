import { BlockNoteEditor } from "@blocknote/core";
import { TextSelection } from "prosemirror-state";
import { describe, expect, test } from "vitest";
import type { EditorView } from "prosemirror-view";
import * as Y from "yjs";
import {
  caretKeptForComposition,
  composedTakenOut,
  imeCommit,
  settleWord,
  strayLine,
} from "@/components/editor/ime-commit";
import { todoDue } from "@/components/editor/todo-due";
import { DUE_MAP } from "@/lib/quick/todo-due";

const line = (id: string, children: unknown[] = []) => ({ id, content: [], children });
/** Lines there before the composition started: none but "a". */
const before = (id: string) => id === "a";

describe("a line a commit from the input method left the caret in", () => {
  test("goes, its word kept in the line it was written in", () => {
    expect(strayLine("a", line("b"), line("a"), before)).toEqual({ keep: "a", drop: "b" });
  });

  test("is left alone when the caret stayed where the word was written", () => {
    expect(strayLine("a", line("a"), line("x"), before)).toBeNull();
  });

  test("is left alone unless it is right after that line, with nothing under it", () => {
    expect(strayLine("a", line("b"), line("c"), before)).toBeNull();
    expect(strayLine("a", line("b"), undefined, before)).toBeNull();
    expect(strayLine("a", line("b", [line("c")]), line("a"), before)).toBeNull();
    expect(strayLine(null, line("b"), line("a"), before)).toBeNull();
  });

  test("is left alone when it was there before the composition started", () => {
    expect(strayLine("a", line("b"), line("a"), (id) => id === "a" || id === "b")).toBeNull();
  });
});

describe("a stray line, put right", () => {
  test("goes alone when the line the word was written in has the word already", () => {
    // ・ committed in a toggle's only line: in both, as the input method's record had it.
    expect(settleWord({ keep: "・", now: "・", word: "・", composed: "・" })).toBe("drop");
    // The input rules, or anything, having taken it from the stray line.
    expect(settleWord({ keep: "・", now: "", word: "・", composed: "・" })).toBe("drop");
  });

  test("gives its word to the line it was written in when that has none of it", () => {
    expect(settleWord({ keep: "", now: "日本", word: "日本", composed: "にほん" })).toBe("move");
    // Still what was being composed, and the word chosen in the stray line.
    expect(settleWord({ keep: "にほん", now: "日本", word: "日本", composed: "にほん" })).toBe(
      "move",
    );
  });

  test("takes what was being composed away with it when the composition was given up", () => {
    expect(settleWord({ keep: "・", now: "", word: "", composed: "・" })).toBe("move");
    expect(settleWord({ keep: "", now: "", word: "", composed: "・" })).toBe("drop");
  });

  test("is left as it is when either line has anything else", () => {
    // Text of the person's own in the line the word was written in.
    expect(settleWord({ keep: "買い物", now: "・", word: "・", composed: "・" })).toBeNull();
    expect(settleWord({ keep: "買い物", now: "", word: "", composed: "・" })).toBeNull();
    // Something in the stray line besides the word.
    expect(settleWord({ keep: "", now: "メモ", word: "・", composed: "・" })).toBeNull();
    // The word nowhere.
    expect(settleWord({ keep: "にほん", now: "", word: "日本", composed: "にほん" })).toBeNull();
  });
});

describe("ProseMirror's Enter for the line WebKit took out, committing a word", () => {
  /** A bullet holding `text`, `from` to `to` of it selected; what composedTakenOut makes of it. */
  function takenOut(text: string, composed: string, from: number, to = from) {
    const editor = BlockNoteEditor.create();
    editor.replaceBlocks(editor.document, [{ type: "bulletListItem", content: text }]);
    let start = -1;
    editor.prosemirrorState.doc.descendants((node, pos) => {
      if (start < 0 && node.isTextblock) start = pos + 1;
      return start < 0;
    });
    const before = editor.prosemirrorState.apply(
      editor.prosemirrorState.tr.setSelection(
        TextSelection.create(editor.prosemirrorState.doc, start + from, start + to),
      ),
    );
    const tr = composedTakenOut(before, composed);
    if (!tr) return null;
    const after = before.apply(tr);
    return {
      text: after.selection.$from.parent.textContent,
      caret: after.selection.empty ? after.selection.$from.parentOffset : -1,
      lines: after.doc.firstChild!.childCount,
    };
  }

  test("takes the word being composed out, the caret staying in its line", () => {
    // Its first part selected, as when a phrase is converted in parts.
    expect(takenOut("お前の首が危ない", "お前の首が危ない", 0, 3)).toEqual({
      text: "",
      caret: 0,
      lines: 1,
    });
    // All of it selected, and the caret after it.
    expect(takenOut("・", "・", 0, 1)).toEqual({ text: "", caret: 0, lines: 1 });
    expect(takenOut("あいうえお", "あいうえお", 5)).toEqual({ text: "", caret: 0, lines: 1 });
  });

  test("leaves a line with anything besides the word to the Enter as it was", () => {
    expect(takenOut("買い物あいう", "あいう", 6)).toBeNull();
    expect(takenOut("", "", 0)).toBeNull();
  });
});

describe("a word being written when the next line is clicked", () => {
  test("stays in its own line, and the next line stays as it was", async () => {
    // jsdom says it is Apple's, as WebKit does: the fix is on.
    expect(navigator.vendor).toMatch(/Apple/);
    const editor = BlockNoteEditor.create({ extensions: [imeCommit()] });
    const host = document.createElement("div");
    document.body.append(host);
    editor.mount(host);
    try {
      editor.replaceBlocks(editor.document, [
        { type: "bulletListItem", content: "上の行" },
        { type: "bulletListItem", content: "下の行" },
      ]);
      const view = editor.prosemirrorView!;
      const at = (text: string) => {
        let found = -1;
        view.state.doc.descendants((node, pos) => {
          if (found < 0 && node.isTextblock && node.textContent === text) found = pos + 1;
          return found < 0;
        });
        return found;
      };
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, at("上の行") + 3)),
      );
      view.dom.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      // The click into the next line, which ends the composition there.
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, at("下の行") + 1)),
      );
      view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: "" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        editor.document.map((block) =>
          (block.content as { text: string }[]).map((part) => part.text).join(""),
        ),
      ).toEqual(["上の行", "下の行"]);
    } finally {
      editor.unmount();
      host.remove();
    }
  });
});

describe("a word begun over a range reaching out of the caret's line", () => {
  /** Checklist items, the editor with imeCommit mounted; run, then let go of. */
  async function withItems(lines: string[], run: (view: EditorView, host: HTMLElement) => void | Promise<void>) {
    const dues = new Y.Doc().getMap<string>(DUE_MAP);
    const editor = BlockNoteEditor.create({
      extensions: [imeCommit(), todoDue({ map: dues, onPick: () => {} })],
      trailingBlock: false,
    });
    const host = document.createElement("div");
    document.body.append(host);
    editor.mount(host);
    try {
      editor.replaceBlocks(
        editor.document,
        lines.map((line) => ({ type: "checkListItem" as const, content: line })),
      );
      // The first with a due: the Todo's buttons at the items' starts.
      dues.set(editor.document[0]!.id, "2026-11-25");
      await new Promise((resolve) => setTimeout(resolve, 0));
      await run(editor.prosemirrorView!, host);
      return editor.document.map((block) =>
        (block.content as { text: string }[]).map((part) => part.text).join(""),
      );
    } finally {
      editor.unmount();
      host.remove();
    }
  }
  const textAt = (view: EditorView, text: string) => {
    let found = -1;
    view.state.doc.descendants((node, pos) => {
      if (found < 0 && node.isTextblock && node.textContent === text) found = pos + 1;
      return found < 0;
    });
    return found;
  };
  const line = (host: HTMLElement, text: string) =>
    [...host.querySelectorAll(".bn-inline-content")].find((p) => p.textContent === text)!;
  const compose = (view: EditorView) =>
    view.dom.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true }));

  /**
   * Where WebKit's range may start, in the new item (its line, its content
   * with the tick box, its block, its outer wrapper), and end, in the item
   * above (in its text, after its text, after its content).
   */
  const inNew: Record<string, (made: Element) => [Node, number]> = {
    line: (made) => [made.querySelector(".bn-inline-content")!, 0],
    content: (made) => [made.querySelector(".bn-block-content")!, 0],
    block: (made) => [made.querySelector(".bn-block")!, 0],
    outer: (made) => [made, 0],
  };
  const inAbove: Record<string, (above: Element) => [Node, number]> = {
    text: (above) => [above.querySelector(".bn-inline-content")!.firstChild!, 4],
    line: (above) => [above.querySelector(".bn-inline-content")!, 1],
    content: (above) => {
      const content = above.querySelector(".bn-block-content")!;
      return [content, content.childNodes.length];
    },
  };
  const ends = Object.keys(inNew).flatMap((start) => Object.keys(inAbove).map((end) => [start, end]));

  test.each(ends)(
    "keeps the new item Enter made, the range from its %s to the %s of the item above: the caret put back, nothing deleted",
    async (start, end) => {
      // As the Mac desktop app's record had it: Enter at the end of an item
      // (one with a due: its button at the new item's start too), and the
      // first word typed in the new one begun over the page's range from
      // the caret to the end of the item above, the editor's a caret.
      const lines = await withItems(["上の項目", "下の項目"], (view, host) => {
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textAt(view, "上の項目") + 4)));
        view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        expect(view.state.selection.$from.parent.textContent).toBe("");
        const above = line(host, "上の項目").closest(".bn-block-outer")!;
        const made = above.nextElementSibling!;
        getSelection()!.setBaseAndExtent(...inNew[start]!(made), ...inAbove[end]!(above));
        compose(view);
        expect(getSelection()!.isCollapsed).toBe(true);
        expect(view.state.selection.empty).toBe(true);
        expect(view.state.selection.$from.parent.textContent).toBe("");
      });
      expect(lines).toEqual(["上の項目", "", "下の項目"]);
    },
  );

  test("leaves a selection the editor has to be typed over, as before", async () => {
    const lines = await withItems(["上の項目", "下の項目"], (view, host) => {
      const from = textAt(view, "上の項目") + 2;
      const to = textAt(view, "下の項目") + 2;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
      getSelection()!.setBaseAndExtent(line(host, "上の項目").firstChild!, 2, line(host, "下の項目").firstChild!, 2);
      compose(view);
    });
    expect(lines).toEqual(["上の項目"]);
  });

  test("leaves a range within the caret's line to the input method", async () => {
    await withItems(["上の項目"], (view, host) => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, textAt(view, "上の項目") + 4)));
      const text = line(host, "上の項目").firstChild!;
      getSelection()!.setBaseAndExtent(text, 4, text, 3);
      expect(caretKeptForComposition(view)).toBe(false);
      expect(getSelection()!.isCollapsed).toBe(false);
    });
  });
});
