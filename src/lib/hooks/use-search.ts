"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { useDeferredValue, useEffect, useMemo } from "react";
import { db } from "@/lib/db";
import { useVaultUnlocked } from "@/lib/hooks/use-decrypted";
import { buildIndex, search, type SearchHit } from "@/lib/search/engine";
import { isKanaQuery, readingsForSearch } from "@/lib/search/yomi";
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

  // Searched for in kana: the readings of notes written since the last such
  // search worked out now, with reading search on and the dictionary at hand
  // (kept, or in memory), and found as they are (the rows follow the
  // database). Only then: the dictionary is loaded for searching, not kept
  // busy in the background.
  const kana = isKanaQuery(deferred);
  useEffect(() => {
    if (kana) void readingsForSearch();
  }, [kana]);

  const scope = useMemo(
    () =>
      rows
        ? searchScope(rows.notes, rows.folders, rows.bodies, { open: unlocked, titles })
        : { rows: [], locked: 0 },
    [rows, unlocked, titles],
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
