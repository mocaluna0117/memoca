"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { useDeferredValue, useMemo } from "react";
import { db } from "@/lib/db";
import { useVaultUnlocked } from "@/lib/hooks/use-decrypted";
import { buildIndex, search, type SearchHit } from "@/lib/search/engine";
import { trashedFolderIds } from "@/lib/tree";

/**
 * Builds the search index from what this device already holds.
 *
 * Locked notes contribute their title only, and only while the vault is open;
 * their body text is never written to disk in the clear, so there is nothing
 * to index when the vault is closed.
 */
export function useSearch(query: string): { hits: SearchHit[]; total: number } {
  const unlocked = useVaultUnlocked();
  const deferred = useDeferredValue(query);

  const rows = useLiveQuery(async () => {
    const database = db();
    const [notes, folders, bodies] = await Promise.all([
      database.notes.toArray(),
      database.folders.toArray(),
      database.bodies.toArray(),
    ]);
    return { notes, folders, bodies };
  }, []);

  const index = useMemo(() => {
    if (!rows) return [];
    const trashed = trashedFolderIds(rows.folders);
    const folderName = new Map(
      rows.folders.map((f) => [f.folderId, f.name ?? ""]),
    );
    const text = new Map(rows.bodies.map((b) => [b.noteId, b.text]));
    const reading = new Map(rows.bodies.map((b) => [b.noteId, b.reading ?? null]));

    return buildIndex(
      rows.notes
        .filter(
          (note) =>
            !note.purged &&
            note.deletedAt === null &&
            (note.folderId === null || !trashed.has(note.folderId)),
        )
        .map((note) => ({
          noteId: note.noteId,
          folderId: note.folderId,
          title: note.locked ? "ロックされたメモ" : (note.title ?? ""),
          body: note.locked && !unlocked ? null : (text.get(note.noteId) ?? null),
          folderName: note.folderId ? (folderName.get(note.folderId) ?? "") : "",
          locked: note.locked,
          updatedAt: note.updatedAt,
          reading: note.locked && !unlocked ? null : (reading.get(note.noteId) ?? null),
        })),
    );
  }, [rows, unlocked]);

  return useMemo(
    () => ({ hits: search(index, deferred), total: index.length }),
    [index, deferred],
  );
}
