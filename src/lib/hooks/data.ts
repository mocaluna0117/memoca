"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { useMemo, useRef } from "react";
import { db } from "@/lib/db";
import { shareRow, shareRows } from "@/lib/hooks/share-rows";
import {
  buildTree,
  sortNotes,
  trashedFolderIds,
  visibleNotes,
} from "@/lib/tree";
import type { Folder, FolderNode, Note, Stamp } from "@/lib/types";
import { LOCKED_LABEL } from "@/lib/hooks/use-decrypted";
import { noteName } from "@/lib/note-name";
import { TEMPLATES_FOLDER_ID } from "@/lib/sync/mutations";
import { isHiddenNote } from "@/lib/quick/todo-id";

const EMPTY: never[] = [];

const noteKey = (note: Note) => note.noteId;
const folderKey = (folder: Folder) => folder.folderId;

/**
 * useLiveQuery over rows, with the rows that did not change given back as the
 * objects they were (see share-rows): a note typed in, written every flush,
 * leaves every other row as it was, and a result with nothing changed in it
 * does not render again at all.
 */
function useSharedRows<T>(
  querier: () => Promise<T[]>,
  deps: unknown[],
  keyOf: (row: T) => string,
  /**
   * Off, the rows are left as they were last read, and nothing is read: for
   * a list out of sight (the note list behind an open note on a phone),
   * which would otherwise read its whole table again with every write to it,
   * every flush of a note being typed in among them.
   */
  enabled = true,
): T[] {
  const last = useRef<T[] | undefined>(undefined);
  return useLiveQuery(
    async () => {
      if (!enabled) return last.current ?? (EMPTY as T[]);
      const rows = shareRows(last.current, await querier(), keyOf);
      last.current = rows;
      return rows;
    },
    [...deps, enabled],
    EMPTY as T[],
  );
}

/** The same for one row: the object it was while nothing in it changed. */
function useSharedRow<T>(querier: () => Promise<T>, deps: unknown[]): T | undefined {
  const last = useRef<T | undefined>(undefined);
  return useLiveQuery(
    async () => {
      const row = shareRow(last.current, await querier());
      last.current = row;
      return row;
    },
    deps,
  );
}

export function useFolders(): Folder[] {
  return useSharedRows(() => db().folders.toArray(), [], folderKey);
}

export function useFolderTree(): FolderNode[] {
  const folders = useFolders();
  return useMemo(() => buildTree(folders), [folders]);
}

/**
 * `undefined` while loading, `null` when there is genuinely no such row.
 *
 * Dexie keeps returning the previous result while a re-query runs, so switching
 * folders hands back the old row for a frame. Callers derive editable state
 * from these rows, so a stale one has to read as "not loaded yet" rather than
 * as the new folder's data.
 */
export function useFolder(folderId: string | null): Folder | null | undefined {
  const row = useSharedRow(
    async () => (folderId ? ((await db().folders.get(folderId)) ?? null) : null),
    [folderId],
  );
  if (row === undefined) return undefined;
  if (row === null) return null;
  return row.folderId === folderId ? row : undefined;
}

export type NoteScope =
  | { kind: "all" }
  | { kind: "folder"; folderId: string }
  | { kind: "pinned" };

/** Notes for the middle pane, with trashed subtrees filtered out; `enabled` off, as last read (see useSharedRows). */
export function useNotes(scope: NoteScope, enabled = true): Note[] {
  const folders = useFolders();
  const trashed = useMemo(() => trashedFolderIds(folders), [folders]);

  const notes = useSharedRows(
    () =>
      scope.kind === "folder"
        ? db().notes.where("folderId").equals(scope.folderId).toArray()
        : db().notes.toArray(),
    [scope.kind, scope.kind === "folder" ? scope.folderId : ""],
    noteKey,
    enabled,
  );

  return useMemo(() => {
    // Templates are not notes of their own: only in their folder.
    const live = visibleNotes(notes, trashed).filter(
      (n) => scope.kind === "folder" || n.folderId !== TEMPLATES_FOLDER_ID,
    );
    const filtered = scope.kind === "pinned" ? live.filter((n) => n.pinned) : live;
    return sortNotes(filtered);
  }, [notes, trashed, scope.kind]);
}

/**
 * The notes kept at the top level, in no folder, which the sidebar shows
 * among the folders: not trashed, in no particular order (the sidebar orders
 * them with the folders).
 */
export function useTopLevelNotes(): Note[] {
  // All of them read at once, and those in no folder kept: a note in none
  // has no key in the folderId index to be found by (null is none), and
  // read through `filter`, one by one, the whole table was walked a row at
  // a time with every write to it, twice a second as a note was typed in.
  const notes = useSharedRows(
    async () =>
      (await db().notes.toArray()).filter(
        (note) => note.folderId === null && !isHiddenNote(note.noteId),
      ),
    [],
    noteKey,
  );
  return useMemo(() => notes.filter((note) => !note.purged && note.deletedAt === null), [notes]);
}

/**
 * Every folder's notes, by its id, not trashed, in no particular order: for
 * the sidebar's tree, which shows them inside their folders. Nothing while
 * `enabled` is not set, the tree showing none.
 */
export function useNotesByFolder(enabled: boolean): ReadonlyMap<string, Note[]> {
  const notes = useSharedRows(
    // Read at once, as useTopLevelNotes: not walked a row at a time.
    async () =>
      enabled
        ? (await db().notes.toArray()).filter(
            (note) => note.folderId !== null && !note.purged && note.deletedAt === null,
          )
        : [],
    [enabled],
    noteKey,
  );
  return useMemo(() => {
    const byFolder = new Map<string, Note[]>();
    for (const note of notes) {
      const bucket = byFolder.get(note.folderId!) ?? [];
      bucket.push(note);
      byFolder.set(note.folderId!, bucket);
    }
    return byFolder;
  }, [notes]);
}

/** The templates, by their titles: the readable notes of the folder of them. */
export function useTemplates(): Note[] {
  const notes = useSharedRows(
    () => db().notes.where("folderId").equals(TEMPLATES_FOLDER_ID).toArray(),
    [],
    noteKey,
  );
  return useMemo(
    () =>
      notes
        .filter((note) => !note.locked && note.deletedAt === null && !note.purged)
        .sort((a, b) => (a.title ?? "").localeCompare(b.title ?? "", "ja")),
    [notes],
  );
}

/** See {@link useFolder}: never return another note's row for this id. */
export function useNote(noteId: string | null): Note | null | undefined {
  const row = useSharedRow(
    async () => (noteId ? ((await db().notes.get(noteId)) ?? null) : null),
    [noteId],
  );
  if (row === undefined) return undefined;
  if (row === null) return null;
  return row.noteId === noteId ? row : undefined;
}

/**
 * The folder a note is in (null: none, kept at the top level), and nothing
 * else of it: undefined while it is read, or with no such note. Drawn again
 * only as the note moves, not with each flush of it being typed in (its
 * first line and when it changed are written then).
 */
export function useNoteFolder(noteId: string | null): string | null | undefined {
  // As one string, with the note it is of: a value compared as it is, so a
  // flush that leaves it as it was draws nothing again; and one read for
  // the note before (as the query reads anew for another) is not taken for
  // this one's.
  const found = useLiveQuery(async () => {
    if (!noteId) return undefined;
    const note = await db().notes.get(noteId);
    return note ? `${noteId}\n${note.folderId ?? ""}` : undefined;
  }, [noteId]);
  if (!found || !noteId) return undefined;
  const [of, folderId] = found.split("\n");
  if (of !== noteId) return undefined;
  return folderId || null;
}

export function useNoteText(noteId: string | null): string | null {
  const body = useLiveQuery(
    async () => (noteId ? await db().bodies.get(noteId) : undefined),
    [noteId],
  );
  return body && body.noteId === noteId ? (body.text ?? null) : null;
}

export type TrashEntry =
  | {
      kind: "folder";
      id: string;
      label: string;
      deletedAt: number;
      /** When this device put it in the trash, which a purge sends with it. */
      trashedAt: Stamp;
      locked: boolean;
    }
  | {
      kind: "note";
      id: string;
      label: string;
      /** The label is the note's first line standing in for a title, or 無題のメモ. */
      standIn: boolean;
      deletedAt: number;
      trashedAt: Stamp;
      locked: boolean;
    };

/**
 * The trash lists only what was deleted directly. Items that merely sit inside
 * a deleted folder are shown by expanding that folder, which matches how
 * restoring behaves.
 */
export function useTrash(): TrashEntry[] {
  const folders = useFolders();
  const notes = useSharedRows(
    async () => (await db().notes.toArray()).filter((note) => !isHiddenNote(note.noteId)),
    [],
    noteKey,
  );

  return useMemo(() => {
    const byId = new Map(folders.map((f) => [f.folderId, f]));
    const ancestorTrashed = (parentId: string | null): boolean => {
      let current = parentId;
      for (let depth = 0; current && depth < 64; depth += 1) {
        const folder = byId.get(current);
        if (!folder) return false;
        if (folder.deletedAt !== null) return true;
        current = folder.parentId;
      }
      return false;
    };

    const entries: TrashEntry[] = [];
    for (const folder of folders) {
      if (folder.purged || folder.deletedAt === null) continue;
      if (ancestorTrashed(folder.parentId)) continue;
      entries.push({
        kind: "folder",
        id: folder.folderId,
        label: folder.name ?? "ロックされたフォルダ",
        deletedAt: folder.deletedAt,
        trashedAt: folder.ts.trash,
        locked: folder.locked,
      });
    }
    for (const note of notes) {
      if (note.purged || note.deletedAt === null) continue;
      if (ancestorTrashed(note.folderId)) continue;
      const name = note.locked
        ? { text: LOCKED_LABEL, standIn: false }
        : noteName(note.title, note.preview);
      entries.push({
        kind: "note",
        id: note.noteId,
        label: name.text,
        standIn: name.standIn,
        deletedAt: note.deletedAt,
        trashedAt: note.ts.trash,
        locked: note.locked,
      });
    }
    return entries.sort((a, b) => b.deletedAt - a.deletedAt);
  }, [folders, notes]);
}

/** The edits waiting to be sent: not those set aside as ones the server will not take. */
export function useOutboxCount(): number {
  return useLiveQuery(() => db().outbox.filter((entry) => entry.stuck === undefined).count(), [], 0);
}
