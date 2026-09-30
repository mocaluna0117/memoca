import { afterEach, describe, expect, test, vi } from "vitest";
import { joinShared, quickLines } from "@/lib/quick/text";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("joinShared", () => {
  const link = "https://example.com/a";

  test("puts the title, the text and the link on lines of their own", () => {
    expect(joinShared({ title: "記事", text: "読んでおく", url: link })).toBe(
      `記事\n読んでおく\n${link}`,
    );
  });

  test("a link the text already holds as a word is not added again", () => {
    expect(joinShared({ text: `これ見て ${link}`, url: link })).toBe(`これ見て ${link}`);
    // Only part of a longer address: not the same link, so it is added.
    expect(joinShared({ text: `${link}?ref=x`, url: link })).toBe(`${link}?ref=x\n${link}`);
  });

  test("a text that begins with the title loses that beginning, and the title stays its own line", () => {
    expect(joinShared({ title: "記事", text: `記事 ${link}`, url: link })).toBe(`記事\n${link}`);
    expect(joinShared({ title: "記事", text: "記事\n本文" })).toBe("記事\n本文");
    expect(joinShared({ title: "同じ", text: "同じ" })).toBe("同じ");
  });

  test("a title the text only mentions, or runs on from, is kept as it is", () => {
    expect(joinShared({ title: "記事", text: "今日読んだ記事まとめ" })).toBe(
      "記事\n今日読んだ記事まとめ",
    );
    expect(joinShared({ title: "記事", text: "記事まとめ" })).toBe("記事\n記事まとめ");
  });

  test("a link already there as a word of a line, or as the title, is not added again", () => {
    expect(joinShared({ text: `記事\n${link}`, url: link })).toBe(`記事\n${link}`);
    expect(joinShared({ title: link, url: link })).toBe(link);
  });

  test("leaves out what is missing or blank", () => {
    expect(joinShared({ title: null, text: "  メモ  ", url: undefined })).toBe("メモ");
    expect(joinShared({ title: " ", text: "" })).toBe("");
  });
});

describe("quickLines", () => {
  test("all of what is typed goes in the body, the first line too", () => {
    expect(quickLines("買い物\n牛乳\n卵")).toEqual(["買い物", "牛乳", "卵"]);
    expect(quickLines("牛乳を買う")).toEqual(["牛乳を買う"]);
    expect(quickLines("https://www.nikkei.com/article/DGXZQO123/")).toEqual([
      "https://www.nikkei.com/article/DGXZQO123/",
    ]);
  });

  test("blank lines around the whole are dropped; those inside are kept", () => {
    expect(quickLines("\n\n  予定  \n\n\n月曜\n\n火曜\n\n")).toEqual([
      "  予定  ",
      "",
      "",
      "月曜",
      "",
      "火曜",
    ]);
  });

  test("a line keeps its indent, and Windows line ends read as any other", () => {
    expect(quickLines("手順\r\n  a. 開く\r\n  b. 閉じる")).toEqual([
      "手順",
      "  a. 開く",
      "  b. 閉じる",
    ]);
  });

  test("nothing but blanks is nothing", () => {
    expect(quickLines(" \n \n")).toEqual([]);
    expect(quickLines("")).toEqual([]);
  });
});
