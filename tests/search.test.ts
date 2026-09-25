import { describe, expect, test } from "vitest";
import { buildIndex, search } from "@/lib/search/engine";
import { normalize, terms } from "@/lib/search/normalize";
import { isKanaQuery } from "@/lib/search/yomi";

const rows = [
  {
    noteId: "n1",
    folderId: null,
    title: "パンケーキのレシピ",
    body: "薄力粉と牛乳をまぜる。フライパンで焼く。",
    folderName: "料理",
    locked: false,
    updatedAt: 3,
  },
  {
    noteId: "n2",
    folderId: "f1",
    title: "会議メモ",
    body: "来週までに見積もりを出す。担当はヤマダさん。",
    folderName: "仕事",
    locked: false,
    updatedAt: 2,
  },
  {
    noteId: "n3",
    folderId: null,
    title: "ロックされたメモ",
    body: null,
    folderName: "秘密",
    locked: true,
    updatedAt: 1,
  },
];

const index = buildIndex(rows);

describe("normalisation", () => {
  test("katakana and hiragana match each other", () => {
    expect(normalize("パンケーキ")).toBe(normalize("ぱんけーき"));
  });

  test("half-width kana matches full width", () => {
    expect(normalize("ｱｲﾃﾑ")).toBe(normalize("アイテム"));
  });

  test("full-width latin and digits match plain ones", () => {
    expect(normalize("ＡＢＣ１２３")).toBe("abc123");
  });

  test("a full-width space separates terms", () => {
    expect(terms("会議　見積もり")).toEqual(["会議", "見積もり"]);
  });
});

describe("search", () => {
  test("finds a note by its title, whichever script is typed", () => {
    expect(search(index, "ぱんけーき").map((h) => h.noteId)).toEqual(["n1"]);
    expect(search(index, "パンケーキ").map((h) => h.noteId)).toEqual(["n1"]);
  });

  test("finds a note by text inside the body", () => {
    const hits = search(index, "見積もり");
    expect(hits.map((h) => h.noteId)).toEqual(["n2"]);
    expect(hits[0]!.matchedIn).toBe("body");
    expect(hits[0]!.snippet.text).toContain("見積もり");
  });

  test("finds a note by its folder name", () => {
    expect(search(index, "料理").map((h) => h.noteId)).toEqual(["n1"]);
  });

  test("every term must match", () => {
    expect(search(index, "牛乳 フライパン").map((h) => h.noteId)).toEqual(["n1"]);
    expect(search(index, "牛乳 見積もり")).toEqual([]);
  });

  test("a title match outranks a body match", () => {
    const withBoth = buildIndex([
      { ...rows[1]!, noteId: "body-only", title: "無題", body: "会議のこと" },
      { ...rows[1]!, noteId: "title-match", title: "会議", body: "なにもない" },
    ]);
    expect(search(withBoth, "会議")[0]!.noteId).toBe("title-match");
  });

  test("a locked note is searchable by title but not by body", () => {
    expect(search(index, "ロック").map((h) => h.noteId)).toEqual(["n3"]);
    expect(search(index, "なにか秘密の本文")).toEqual([]);
  });

  test("an empty query returns nothing rather than everything", () => {
    expect(search(index, "")).toEqual([]);
    expect(search(index, "   ")).toEqual([]);
  });
});

describe("reading search", () => {
  // What kuromoji returns for these strings, verified against the real
  // tokenizer: 薬局 becomes ヤッキョク, not ヤクキョク, because the compound
  // carries the sound change. That is the whole reason a per-character reading
  // table is not enough.
  const withReadings = buildIndex([
    {
      noteId: "n1",
      folderId: null,
      title: "薬局のメモ",
      body: "金曜に歯医者へ行く",
      folderName: "予定",
      locked: false,
      updatedAt: 2,
      reading: "ヤッキョクノメモ\nキンヨウニハイシャヘイク",
    },
    {
      noteId: "n2",
      folderId: null,
      title: "牛乳を買う",
      body: "帰りに寄る",
      folderName: "",
      locked: false,
      updatedAt: 1,
      reading: "ギュウニュウヲカウ\nカエリニヨル",
    },
  ]);

  test("a kanji word is found by typing its reading", () => {
    expect(search(withReadings, "やっきょく").map((h) => h.noteId)).toEqual(["n1"]);
    expect(search(withReadings, "ヤッキョク").map((h) => h.noteId)).toEqual(["n1"]);
  });

  test("the reading of body text is searchable too", () => {
    expect(search(withReadings, "はいしゃ").map((h) => h.noteId)).toEqual(["n1"]);
    expect(search(withReadings, "ぎゅうにゅう").map((h) => h.noteId)).toEqual(["n2"]);
  });

  test("terms may mix a literal word and a reading", () => {
    // 薬局 matches the title literally, きんよう only via the reading.
    expect(search(withReadings, "薬局 きんよう").map((h) => h.noteId)).toEqual(["n1"]);
  });

  test("a literal match outranks one found through a reading", () => {
    const mixed = buildIndex([
      {
        noteId: "reading-only",
        folderId: null,
        title: "予定",
        body: "",
        folderName: "",
        locked: false,
        updatedAt: 9,
        reading: "ヨテイ\nカイギ",
      },
      {
        noteId: "literal",
        folderId: null,
        title: "かいぎ",
        body: "",
        folderName: "",
        locked: false,
        updatedAt: 1,
        reading: "カイギ",
      },
    ]);
    // Even though the reading-only note is newer, the literal title wins.
    expect(search(mixed, "かいぎ")[0]!.noteId).toBe("literal");
  });

  test("notes without a computed reading are unaffected", () => {
    // Before the dictionary is downloaded every reading is absent; ordinary
    // search has to keep working exactly as before.
    expect(search(index, "パンケーキ").map((h) => h.noteId)).toEqual(["n1"]);
    expect(search(index, "ぱんけーき").map((h) => h.noteId)).toEqual(["n1"]);
  });
});

describe("kana query detection", () => {
  test("only a kana query is worth a reading lookup", () => {
    expect(isKanaQuery("やっきょく")).toBe(true);
    expect(isKanaQuery("ヤッキョク")).toBe(true);
    expect(isKanaQuery("きんよう よてい")).toBe(true);
    // A query that already contains kanji needs no reading.
    expect(isKanaQuery("薬局")).toBe(false);
    expect(isKanaQuery("abc")).toBe(false);
    // Too short to be meaningful.
    expect(isKanaQuery("あ")).toBe(false);
  });
});
