import "fake-indexeddb/auto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { resetLocalData } from "@/lib/db";
import {
  HISTORY_SIZE,
  forgetSearch,
  forgetSearchHistory,
  rememberSearch,
  searchHistory,
  searchHistorySnapshot,
  subscribeSearchHistory,
} from "@/lib/search/history";

beforeEach(() => {
  forgetSearchHistory();
  localStorage.clear();
});

describe("the searches made last on this device", () => {
  test("newest first, as they were written, at most HISTORY_SIZE", () => {
    for (let n = 1; n <= HISTORY_SIZE + 3; n += 1) rememberSearch(`検索 ${n}`);
    const kept = searchHistory();
    expect(kept).toHaveLength(HISTORY_SIZE);
    expect(kept[0]).toBe(`検索 ${HISTORY_SIZE + 3}`);
    expect(kept.at(-1)).toBe("検索 4");
  });

  test("the same search again goes to the top, once, however it is written this time", () => {
    rememberSearch("パンケーキ");
    rememberSearch("買い物");
    rememberSearch("ぱんけーき");
    expect(searchHistory()).toEqual(["ぱんけーき", "買い物"]);
    rememberSearch("  買い物　 ");
    expect(searchHistory()).toEqual(["買い物", "ぱんけーき"]);
  });

  test("nothing kept for a search of nothing, or a passage pasted in", () => {
    rememberSearch("   ");
    rememberSearch("あ".repeat(101));
    expect(searchHistory()).toEqual([]);
  });

  test("one forgotten, or all of them", () => {
    rememberSearch("一");
    rememberSearch("二");
    forgetSearch("一");
    expect(searchHistory()).toEqual(["二"]);
    forgetSearchHistory();
    expect(searchHistory()).toEqual([]);
  });

  test("forgotten with the rest of the account's data on this device (signing out, say)", async () => {
    rememberSearch("ほかの人に見せない言葉");
    await resetLocalData();
    expect(searchHistory()).toEqual([]);
  });

  test("for React: the same array until it changes, and who listens is told", () => {
    rememberSearch("一");
    const first = searchHistorySnapshot();
    expect(searchHistorySnapshot()).toBe(first);
    const listener = vi.fn();
    const stop = subscribeSearchHistory(listener);
    rememberSearch("二");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(searchHistorySnapshot()).not.toBe(first);
    expect(searchHistorySnapshot()).toEqual(["二", "一"]);
    stop();
  });

  test("kept for the session where storage is refused (a private window)", () => {
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    rememberSearch("一");
    expect(searchHistory()).toEqual(["一"]);
    set.mockRestore();
  });
});
