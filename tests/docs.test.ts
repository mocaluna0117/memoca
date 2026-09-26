import "fake-indexeddb/auto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { db, resetLocalData } from "@/lib/db";
import { acquireDoc, flushAll, flushDoc, openDoc, releaseDoc, reloadDoc } from "@/lib/sync/docs";
import type { Note } from "@/lib/types";
import { zero } from "./helpers/seed";

const note = (noteId: string): Note => ({
  noteId,
  folderId: null,
  kind: "note",
  title: noteId,
  preview: null,
  pinned: false,
  sortKey: "a",
  locked: false,
  keyEpoch: 0,
  deletedAt: null,
  purged: false,
  lastUpdateSeq: 0,
  snapshotSeq: 0,
  ts: { title: zero, preview: zero, place: zero, pin: zero, trash: zero, lock: zero },
  seq: 0,
  updatedAt: 0,
});

const saved = () => db().updates.where("noteId").equals("n1").count();

beforeEach(async () => {
  await resetLocalData();
  await db().notes.put(note("n1"));
});

describe("one live document per note", () => {
  test("two callers opening it at the same moment get the same document", async () => {
    const [first, second] = await Promise.all([acquireDoc("n1"), acquireDoc("n1")]);
    expect(second).toBe(first);
    expect(openDoc("n1")).toBe(first);

    // Both hold it: closed only when both let go.
    await releaseDoc("n1");
    expect(openDoc("n1")).toBe(first);
    await releaseDoc("n1");
    expect(openDoc("n1")).toBeUndefined();
  });

  test("opened again while its last edits are being written, it stays usable and saves", async () => {
    const doc = await acquireDoc("n1");
    doc.getText("t").insert(0, "閉じる前");
    // Let go, and open it again before that finishes writing.
    const closing = releaseDoc("n1");
    const again = await acquireDoc("n1");
    await closing;

    expect(again).toBe(doc);
    expect(again.isDestroyed).toBe(false);
    expect(openDoc("n1")).toBe(doc);
    const before = await saved();
    again.getText("t").insert(0, "開き直した後");
    await flushAll();
    expect(await saved()).toBe(before + 1);
    await releaseDoc("n1");
    expect(openDoc("n1")).toBeUndefined();
  });
});

describe("saving an open note's edits", () => {
  test("writes the waiting ones at once when asked, and nothing when none wait", async () => {
    const doc = await acquireDoc("n1");
    doc.getText("t").insert(0, "すぐ保存");
    await flushDoc("n1");
    expect(await saved()).toBe(1);
    await flushDoc("n1");
    expect(await saved()).toBe(1);
    await releaseDoc("n1");
    // And a note nobody has open has nothing to write.
    await flushDoc("n1");
    expect(await saved()).toBe(1);
  });
});

describe("reloading an open note from storage", () => {
  test("keeps an edit made while the stored version is being read", async () => {
    const doc = await acquireDoc("n1");
    const reloading = reloadDoc("n1");
    doc.getText("t").insert(0, "読み込み中の編集");
    await reloading;
    await flushAll();

    expect(await saved()).toBe(1);
    await releaseDoc("n1");
    // Built again from storage alone, it still has the edit.
    const again = await acquireDoc("n1");
    expect(again).not.toBe(doc);
    expect(again.getText("t").toString()).toBe("読み込み中の編集");
    await releaseDoc("n1");
  });

  test("still saves an edit that was waiting to be saved, without being asked to", async () => {
    const doc = await acquireDoc("n1");
    doc.getText("t").insert(0, "待っていた編集");
    await reloadDoc("n1");
    // Nothing flushes it by hand: the usual short wait does.
    await vi.waitFor(async () => expect(await saved()).toBe(1), { timeout: 3_000, interval: 50 });
    await releaseDoc("n1");
  });
});
