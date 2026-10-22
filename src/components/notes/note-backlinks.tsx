"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { Link2 } from "lucide-react";
import { db } from "@/lib/db";
import { justAbove, justBelow } from "@/lib/key-range";
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
    // Every note's body but this one's (its links to itself are not among
    // those shown), as the keys before it and after it: this note's own body
    // is written with every flush while it is typed in, twice with the
    // server's echo, and the whole table, read so, was read again each time.
    // See key-range for why not below() and above().
    const [before, after] = await Promise.all([
      database.bodies.where("noteId").belowOrEqual(justBelow(noteId)).toArray(),
      database.bodies.where("noteId").aboveOrEqual(justAbove(noteId)).toArray(),
    ]);
    const bodies = [...before, ...after].filter((body) => body.links?.includes(noteId) ?? false);
    const notes = await database.notes.bulkGet(bodies.map((body) => body.noteId));
    return notes
      .filter(
        (note) => note && note.noteId !== noteId && !note.deletedAt && !note.purged && !note.locked,
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
