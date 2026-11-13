import { BlockNoteEditor } from "@blocknote/core";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import { getDefaultReactSlashMenuItems } from "@blocknote/react";
import { getMultiColumnSlashMenuItems } from "@blocknote/xl-multi-column";
import { describe, expect, test } from "vitest";
import { DICTIONARY, SCHEMA } from "@/components/editor/schema";
import { withReadings } from "@/components/editor/slash-readings";
import { itemsForSlash } from "@/components/editor/slash-turn-line";

/** The / menu's items as a note has them, and the titles of those a query leaves. */
function found(query: string, read = true): string[] {
  const editor = BlockNoteEditor.create({ schema: SCHEMA as never, dictionary: DICTIONARY as never });
  const items = [
    ...getDefaultReactSlashMenuItems(editor as never),
    ...getMultiColumnSlashMenuItems(editor as never),
  ];
  return filterSuggestionItems(read ? withReadings(items) : items, query).map((item) => item.title);
}

describe("the / menu, narrowed by how an item is read", () => {
  test("in hiragana, as it stands before the input method turns it", () => {
    expect(found("みだし", false)).toEqual([]);
    expect(found("みだし")).toContain("見出し１");
    expect(found("かじょう")).toEqual(["箇条書き"]);
    expect(found("ちぇっく")).toEqual(["チェックリスト"]);
    expect(found("いんよう")).toEqual(["引用"]);
    expect(found("こーど")).toEqual(["コードブロック"]);
    expect(found("ひょう")).toContain("表");
    expect(found("がぞう")).toEqual(["画像"]);
    expect(found("くぎり")).toContain("区切り");
    expect(found("おりたたみ")).toContain("折りたたみリスト");
    expect(found("れつ").length).toBeGreaterThanOrEqual(2);
  });

  test("and still by its name, and by what BlockNote knew it by", () => {
    expect(found("見出し")).toContain("見出し１");
    expect(found("h2")).toEqual(["見出し２", "折りたたみ見出し２"]);
    expect(found("table")).toEqual(["表"]);
  });
});

describe("the / menu typed straight after a word", () => {
  /** The titles left for this line (the caret at its end), its / and query the line's last. */
  function left(line: string): string[] {
    const editor = BlockNoteEditor.create({
      schema: SCHEMA as never,
      dictionary: DICTIONARY as never,
    }) as unknown as BlockNoteEditor;
    const host = document.createElement("div");
    document.body.append(host);
    editor.mount(host);
    try {
      editor.replaceBlocks(editor.document, [{ type: "paragraph", content: line }]);
      editor.setTextCursorPosition(editor.document[0]!, "end");
      const query = line.slice(line.lastIndexOf("/") + 1);
      const items = withReadings([
        ...getDefaultReactSlashMenuItems(editor as never),
        ...getMultiColumnSlashMenuItems(editor as never),
      ]);
      return filterSuggestionItems(
        [...itemsForSlash(editor, query, items), ...itemsForSlash(editor, query, [{ title: "メモへのリンク", aliases: ["メモ"] }])],
        query,
      ).map((item) => item.title);
    } finally {
      editor.unmount();
      host.remove();
    }
  }

  test("offers nothing that is put in (a table, an image, columns, a link to a note): the words stay as written", () => {
    // Each took the Enter after it: a table in and 「/表」 gone, and so on.
    for (const line of ["図/表", "行/列", "写真/動画", "写真/画像", "紙/メモ", "上/区切り", "タイトル/本文", "男性/女性"]) {
      expect(left(line), line).toEqual([]);
    }
  });

  test("still offers what makes the line something else, as it opens there for", () => {
    expect(left("きょうの予定/見出し")).toContain("見出し１");
    expect(left("きょうの予定/みだし")).toContain("見出し１");
    expect(left("買うもの/箇条書き")).toEqual(["箇条書き"]);
  });

  test("at a line's start, or after a space, offers everything", () => {
    expect(left("/表")).toContain("表");
    expect(left("図 /表")).toContain("表");
    expect(left("図　/画像")).toEqual(["画像"]);
    expect(left("/メモ")).toEqual(["メモへのリンク"]);
  });
});
