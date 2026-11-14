"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { isHiddenNote } from "@/lib/quick/todo-id";
import { useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { db, type BodyState } from "@/lib/db";
import type { Folder, Note } from "@/lib/types";
import { usePageShown } from "@/lib/hooks/use-page-shown";
import { useVaultUnlocked } from "@/lib/hooks/use-decrypted";
import { buildIndex, search, type SearchHit } from "@/lib/search/engine";
import { isKanaQuery, isYomiOn, onYomiOn, readingsForSearch } from "@/lib/search/yomi";
import { searchScope } from "@/lib/search/rows";
import { openTitles, useOpenedTitles } from "@/lib/vault/titles";

/** What the index is built from. */
type SearchRows = { notes: Note[]; folders: Folder[]; bodies: BodyState[] };

/**
 * Builds the search index from what this device already holds.
 *
 * Locked notes are searched by title only, and only while the vault is open;
 * their titles are opened in memory for it and dropped when the vault closes.
 *
 * Not `enabled`, it reads nothing and finds nothing: the index is every note
 * and body on the device, read and built again whenever one is written, which
 * typing in a note does every half second. The palette is open for a moment
 * at a time; its index is built then.
 */
export function useSearch(
  query: string,
  { enabled = true }: { enabled?: boolean } = {},
): {
  hits: SearchHit[];
  total: number;
  /** Locked notes, and whether the vault is open to search them by title. */
  locked: { count: number; open: boolean };
} {
  const unlocked = useVaultUnlocked();
  const titles = useOpenedTitles();
  const deferred = useDeferredValue(query);
  // Notes are found by their readings only with reading search turned on.
  const readings = useSyncExternalStore(onYomiOn, isYomiOn, () => false);

  // Dexie runs the query again only on writes to the tables it read: read
  // none, it is left alone until the search is enabled. Nor while the page
  // is out of sight (the search page left open in a window put away, which
  // read every note and built the index again with each note written),
  // once it has read them: what it found then is kept, and it catches up as
  // it is shown again.
  const shown = usePageShown();
  const last = useRef<SearchRows | null>(null);
  const [readOnce, setReadOnce] = useState(false);
  const reads = enabled && (shown || !readOnce);
  const rows = useLiveQuery(async (): Promise<SearchRows | null> => {
    if (!enabled) return null;
    if (!reads) return last.current;
    const database = db();
    const [notes, folders, bodies] = await Promise.all([
      database.notes.toArray(),
      database.folders.toArray(),
      database.bodies.toArray(),
    ]);
    // The quick note's Todo is not a note to be found (lib/quick/todo).
    const found = { notes: notes.filter((note) => !isHiddenNote(note.noteId)), folders, bodies };
    last.current = found;
    setReadOnce(true);
    return found;
  }, [enabled, reads]);

  useEffect(() => {
    if (unlocked && rows) void openTitles(rows.notes);
  }, [rows, unlocked]);

  // Searched for in kana with reading search on: the readings of notes written
  // since worked out now, and found as they are (the rows follow the
  // database). Only then: the dictionary is loaded for searching, not kept
  // busy in the background.
  const kana = isKanaQuery(deferred);
  useEffect(() => {
    if (kana && readings) void readingsForSearch();
  }, [kana, readings]);

  const scope = useMemo(
    () =>
      rows
        ? searchScope(
            rows.notes,
            rows.folders,
            readings ? rows.bodies : rows.bodies.map((body) => ({ ...body, reading: undefined })),
            { open: unlocked, titles },
          )
        : { rows: [], locked: 0 },
    [rows, unlocked, titles, readings],
  );
  const index = useMemo(() => buildIndex(scope.rows), [scope]);

  return useMemo(
    () => ({
      hits: search(index, deferred),
      total: index.length,
      locked: { count: scope.locked, open: unlocked },
    }),
    [index, deferred, scope.locked, unlocked],
  );
}
