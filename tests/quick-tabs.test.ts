import "fake-indexeddb/auto";
import { beforeEach, describe, expect, test } from "vitest";
import { getMeta, resetLocalData, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import { MAX_TABS, closeTab, keepDraft, loadDraft, loadTabs, openTab, showTab } from "@/lib/quick/draft";

const ME = "user-me";

beforeEach(async () => {
  await resetLocalData();
});

/** Writes a tab's draft as the quick note does. */
async function write(tabId: string, text: string, userKey = ME) {
  const keeper = keepDraft(userKey, tabId);
  keeper.release();
  keeper.update(text);
  await keeper.flush();
  keeper.dispose();
}

describe("the quick note's tabs", () => {
  test("start as one, empty, shown", async () => {
    const tabs = await loadTabs(ME);
    expect(tabs.ids).toHaveLength(1);
    expect(tabs.active).toBe(tabs.ids[0]);
    expect((await loadTabs(ME)).ids).toEqual(tabs.ids);
  });

  test("the one draft of a version with no tabs becomes the first tab's", async () => {
    await setMeta(META.quickDraft, { text: "前の下書き", updatedAt: 0, userKey: ME });
    const tabs = await loadTabs(ME);
    expect((await loadDraft(ME, tabs.ids[0]!))?.text).toBe("前の下書き");
    expect(await getMeta(META.quickDraft, null)).toBeNull();
  });

  test("another account's old draft is not taken, nor its tabs shown", async () => {
    await setMeta(META.quickDraft, { text: "他人の", updatedAt: 0, userKey: "user-other" });
    const mine = await loadTabs(ME);
    expect(await loadDraft(ME, mine.active)).toBeNull();
    await write(mine.active, "私の");
    const theirs = await loadTabs("user-other");
    expect(theirs.ids).not.toContain(mine.active);
    // Each account's own, side by side.
    expect((await loadTabs(ME)).ids).toEqual(mine.ids);
  });

  test("a tab opened goes after the others, shown; up to the most there may be", async () => {
    const first = (await loadTabs(ME)).active;
    const second = await openTab(ME);
    expect((await loadTabs(ME)).ids).toEqual([first, second]);
    expect((await loadTabs(ME)).active).toBe(second);
    for (let i = 2; i < MAX_TABS; i += 1) await openTab(ME);
    expect(await openTab(ME)).toBeNull();
    expect((await loadTabs(ME)).ids).toHaveLength(MAX_TABS);
  });

  test("closed, a tab goes with its draft, the one after it shown (the one before, for the last)", async () => {
    const a = (await loadTabs(ME)).active;
    const b = (await openTab(ME))!;
    const c = (await openTab(ME))!;
    await write(b, "二つ目");
    await showTab(ME, b);
    expect((await closeTab(ME, b)).active).toBe(c);
    expect(await loadDraft(ME, b)).toBeNull();
    expect((await closeTab(ME, c)).active).toBe(a);
    // One not shown closes without moving what is.
    const d = (await openTab(ME))!;
    expect((await closeTab(ME, a)).active).toBe(d);
  });

  test("the last tab closed leaves an empty one", async () => {
    const only = (await loadTabs(ME)).active;
    await write(only, "最後");
    const after = await closeTab(ME, only);
    expect(after.ids).toHaveLength(1);
    expect(after.active).not.toBe(only);
    expect(await loadDraft(ME, after.active)).toBeNull();
  });
});
