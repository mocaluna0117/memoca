import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, expect, test } from "vitest";
import { MemocaDb } from "@/lib/db";

const NAME = "memoca-upgrade-test";

afterEach(() => Dexie.delete(NAME));

test("the days' notes' folder a device has (今日のメモ, since taken out) is any other folder", async () => {
  // The database as an app with 今日のメモ left it.
  const before = new Dexie(NAME);
  before.version(2).stores({
    folders: "folderId, parentId, deletedAt, system, seq",
    notes: "noteId, folderId, deletedAt, updatedAt, locked, kind, seq",
    updates: "++localId, noteId, opId, [noteId+pushed], pushed, seq",
    snapshots: "noteId",
    bodies: "noteId, *links",
    attachments: "attachmentId, noteId, status",
    pendingUploads: "attachmentId, noteId",
    blobs: "attachmentId, lastUsed",
    outbox: "opId, createdAt, kind",
    meta: "key",
  });
  await before.table("folders").bulkPut([
    { folderId: "journal", parentId: null, name: "日記", system: "journal", seq: 3 },
    { folderId: "inbox", parentId: null, name: "Inbox", system: "inbox", seq: 1 },
    { folderId: "templates", parentId: null, name: "テンプレート", system: "templates", seq: 2 },
  ]);
  await before.table("notes").put({ noteId: "journal-2026-10-23", folderId: "journal", title: "2026年10月23日（金）" });
  before.close();

  const after = new MemocaDb(NAME);
  try {
    const folders = Object.fromEntries((await after.folders.toArray()).map((f) => [f.folderId, f]));
    expect(folders.journal).toMatchObject({ name: "日記", system: null, seq: 3 });
    expect(folders.inbox?.system).toBe("inbox");
    expect(folders.templates?.system).toBe("templates");
    // Its notes stay where they are.
    expect(await after.notes.get("journal-2026-10-23")).toMatchObject({ folderId: "journal" });
  } finally {
    after.close();
  }
});
