import { BlockNoteEditor } from "@blocknote/core";
import { TextSelection } from "prosemirror-state";
import { describe, expect, test } from "vitest";
import { imeCommit, strayLine } from "@/components/editor/ime-commit";

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
