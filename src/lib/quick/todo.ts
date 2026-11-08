"use client";

import { uuidv7 } from "uuidv7";
import { db } from "@/lib/db";
import { createNote, setNoteTrashed } from "@/lib/sync/mutations";

import { TODO_NOTE_ID } from "@/lib/quick/todo-id";

export { TODO_NOTE_ID, TODO_TAB_ID, isQuickTodo } from "@/lib/quick/todo-id";

/**
 * The Todo's note, made if this device has none yet (the other devices'
 * comes in as it syncs, and is the same note), at the top level, with no
 * title. One in the trash is taken out of it; one deleted for good leaves
 * its id spent, and the next has an id of its own after it.
 */
export async function ensureTodoNote(): Promise<string> {
  const notes = db().notes;
  const own = await notes.get(TODO_NOTE_ID);
  if (own && !own.purged && own.deletedAt === null) return own.noteId;
  if (own && !own.purged) {
    await setNoteTrashed(own.noteId, false);
    return own.noteId;
  }
  const again = await notes
    .filter((note) => !note.purged && note.noteId.startsWith(`${TODO_NOTE_ID}-`))
    .first();
  if (again) {
    if (again.deletedAt !== null) await setNoteTrashed(again.noteId, false);
    return again.noteId;
  }
  const noteId = own?.purged ? `${TODO_NOTE_ID}-${uuidv7().slice(-8)}` : TODO_NOTE_ID;
  await createNote({ folderId: null, topLevel: true, title: "", kind: "note", noteId });
  return noteId;
}
