import "fake-indexeddb/auto";
import { beforeEach, describe, expect, test } from "vitest";
import { db, resetLocalData } from "@/lib/db";
import {
  adoptFolderlessNotes,
  createFolder,
  createNote,
  inboxFolderId,
  moveNote,
  setFolderTrashed,
  setNoteTrashed,
} from "@/lib/sync/mutations";
import { seedInbox } from "./helpers/seed";

/** The server operations queued for one note, oldest first. */
async function placeOps(noteId: string) {
  const ops = await db().outbox.orderBy("createdAt").toArray();
  return ops
    .filter((op) => op.entityId === noteId)
    .map((op) => (op.payload as { place?: { folderId: string | null } }).place)
    .filter(Boolean);
}

beforeEach(async () => {
  await resetLocalData();
});

describe("Inbox is the home for unfiled notes", () => {
  test("a note created with no folder goes into Inbox", async () => {
    const inbox = await seedInbox();
    const noteId = await createNote({ folderId: null });
    expect((await db().notes.get(noteId))?.folderId).toBe(inbox);
    // The server has to be told the same thing, not just this device.
    expect((await placeOps(noteId)).at(-1)?.folderId).toBe(inbox);
  });

  test("a note created inside a folder stays in that folder", async () => {
    await seedInbox();
    const folderId = await createFolder({ parentId: null, name: "仕事" });
    const noteId = await createNote({ folderId });
    expect((await db().notes.get(noteId))?.folderId).toBe(folderId);
  });

  test("moving a note to no folder files it in Inbox", async () => {
    const inbox = await seedInbox();
    const folderId = await createFolder({ parentId: null, name: "仕事" });
    const noteId = await createNote({ folderId });
    await moveNote(noteId, null);
    expect((await db().notes.get(noteId))?.folderId).toBe(inbox);
  });

  test("before Inbox has synced, a new note waits with no folder", async () => {
    // A fresh device offline on first launch has no Inbox yet. The note must
    // still be created, and is filed as soon as Inbox arrives.
    const noteId = await createNote({ folderId: null });
    expect((await db().notes.get(noteId))?.folderId).toBeNull();

    const inbox = await seedInbox();
    expect(await adoptFolderlessNotes()).toBe(1);
    expect((await db().notes.get(noteId))?.folderId).toBe(inbox);
  });

  test("existing folderless notes are filed, and only those", async () => {
    const inbox = await seedInbox();
    const folderId = await createFolder({ parentId: null, name: "仕事" });
    const filed = await createNote({ folderId });
    // Written by an older version, which left notes with no folder.
    const orphan = "orphan";
    const template = (await db().notes.get(filed))!;
    await db().notes.put({ ...template, noteId: orphan, folderId: null });

    expect(await adoptFolderlessNotes()).toBe(1);
    expect((await db().notes.get(orphan))?.folderId).toBe(inbox);
    expect((await db().notes.get(filed))?.folderId).toBe(folderId);
    // A second pass finds nothing left to do.
    expect(await adoptFolderlessNotes()).toBe(0);
  });

  test("restoring a note whose folder is still trashed brings it to Inbox", async () => {
    const inbox = await seedInbox();
    const folderId = await createFolder({ parentId: null, name: "旧フォルダ" });
    const noteId = await createNote({ folderId });
    await setNoteTrashed(noteId, true);
    await setFolderTrashed(folderId, true);

    await setNoteTrashed(noteId, false);
    expect((await db().notes.get(noteId))?.folderId).toBe(inbox);
  });

  test("the Inbox lookup ignores a purged Inbox", async () => {
    await seedInbox();
    await db().folders.update("inbox", { purged: true });
    expect(await inboxFolderId()).toBeNull();
  });

  test("moving a note where it already is queues nothing", async () => {
    await seedInbox();
    const noteId = await createNote({ folderId: null });
    const before = (await placeOps(noteId)).length;
    await moveNote(noteId, null);
    expect((await placeOps(noteId)).length).toBe(before);
  });
});
