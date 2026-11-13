import { BlockNoteEditor } from "@blocknote/core";
import { TextSelection } from "prosemirror-state";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { TODO_SORT, todoDue } from "@/components/editor/todo-due";
import { listKeys } from "@/components/editor/list-keys";
import { TODO_TIDY, todoOnly } from "@/components/editor/todo-only";
import { DUE_MAP } from "@/lib/quick/todo-due";

let editor: BlockNoteEditor;
let host: HTMLDivElement;
let dues: Y.Map<string>;
const picked: string[] = [];

beforeEach(() => {
  // Monday, 9 November 2026, 10:30.
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 10, 9, 10, 30) });
  dues = new Y.Doc().getMap<string>(DUE_MAP);
  picked.length = 0;
  editor = BlockNoteEditor.create({
    // As the Todo's editor has them.
    extensions: [todoOnly(), listKeys(), todoDue({ map: dues, onPick: (id) => picked.push(id) })],
    trailingBlock: false,
  });
  host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
});

afterEach(() => {
  editor.unmount();
  host.remove();
  vi.useRealTimers();
});

const view = () => editor.prosemirrorView!;
const textOf = (block: { content?: unknown }) =>
  Array.isArray(block.content) ? (block.content as { text?: string }[]).map((run) => run.text ?? "").join("") : "";
const idOf = (text: string) => editor.document.find((block) => textOf(block) === text)!.id;
/** Items, and their dues by their text. */
function items(lines: string[], due: Record<string, string> = {}) {
  editor.replaceBlocks(
    editor.document,
    lines.map((line) => ({ type: "checkListItem" as const, props: { checked: line.startsWith("[x]") }, content: line.slice(4) })),
  );
  for (const [text, at] of Object.entries(due)) dues.set(idOf(text), at);
}
/** Waits for the dues' change to reach the editor (it is told after the change). */
const settle = () =>
  vi.waitFor(() => expect(host.querySelectorAll(".todo-due:not(.todo-due-add)").length).toBeGreaterThan(0));
/** The list as it is on screen: each item's heading over it, if it has one, its text and its due. */
const shown = () =>
  [...host.querySelectorAll(".bn-editor > .bn-block-group > .bn-block-outer")].map((outer) => {
    const heading = outer.getAttribute("data-todo-group");
    const text = outer.querySelector(".bn-inline-content")?.textContent ?? "";
    const due = outer.querySelector(":scope > .bn-block > .todo-due:not(.todo-due-add)")?.textContent;
    return `${heading ? `【${heading}】` : ""}${text}${due ? ` ${due}` : ""}`;
  });
const sort = () => view().dispatch(view().state.tr.setMeta(TODO_SORT, true));

describe("the Todo's dues", () => {
  test("show at their items, under headings by when they are, once any item has one", async () => {
    items(["[ ] SPI", "[ ] 適性検査", "[ ] 本選考", "[ ] カプコン", "[ ] ES"], {
      SPI: "2026-11-08",
      適性検査: "2026-11-09T23:59",
      本選考: "2026-11-10",
      ES: "2026-11-30",
    });
    await settle();
    sort();
    expect(shown()).toEqual([
      "【期限切れ】SPI 11/8(日)",
      "【今日】適性検査 11/9(月) 23:59",
      "【明日】本選考 11/10(火)",
      "【それ以降】ES 11/30(月)",
      "【期日なし】カプコン",
    ]);
    expect(host.querySelector(".todo-due-overdue")?.textContent).toBe("11/8(日)");
    expect(host.querySelector(".todo-due-today")?.textContent).toBe("11/9(月) 23:59");
  });

  test("no headings while no item has a due; each item has a calendar to give it one", () => {
    items(["[ ] 牛乳", "[ ] 卵"]);
    expect(shown()).toEqual(["牛乳", "卵"]);
    expect(host.querySelectorAll(".todo-due-add")).toHaveLength(2);
    (host.querySelector(".todo-due-add") as HTMLButtonElement).click();
    expect(picked).toEqual([idOf("牛乳")]);
  });

  test("are put in order as a due is set, not as anything is typed", async () => {
    items(["[ ] 本選考", "[ ] ES", "[ ] カプコン"], { 本選考: "2026-11-10", ES: "2026-11-30" });
    await settle();
    sort();
    // Written after an item with a due: stays there, under its heading.
    let end = -1;
    view().state.doc.descendants((node, pos) => {
      if (end < 0 && node.isTextblock && node.textContent === "本選考") end = pos + 1 + node.content.size;
      return end < 0;
    });
    view().dispatch(view().state.tr.setSelection(TextSelection.create(view().state.doc, end)));
    view().dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    view().dispatch(view().state.tr.insertText("SPI"));
    // Not where its due (none) would put it: under the heading above it.
    expect(shown()).toEqual(["【明日】本選考 11/10(火)", "SPI", "【それ以降】ES 11/30(月)", "【期日なし】カプコン"]);
    // Given one sooner, it goes before, once asked.
    dues.set(idOf("SPI"), "2026-11-09");
    await vi.waitFor(() => expect(shown()[1]).toContain("SPI 11/9(月)"));
    sort();
    expect(shown()).toEqual([
      "【今日】SPI 11/9(月)",
      "【明日】本選考 11/10(火)",
      "【それ以降】ES 11/30(月)",
      "【期日なし】カプコン",
    ]);
  });

  test("stay with their item's text as Enter makes a new item, after it or (at its start) above it", async () => {
    items(["[ ] 本選考", "[ ] カプコン"], { 本選考: "2026-11-30" });
    await settle();
    const caretAt = (text: string, offset: number) => {
      let at = -1;
      view().state.doc.descendants((node, pos) => {
        if (at < 0 && node.isTextblock && node.textContent === text) at = pos + 1 + offset;
        return at < 0;
      });
      view().dispatch(view().state.tr.setSelection(TextSelection.create(view().state.doc, at)));
    };
    const enter = () =>
      view().dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    caretAt("本選考", 3);
    enter();
    caretAt("本選考", 0);
    enter();
    // The new ones (empty, above and below it) given its day, at its end.
    await vi.waitFor(() =>
      expect(shown().map((line) => line.replace(/【.*】/, ""))).toEqual([
        " 11/30(月) 23:59",
        "本選考 11/30(月)",
        " 11/30(月) 23:59",
        "カプコン",
      ]),
    );
    expect(dues.get(idOf("本選考"))).toBe("2026-11-30");
  });

  test("an item made by Enter under 今日, 明日 or any heading is given that day, at 23:59, and stays there once put in order", async () => {
    items(["[ ] 本選考", "[ ] 面接", "[ ] ES", "[ ] カプコン"], {
      本選考: "2026-11-09T12:00",
      面接: "2026-11-10",
      ES: "2026-11-30T09:00",
    });
    await settle();
    const enterAtEnd = (text: string) => {
      let at = -1;
      view().state.doc.descendants((node, pos) => {
        if (at < 0 && node.isTextblock && node.textContent === text) at = pos + 1 + node.content.size;
        return at < 0;
      });
      view().dispatch(view().state.tr.setSelection(TextSelection.create(view().state.doc, at)));
      view().dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    };
    enterAtEnd("本選考");
    view().dispatch(view().state.tr.insertText("SPI"));
    enterAtEnd("面接");
    view().dispatch(view().state.tr.insertText("お礼のメール"));
    enterAtEnd("ES");
    view().dispatch(view().state.tr.insertText("自己分析"));
    // At the end of the last item with a due, too: before 期日なし, not one of it.
    await vi.waitFor(() => expect(dues.get(idOf("SPI"))).toBe("2026-11-09T23:59"));
    expect(dues.get(idOf("お礼のメール"))).toBe("2026-11-10T23:59");
    expect(dues.get(idOf("自己分析"))).toBe("2026-11-30T23:59");
    // On screen with them, beside the item each was made from.
    await vi.waitFor(() => expect(shown()).toContain("自己分析 11/30(月) 23:59"));
    // Put in order (as the list is as it is opened again): each under the heading it was made under.
    // (A due of a day alone is its end, after 23:59: お礼のメール goes before 面接.)
    sort();
    expect(shown()).toEqual([
      "【今日】本選考 11/9(月) 12:00",
      "SPI 11/9(月) 23:59",
      "【明日】お礼のメール 11/10(火) 23:59",
      "面接 11/10(火)",
      "【それ以降】ES 11/30(月) 09:00",
      "自己分析 11/30(月) 23:59",
      "【期日なし】カプコン",
    ]);
  });

  test("an item made by Enter in one with no due, or one done, is given none; nor is one made otherwise", async () => {
    items(["[ ] 本選考", "[ ] カプコン", "[x] 済んだ"], { 本選考: "2026-11-09", 済んだ: "2026-11-09" });
    await settle();
    const enterAtEnd = (text: string) => {
      let at = -1;
      view().state.doc.descendants((node, pos) => {
        if (at < 0 && node.isTextblock && node.textContent === text) at = pos + 1 + node.content.size;
        return at < 0;
      });
      view().dispatch(view().state.tr.setSelection(TextSelection.create(view().state.doc, at)));
      view().dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    };
    enterAtEnd("カプコン");
    view().dispatch(view().state.tr.insertText("リクルーター面談"));
    // An item put in by other means (pasted, say) beside one with a due: none.
    editor.insertBlocks([{ type: "checkListItem", content: "貼った項目" }], idOf("本選考"), "after");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dues.has(idOf("リクルーター面談"))).toBe(false);
    expect(dues.has(idOf("貼った項目"))).toBe(false);
    expect(dues.size).toBe(2);
  });

  test("the done after those to do, their dues faded, with no calendar for those with none", async () => {
    items(["[x] 済んだ", "[ ] 本選考", "[x] 前のもの"], { 本選考: "2026-11-30", 済んだ: "2026-11-01" });
    await settle();
    view().dispatch(view().state.tr.setMeta(TODO_TIDY, true));
    expect(shown()).toEqual(["【それ以降】本選考 11/30(月)", "済んだ 11/1(日)", "前のもの"]);
    expect(host.querySelector(".todo-due-done")?.textContent).toBe("11/1(日)");
    expect(host.querySelectorAll(".todo-due-add")).toHaveLength(0);
  });
});
