"use client";

import { uuidv7 } from "uuidv7";
import { db } from "@/lib/db";
import type { SyncEngine } from "@/lib/sync/engine";
import { createNote, setNoteTrashed } from "@/lib/sync/mutations";
import type { StatusStore } from "@/lib/sync/status-store";

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

/** How long the Todo waits, on a device that has none, for the server's to come in. */
const WAIT_FOR_SERVER_MS = 4_000;

/**
 * The Todo's note, as the server has it, before an editor writes into it:
 * on a device that has none yet (newly signed in), the first sync waited
 * for (online, for a moment) in case the account has one; one here without
 * its body has its body fetched. Made only if there is none then. Written
 * into before the server's came, the device's own first line would be a
 * second list in the note, beside the server's, which the editor does not
 * show (joinTodoLists puts such lists together, should they meet).
 */
export async function readyTodo(
  status: StatusStore,
  engine: () => SyncEngine | null,
  gone: () => boolean,
): Promise<string> {
  const online = () => navigator.onLine !== false;
  const synced = () => {
    const now = status.get();
    return now.lastSyncAt !== null && !now.catchingUp;
  };
  const here = async () => {
    const own = await db().notes.get(TODO_NOTE_ID);
    if (own && !own.purged) return own;
    return db()
      .notes.filter((note) => !note.purged && note.noteId.startsWith(`${TODO_NOTE_ID}-`))
      .first();
  };
  const until = Date.now() + WAIT_FOR_SERVER_MS;
  let note = await here();
  while (!note && online() && !synced() && Date.now() < until && !gone()) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    note = await here();
  }
  if (note) await wholeBody(note.noteId, engine, gone);
  return ensureTodoNote();
}

/**
 * Waits (online, for a moment) for all of a note's body this device does
 * not have yet: every edit its row says the server has. An editor shown on
 * less writes its own first line into it, beside the server's, which then
 * comes in as a second list the editor does not show.
 */
export async function wholeBody(
  noteId: string,
  engine: () => SyncEngine | null,
  gone: () => boolean = () => false,
): Promise<void> {
  const online = () => navigator.onLine !== false;
  const whole = async () => {
    const [row, body] = await Promise.all([db().notes.get(noteId), db().bodies.get(noteId)]);
    if (!row) return true;
    if (row.lastUpdateSeq === 0 && row.snapshotSeq === 0) return true;
    return Boolean(body && body.keyEpoch === row.keyEpoch && body.throughSeq >= row.lastUpdateSeq);
  };
  const until = Date.now() + WAIT_FOR_SERVER_MS;
  if (!(await whole())) await engine()?.ensureBody(noteId).catch(() => undefined);
  while (!(await whole()) && online() && Date.now() < until && !gone()) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
