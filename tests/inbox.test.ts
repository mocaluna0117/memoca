import "fake-indexeddb/auto";
import { beforeEach, describe, expect, test } from "vitest";
import { db, resetLocalData } from "@/lib/db";
import {
  createFolder,
  createNote,
  inboxFolderId,
  moveNote,
  setFolderTrashed,
  setNoteTrashed,
  topLevelKeys,
  fileAwaitingInbox,
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

  test("moving a note to no folder keeps it at the top level, after what is there", async () => {
    await seedInbox();
    const folderId = await createFolder({ parentId: null, name: "仕事" });
    const noteId = await createNote({ folderId });
    await moveNote(noteId, null);
    const note = (await db().notes.get(noteId))!;
    expect(note.folderId).toBeNull();
    const folder = (await db().folders.get(folderId))!;
    expect(note.sortKey > folder.sortKey).toBe(true);
    expect((await placeOps(noteId)).at(-1)?.folderId).toBeNull();
  });

  test("a note made at the top level stays there, among the folders, after the last", async () => {
    await seedInbox();
    const first = await createFolder({ parentId: null, name: "仕事" });
    const noteId = await createNote({ folderId: null, topLevel: true });
    const later = await createFolder({ parentId: null, name: "趣味" });
    const note = (await db().notes.get(noteId))!;
    expect(note.folderId).toBeNull();
    expect(note.sortKey > (await db().folders.get(first))!.sortKey).toBe(true);
    // A folder made after it goes after it too: one order.
    expect((await db().folders.get(later))!.sortKey > note.sortKey).toBe(true);
    expect((await topLevelKeys()).length).toBe(3);
  });

  test("before Inbox has synced, a new note waits at the top level, and is filed once Inbox arrives", async () => {
    // A fresh device (a new account's first note) has no Inbox yet. The
    // note must still be created, and goes to Inbox as soon as it is here.
    const noteId = await createNote({ folderId: null });
    // Made for the sidebar on purpose: not filed.
    const kept = await createNote({ folderId: null, topLevel: true });
    // Made for Inbox too, then put in a folder by hand meanwhile: left there.
    const moved = await createNote({ folderId: null });
    expect((await db().notes.get(noteId))?.folderId).toBeNull();
    expect(await fileAwaitingInbox()).toBe(0);

    const inbox = await seedInbox();
    const folderId = await createFolder({ parentId: null, name: "仕事" });
    await moveNote(moved, folderId);
    expect(await fileAwaitingInbox()).toBe(1);
    expect((await db().notes.get(noteId))?.folderId).toBe(inbox);
    expect((await db().notes.get(kept))?.folderId).toBeNull();
    expect((await db().notes.get(moved))?.folderId).toBe(folderId);
    // Once is enough.
    await moveNote(noteId, null);
    expect(await fileAwaitingInbox()).toBe(0);
    expect((await db().notes.get(noteId))?.folderId).toBeNull();
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
    const inbox = await seedInbox();
    const noteId = await createNote({ folderId: null });
    const before = (await placeOps(noteId)).length;
    await moveNote(noteId, inbox);
    expect((await placeOps(noteId)).length).toBe(before);
    // Nor one at the top level moved to the top level.
    const top = await createNote({ folderId: null, topLevel: true });
    const already = (await placeOps(top)).length;
    await moveNote(top, null);
    expect((await placeOps(top)).length).toBe(already);
  });
});
