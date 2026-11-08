import "fake-indexeddb/auto";
import { beforeEach, expect, test } from "vitest";
import { db, resetLocalData } from "@/lib/db";
import { moveFolder, moveNote, renameFolder, renameNote } from "@/lib/sync/mutations";
import type { Folder, Note } from "@/lib/types";
import { zero } from "./helpers/seed";

const note = (noteId: string): Note => ({
  noteId,
  folderId: "f1",
  kind: "note",
  title: "メモ",
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
  seq: 1,
  updatedAt: 0,
});

const folder = (folderId: string): Folder =>
  ({
    folderId,
    parentId: null,
    name: folderId,
    icon: null,
    system: null,
    sortKey: "a",
    locked: false,
    deletedAt: null,
    purged: false,
    ts: { name: zero, place: zero, trash: zero, lock: zero },
    seq: 1,
  }) as unknown as Folder;

beforeEach(async () => {
  await resetLocalData();
  await db().folders.bulkPut([folder("f1"), folder("f2")]);
  await db().notes.put(note("n1"));
});

// Each write stamps its own field only. Written with the whole `ts` as read
// before the write, the one that lands second put the first's stamp back to
// what it was: a remote edit the server will overrule could then replace a
// pending local one here, until the push's echo set it right.
test("a note renamed and moved at the same moment keeps both stamps", async () => {
  await Promise.all([renameNote("n1", "新しい名前"), moveNote("n1", "f2")]);
  const row = (await db().notes.get("n1"))!;
  expect(row.title).toBe("新しい名前");
  expect(row.folderId).toBe("f2");
  expect(row.ts.title.t).toBeGreaterThan(0);
  expect(row.ts.place.t).toBeGreaterThan(0);
});

test("a folder renamed and moved at the same moment keeps both stamps", async () => {
  await Promise.all([renameFolder("f1", "名前"), moveFolder("f1", "f2")]);
  const row = (await db().folders.get("f1"))!;
  expect(row.name).toBe("名前");
  expect(row.parentId).toBe("f2");
  expect(row.ts.name.t).toBeGreaterThan(0);
  expect(row.ts.place.t).toBeGreaterThan(0);
});
