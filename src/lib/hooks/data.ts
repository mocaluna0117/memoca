"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { useMemo } from "react";
import { db } from "@/lib/db";
import {
  buildTree,
  sortNotes,
  trashedFolderIds,
  visibleNotes,
} from "@/lib/tree";
import type { Folder, FolderNode, Note } from "@/lib/types";

const EMPTY: never[] = [];

export function useFolders(): Folder[] {
  return useLiveQuery(() => db().folders.toArray(), [], EMPTY as Folder[]);
}

export function useFolderTree(): FolderNode[] {
  const folders = useFolders();
  return useMemo(() => buildTree(folders), [folders]);
}

export function useFolder(folderId: string | null): Folder | undefined {
  return useLiveQuery(
    async () => (folderId ? await db().folders.get(folderId) : undefined),
    [folderId],
  );
}

export type NoteScope =
  | { kind: "all" }
  | { kind: "folder"; folderId: string }
  | { kind: "pinned" };

/** Notes for the middle pane, with trashed subtrees filtered out. */
export function useNotes(scope: NoteScope): Note[] {
  const folders = useFolders();
  const trashed = useMemo(() => trashedFolderIds(folders), [folders]);

  const notes = useLiveQuery(
    () =>
      scope.kind === "folder"
        ? db().notes.where("folderId").equals(scope.folderId).toArray()
        : db().notes.toArray(),
    [scope.kind, scope.kind === "folder" ? scope.folderId : ""],
    EMPTY as Note[],
  );

  return useMemo(() => {
    const live = visibleNotes(notes, trashed);
    const filtered = scope.kind === "pinned" ? live.filter((n) => n.pinned) : live;
    return sortNotes(filtered);
  }, [notes, trashed, scope.kind]);
}

export function useNote(noteId: string | null): Note | undefined {
  return useLiveQuery(
    async () => (noteId ? await db().notes.get(noteId) : undefined),
    [noteId],
  );
}

export function useNoteText(noteId: string | null): string | null {
  const body = useLiveQuery(
    async () => (noteId ? await db().bodies.get(noteId) : undefined),
    [noteId],
  );
  return body?.text ?? null;
}

export type TrashEntry =
  | { kind: "folder"; id: string; label: string; deletedAt: number; locked: boolean }
  | { kind: "note"; id: string; label: string; deletedAt: number; locked: boolean };

/**
 * The trash lists only what was deleted directly. Items that merely sit inside
 * a deleted folder are shown by expanding that folder, which matches how
 * restoring behaves.
 */
export function useTrash(): TrashEntry[] {
  const folders = useFolders();
  const notes = useLiveQuery(() => db().notes.toArray(), [], EMPTY as Note[]);

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
        label: folder.name ?? "🔒 ロック中のフォルダ",
        deletedAt: folder.deletedAt,
        locked: folder.locked,
      });
    }
    for (const note of notes) {
      if (note.purged || note.deletedAt === null) continue;
      if (ancestorTrashed(note.folderId)) continue;
      entries.push({
        kind: "note",
        id: note.noteId,
        label: note.locked ? "🔒 ロック中のメモ" : note.title || "無題のメモ",
        deletedAt: note.deletedAt,
        locked: note.locked,
      });
    }
    return entries.sort((a, b) => b.deletedAt - a.deletedAt);
  }, [folders, notes]);
}

export function useOutboxCount(): number {
  return useLiveQuery(() => db().outbox.count(), [], 0);
}
