import { afterEach, describe, expect, test, vi } from "vitest";
import { TITLE_LIMIT, joinShared, splitQuickText } from "@/lib/quick/text";

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

describe("splitQuickText", () => {
  test("a short first line is the title, and not in the body as well", () => {
    expect(splitQuickText("買い物\n牛乳\n卵")).toEqual({ title: "買い物", body: ["牛乳", "卵"] });
    expect(splitQuickText("牛乳を買う")).toEqual({ title: "牛乳を買う", body: [] });
  });

  test("blank lines around the whole, and after the title, are dropped; those inside are kept", () => {
    expect(splitQuickText("\n\n  予定  \n\n\n月曜\n\n火曜\n\n")).toEqual({
      title: "予定",
      body: ["月曜", "", "火曜"],
    });
  });

  test("a body line keeps its indent, and Windows line ends read as any other", () => {
    expect(splitQuickText("手順\r\n  a. 開く\r\n  b. 閉じる")).toEqual({
      title: "手順",
      body: ["  a. 開く", "  b. 閉じる"],
    });
  });

  test("a first line of up to 30 characters is the title; a longer one stays whole in the body", () => {
    const fits = "あ".repeat(TITLE_LIMIT);
    expect(splitQuickText(`${fits}\n本文`)).toEqual({ title: fits, body: ["本文"] });
    const long = "い".repeat(TITLE_LIMIT + 1);
    expect(splitQuickText(`${long}\n本文`)).toEqual({ title: "", body: [long, "本文"] });
  });

  test("characters are counted as they are seen: a family or a flag is one", () => {
    // 30 as seen, though the family alone is 5 code points and 8 UTF-16 units.
    const fits = `${"あ".repeat(TITLE_LIMIT - 1)}👨‍👩‍👧`;
    expect(splitQuickText(fits)).toEqual({ title: fits, body: [] });
    expect(splitQuickText(`${"あ".repeat(TITLE_LIMIT)}🇯🇵`).title).toBe("");
  });

  test("where characters cannot be told apart as seen, code points are counted instead", () => {
    vi.stubGlobal("Intl", { ...Intl, Segmenter: undefined });
    // The flag is two code points: over the limit without the segmenter's help.
    expect(splitQuickText(`${"あ".repeat(TITLE_LIMIT - 1)}🇯🇵`).title).toBe("");
    expect(splitQuickText("あ".repeat(TITLE_LIMIT)).title).toBe("あ".repeat(TITLE_LIMIT));
    // An emoji outside the basic plane is one code point, though two UTF-16 units.
    const smile = `${"あ".repeat(TITLE_LIMIT - 1)}😀`;
    expect(splitQuickText(smile).title).toBe(smile);
  });

  test("a note that begins with a link keeps it in the body, and is named after its site", () => {
    const link = "https://www.nikkei.com/article/DGXZQO123/";
    expect(splitQuickText(link)).toEqual({ title: "nikkei.com", body: [link] });
    expect(splitQuickText(`https://x.com/a/status/1\nあとで読む`)).toEqual({
      title: "x.com",
      body: ["https://x.com/a/status/1", "あとで読む"],
    });
  });

  test("a list keeps its first item: no title is taken from it", () => {
    for (const list of [
      "・牛乳\n・卵",
      "• 牛乳",
      "● 牛乳",
      "- milk\n- eggs",
      "* milk",
      "+ milk",
      "1. 開く\n2. 閉じる",
      "1) 開く",
      "10. 開く",
      "①準備\n②本番",
      "☐ 洗濯",
      "✓ 済み",
    ]) {
      expect(splitQuickText(list), list).toEqual({ title: "", body: list.split("\n") });
    }
  });

  test("a line that only looks like a list at a glance is still a title", () => {
    expect(splitQuickText("3.14 は円周率").title).toBe("3.14 は円周率");
    expect(splitQuickText("-5度の朝").title).toBe("-5度の朝");
    // A mark inside the line, not at its start.
    expect(splitQuickText("山田・佐藤さんと打ち合わせ").title).toBe("山田・佐藤さんと打ち合わせ");
    expect(splitQuickText("A案 - B案").title).toBe("A案 - B案");
  });

  test("a link written into a sentence ends where the sentence takes over", () => {
    // Ending at the site's name, where what follows would otherwise become part of it.
    expect(splitQuickText("これ（https://example.com）を読む").title).toBe("example.com");
    expect(splitQuickText("「https://www.example.jp」を参照。").title).toBe("example.jp");
    expect(splitQuickText("見て https://example.com.").title).toBe("example.com");
    expect(splitQuickText("ここ→https://example.com、あとで").title).toBe("example.com");
  });

  test("a first line too long to be a title takes the site of a link further down", () => {
    const long = "う".repeat(TITLE_LIMIT + 1);
    const link = "https://www.example.com/a";
    expect(splitQuickText(`${long}\n\n${link}`)).toEqual({
      title: "example.com",
      body: [long, "", link],
    });
  });

  test("nothing but blanks is nothing", () => {
    expect(splitQuickText(" \n \n")).toEqual({ title: "", body: [] });
  });
});
