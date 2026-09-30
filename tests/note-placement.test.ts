import "fake-indexeddb/auto";
import { beforeEach, expect, test } from "vitest";
import { db, resetLocalData } from "@/lib/db";
import { orderNotes } from "@/lib/note-order";
import { createFolder, createNote, moveNote } from "@/lib/sync/mutations";
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
