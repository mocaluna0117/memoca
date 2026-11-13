import "fake-indexeddb/auto";
import { beforeEach, expect, test } from "vitest";
import { db, resetLocalData } from "@/lib/db";
import { orderNotes } from "@/lib/note-order";
import { createFolder, createNote, moveNote, setFolderTrashed } from "@/lib/sync/mutations";
import { seedInbox } from "./helpers/seed";

beforeEach(async () => {
  await resetLocalData();
  await seedInbox();
});

/** A folder's notes, as placed by hand. */
async function placed(folderId: string) {
  const notes = await db().notes.where("folderId").equals(folderId).toArray();
  return orderNotes(notes, "manual").map((note) => note.noteId);
}

test("a note made in a folder goes first there, as the newest do by time", async () => {
  const folderId = await createFolder({ parentId: null, name: "仕事" });
  const first = await createNote({ folderId });
  const second = await createNote({ folderId });
  const third = await createNote({ folderId });
  expect(await placed(folderId)).toEqual([third, second, first]);
});

test("a note moved into a folder goes first there too", async () => {
  const from = await createFolder({ parentId: null, name: "受信" });
  const to = await createFolder({ parentId: null, name: "仕事" });
  const staying = await createNote({ folderId: to });
  const moving = await createNote({ folderId: from });
  await moveNote(moving, to);
  expect(await placed(to)).toEqual([moving, staying]);
});

test("a folder made while another is in the trash is not given that one's place: put back, the two are still apart", async () => {
  // The new one's key came after the last folder not in the trash, which
  // was the key the trashed one already had. Two with one key cannot be
  // placed between: a drop there, or Alt+↑, did nothing and said nothing.
  await createFolder({ parentId: null, name: "A" });
  const b = await createFolder({ parentId: null, name: "B" });
  await setFolderTrashed(b, true);
  const c = await createFolder({ parentId: null, name: "C" });
  await setFolderTrashed(b, false);
  const keyOf = async (folderId: string) => (await db().folders.get(folderId))!.sortKey;
  expect(await keyOf(c)).not.toBe(await keyOf(b));

  // In a folder, the same.
  const parent = await createFolder({ parentId: null, name: "親" });
  const first = await createFolder({ parentId: parent, name: "一" });
  await setFolderTrashed(first, true);
  const second = await createFolder({ parentId: parent, name: "二" });
  await setFolderTrashed(first, false);
  expect(await keyOf(second)).not.toBe(await keyOf(first));
});
