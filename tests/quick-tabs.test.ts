import "fake-indexeddb/auto";
import { beforeEach, describe, expect, test } from "vitest";
import { getMeta, resetLocalData, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import {
  MAX_TABS,
  closeTab,
  forgetTabs,
  goneTabs,
  keepDraft,
  loadDraft,
  loadTabs,
  newTabId,
  openTab,
  showTab,
  shownIsHidden,
} from "@/lib/quick/draft";
import { db } from "@/lib/db";
import { TODO_TAB_ID } from "@/lib/quick/todo-id";

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

describe("tabs closed on another device", () => {
  const MINUTE = 60 * 1000;
  test("are this device's no more: one whose note is in the trash, or one long made whose note is nowhere", () => {
    const closed = newTabId();
    const open = newTabId();
    const purged = newTabId();
    const justMade = newTabId();
    const notes = [
      { noteId: closed, deletedAt: Date.now(), purged: false },
      { noteId: open, deletedAt: null, purged: false },
    ];
    const later = Date.now() + 30 * MINUTE;
    // Just made, its note not written yet: kept.
    expect(goneTabs([TODO_TAB_ID, closed, open, justMade], notes, Date.now())).toEqual([closed]);
    // Long made, its note gone from this device (purged from the trash): gone.
    expect(goneTabs([TODO_TAB_ID, closed, open, purged], notes, later)).toEqual([closed, purged]);
  });

  test("forgotten, they no longer count against the most there may be, and another is shown in their place", async () => {
    const first = (await loadTabs(ME)).ids[0]!;
    const gone: string[] = [];
    for (let i = 1; i < MAX_TABS; i++) gone.push((await openTab(ME))!);
    expect(await openTab(ME)).toBeNull();
    const tabs = await forgetTabs(ME, gone);
    expect(tabs.ids).toEqual([first]);
    expect(tabs.active).toBe(first);
    expect(await openTab(ME)).not.toBeNull();
  });
});

describe("a tab of another device's, shown here", () => {
  test("is made this device's own as it is shown, even as the one it already shows", async () => {
    const theirs = newTabId();
    const tabs = await loadTabs(ME);
    await setMeta(`${META.quickTabs}:${ME}`, { ...tabs, active: theirs });
    const shown = await showTab(ME, theirs);
    expect(shown.ids).toContain(theirs);
    expect(shown.active).toBe(theirs);
  });
});

describe("the empty tab made for this device, shown", () => {
  test("is out of sight while another tab of the account's has something in it", async () => {
    const tabs = await loadTabs(ME);
    const mine = { ...tabs, fresh: tabs.active };
    expect(await shownIsHidden(mine, "")).toBe(false);
    await db().notes.add({ noteId: newTabId(), preview: "ほかの端末のメモ", deletedAt: null, purged: false } as never);
    expect(await shownIsHidden(mine, "")).toBe(true);
    // Something in it: in sight.
    expect(await shownIsHidden(mine, "下書き")).toBe(false);
  });
});
