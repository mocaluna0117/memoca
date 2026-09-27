import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { db, resetLocalData } from "@/lib/db";
import { appendParagraphs } from "@/lib/quick/body";
import {
  acquireDoc,
  flushAll,
  flushDoc,
  hasUnsavedEdits,
  openDoc,
  releaseDoc,
  reloadDoc,
} from "@/lib/sync/docs";
import { bodyFragment, extractText } from "@/lib/sync/ydoc";
import type { Note } from "@/lib/types";
import { valid } from "./helpers/blocknote";
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

/**
 * Makes the next update fail to be stored, as a lost connection to storage
 * or a full disk does.
 */
function failNextWrite() {
  const updates = db().updates;
  const add = updates.add.bind(updates);
  let failed = false;
  vi.spyOn(updates, "add").mockImplementation(((row: never) => {
    if (failed) return add(row);
    failed = true;
    return Promise.reject(new Error("UnknownError: Connection to Indexed Database server lost"));
  }) as never);
}

/** The note as storage has it, open or not: what a reload would read. */
async function stored(): Promise<Y.Doc> {
  const doc = new Y.Doc();
  for (const row of await db().updates.where("noteId").equals("n1").toArray()) {
    Y.applyUpdate(doc, row.data);
  }
  return doc;
}

/** The note as another device gets it: every update sent to the server. */
async function elsewhere(): Promise<Y.Doc> {
  const doc = new Y.Doc();
  for (const op of await db().outbox.where("kind").equals("update").toArray()) {
    Y.applyUpdate(doc, new Uint8Array((op.payload as { payload: ArrayBuffer }).payload));
  }
  return doc;
}

beforeEach(async () => {
  await resetLocalData();
  await db().notes.put(note("n1"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  // A test that stopped half way leaves the note open: closed, so that the
  // next one opens it afresh.
  while (openDoc("n1")) await releaseDoc("n1");
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

describe("an edit that could not be stored", () => {
  test("is kept, and stored with the next one, which builds on it", async () => {
    const doc = await acquireDoc("n1");
    doc.getText("t").insert(0, "一");
    failNextWrite();
    await expect(flushDoc("n1")).rejects.toThrow("Connection");
    expect(hasUnsavedEdits()).toBe(true);

    doc.getText("t").insert(1, "二");
    await flushDoc("n1");
    expect(hasUnsavedEdits()).toBe(false);
    expect((await stored()).getText("t").toString()).toBe("一二");
    expect((await elsewhere()).getText("t").toString()).toBe("一二");
    await releaseDoc("n1");
  });

  test("the quick note, saved again into the note a failed save made, is stored whole", async () => {
    // What the quick note's save does with the body, each time it is pressed.
    const save = async (lines: string[]) => {
      const doc = await acquireDoc("n1");
      try {
        const fragment = bodyFragment(doc);
        if (fragment.length > 0) doc.transact(() => fragment.delete(0, fragment.length));
        appendParagraphs(doc, lines);
      } finally {
        await releaseDoc("n1");
      }
    };
    failNextWrite();
    await expect(save(["本文"])).rejects.toThrow("Connection");
    // Still open, holding what it could not store, for the next save to find.
    const kept = openDoc("n1");
    expect(kept && extractText(kept)).toBe("本文");

    await save(["本文", "続き"]);
    expect(openDoc("n1")).toBeUndefined();
    // Read afresh, as a reload does, and as another device gets it from the server.
    for (const doc of [await stored(), await elsewhere()]) {
      expect(extractText(doc)).toBe("本文\n続き");
      expect(valid(doc)).toBe(true);
      expect(doc.store.pendingStructs).toBeNull();
    }
  });

  test("while the note closes, is stored by the close, not lost with the document", async () => {
    const doc = await acquireDoc("n1");
    doc.getText("t").insert(0, "閉じる前");
    failNextWrite();
    // The usual short wait is up and the write starts; the note closes meanwhile.
    const writing = flushDoc("n1");
    const closing = releaseDoc("n1");
    await expect(writing).rejects.toThrow("Connection");
    await closing;

    expect(openDoc("n1")).toBeUndefined();
    expect((await stored()).getText("t").toString()).toBe("閉じる前");
  });

  test("is not overtaken: an edit made while it was being written is stored with it, not before it", async () => {
    const doc = await acquireDoc("n1");
    doc.getText("t").insert(0, "一");
    failNextWrite();
    const first = flushDoc("n1");
    doc.getText("t").insert(1, "二");
    const second = flushDoc("n1");
    await expect(first).rejects.toThrow("Connection");
    await second;

    // Nothing is written after this: were the page to go now, storage alone has both.
    expect((await stored()).getText("t").toString()).toBe("一二");
    await releaseDoc("n1");
  });

  test("is stored and queued for the server together, or not at all", async () => {
    const doc = await acquireDoc("n1");
    doc.getText("t").insert(0, "一");
    vi.spyOn(db().outbox, "put").mockRejectedValueOnce(new Error("QuotaExceededError"));
    await expect(flushDoc("n1")).rejects.toThrow("QuotaExceededError");
    // Not stored without its place in the queue, which would keep it off the server for good.
    expect(await saved()).toBe(0);

    await flushDoc("n1");
    expect(await saved()).toBe(1);
    expect((await elsewhere()).getText("t").toString()).toBe("一");
    await releaseDoc("n1");
  });
});
