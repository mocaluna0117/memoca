"use client";

import { isHiddenNote } from "@/lib/quick/todo-id";
import { useLiveQuery } from "dexie-react-hooks";
import { Link2 } from "lucide-react";
import { db } from "@/lib/db";
import { useWorkspace } from "@/lib/hooks/workspace";
import { noteName } from "@/lib/note-name";

/**
 * このメモへのリンク: the notes whose text links to this one (lib/note-links),
 * under it, each opened at a click. As this device knows their text: a note
 * locked, or whose text has not reached it yet, is not among them.
 */
export function NoteBacklinks({ noteId }: { noteId: string }) {
  const { openNote } = useWorkspace();
  const linking = useLiveQuery(async () => {
    const database = db();
    // By the index of what each body links to: only the bodies linking here
    // are read, and the query runs again only when one of them is written,
    // not with every flush of any note being typed in (which, with every
    // body read, it did).
    const linkers = await database.bodies.where("links").equals(noteId).primaryKeys();
    const notes = await database.notes.bulkGet(linkers.filter((id) => id !== noteId));
    return notes
      .filter(
        (note) =>
          note &&
          note.noteId !== noteId &&
          !note.deletedAt &&
          !note.purged &&
          !note.locked &&
          // A quick note's tab, not saved: not a note of the lists.
          !isHiddenNote(note.noteId),
      )
      .map((note) => ({ noteId: note!.noteId, name: noteName(note!.title, note!.preview).text }))
      .sort((a, b) => a.name.localeCompare(b.name, "ja"));
  }, [noteId]);
  if (!linking || linking.length === 0) return null;

  return (
    <section
      aria-label="このメモへのリンク"
      className="mx-4 mt-6 mb-10 border-t pt-4 sm:mx-[3.4rem]"
    >
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Link2 className="size-3.5" aria-hidden />
        このメモへのリンク（{linking.length}）
      </h2>
      <ul className="space-y-0.5">
        {linking.map((note) => (
          <li key={note.noteId}>
            <button
              type="button"
              onClick={() => openNote(note.noteId)}
              className="w-full truncate rounded-md px-2 py-1 text-left text-sm hover:bg-accent"
            >
              {note.name}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
