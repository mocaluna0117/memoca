"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { useDeferredValue, useEffect, useMemo, useSyncExternalStore } from "react";
import { db } from "@/lib/db";
import { useVaultUnlocked } from "@/lib/hooks/use-decrypted";
import { buildIndex, search, type SearchHit } from "@/lib/search/engine";
import { isKanaQuery, isYomiOn, onYomiOn, readingsForSearch } from "@/lib/search/yomi";
import { searchScope } from "@/lib/search/rows";
import { openTitles, useOpenedTitles } from "@/lib/vault/titles";

/**
 * Builds the search index from what this device already holds.
 *
 * Locked notes are searched by title only, and only while the vault is open;
 * their titles are opened in memory for it and dropped when the vault closes.
 */
export function useSearch(query: string): {
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

  const rows = useLiveQuery(async () => {
    const database = db();
    const [notes, folders, bodies] = await Promise.all([
      database.notes.toArray(),
      database.folders.toArray(),
      database.bodies.toArray(),
    ]);
    return { notes, folders, bodies };
  }, []);

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
