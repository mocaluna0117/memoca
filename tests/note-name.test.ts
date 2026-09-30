import { describe, expect, test } from "vitest";
import { UNTITLED, firstLineOf, noteName } from "@/lib/note-name";
import { type IndexInput, buildIndex, search } from "@/lib/search/engine";

describe("what a note is called where it is listed", () => {
  test("its title, as given", () => {
    expect(noteName("買い物", "牛乳")).toEqual({ text: "買い物", standIn: false, untitled: false });
    expect(noteName("  会議  ", null)).toEqual({ text: "会議", standIn: false, untitled: false });
  });

  test("with no title, its first line stands in for one, set apart", () => {
    expect(noteName("", "牛乳を買う")).toEqual({
      text: "牛乳を買う",
      standIn: true,
      untitled: false,
    });
    expect(noteName(null, "\n  \n  二行目から  \n三行目").text).toBe("二行目から");
    expect(noteName("   ", "本文").text).toBe("本文");
  });

  test("a long first line is cut short, and never through a character as it is seen", () => {
    expect(noteName("", "あ".repeat(100)).text).toBe("あ".repeat(60));
    for (const whole of ["😀", "🇯🇵", "👨‍👩‍👧"]) {
      expect(noteName("", `${"あ".repeat(59)}${whole}です`).text, whole).toBe(
        `${"あ".repeat(59)}${whole}`,
      );
    }
  });

  test("with neither, 無題のメモ, said to be none", () => {
    for (const [title, line] of [
      ["", ""],
      [undefined, null],
      ["", " \n "],
    ] as const) {
      expect(noteName(title, line)).toEqual({ text: UNTITLED, standIn: true, untitled: true });
    }
    // A title that happens to read 無題のメモ is a title all the same.
    expect(noteName(UNTITLED, "").untitled).toBe(false);
  });

  test("the first line of a text is the first with anything on it, trimmed", () => {
    expect(firstLineOf("\n\n  一  \n二", 10)).toBe("一");
    expect(firstLineOf("", 10)).toBe("");
    expect(firstLineOf("あいうえお", 3)).toBe("あいう");
  });
});

describe("a note found by search", () => {
  const row = (over: Partial<IndexInput> & { noteId: string }): IndexInput => ({
    folderId: null,
    title: "",
    body: null,
    folderName: "",
    locked: false,
    updatedAt: 0,
    ...over,
  });
  const found = (rows: IndexInput[], query: string) =>
    Object.fromEntries(search(buildIndex(rows), query).map((hit) => [hit.noteId, hit]));

  test("comes with its first line when it has no title, to stand in for one", () => {
    const hits = found(
      [
        row({ noteId: "quick", body: "\n牛乳を買う\n卵も", folderName: "Inbox", updatedAt: 2 }),
        row({ noteId: "titled", title: "買い物", body: "牛乳", updatedAt: 1 }),
      ],
      "牛乳",
    );
    expect(hits.quick?.standIn).toBe("牛乳を買う");
    expect(hits.titled?.standIn).toBe("");
  });

  test("a locked note's text stands in for nothing, whatever the row holds", () => {
    const hits = found(
      [
        row({
          noteId: "locked",
          body: "牛乳の秘密",
          preview: "牛乳の秘密",
          folderName: "牛乳",
          locked: true,
        }),
      ],
      "牛乳",
    );
    expect(hits.locked?.standIn).toBe("");
  });

  test("the first line is the one the note keeps, before its text on this device", () => {
    const hits = found(
      [row({ noteId: "n", preview: "一覧の行", body: "別の行\n一覧の行" })],
      "一覧",
    );
    expect(hits.n?.standIn).toBe("一覧の行");
  });

  test("with no text on this device yet, is found by the first line the note keeps", () => {
    const hits = found(
      [row({ noteId: "old", preview: "古い即席メモ", folderName: "Inbox" })],
      "古い",
    );
    expect(hits.old?.standIn).toBe("古い即席メモ");
  });

  test("the first line is searched as a title is, kana and case alike", () => {
    const hits = found([row({ noteId: "n", preview: "ミルクを買う" })], "みるく");
    expect(hits.n?.standIn).toBe("ミルクを買う");
  });

  test("found by the first line standing in for its title, ranks as one found by its title", () => {
    const rows = [
      row({ noteId: "quick", body: "牛乳を買う", preview: "牛乳を買う" }),
      row({ noteId: "mentions", title: "日記", body: "今日は牛乳を買うのを忘れた", updatedAt: 1 }),
    ];
    expect(search(buildIndex(rows), "牛乳").map((hit) => hit.noteId)).toEqual([
      "quick",
      "mentions",
    ]);
  });
});
