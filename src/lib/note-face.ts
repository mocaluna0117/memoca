import type { Note } from "@/lib/types";

/**
 * Whether two states of a note look the same in a row of a list or of the
 * sidebar's tree: what the row shows (its name, first line, pin, lock) and
 * what the row's actions take from it (its folder, its key epoch). Not what
 * the sync keeps on it as it goes (`lastUpdateSeq` with every echo of an
 * edit sent, `seq`, `snapshotSeq`, `refsThroughSeq`, `updatedAt`, the other
 * stamps): changed with every flush of a note being typed in, those made the
 * note a new object, and its row drawn again, though nothing of it had
 * changed to the eye. (`updatedAt` reaches the row as the time it says,
 * already made into words.)
 */
export function sameNoteFace(a: Note, b: Note): boolean {
  return (
    a === b ||
    (a.noteId === b.noteId &&
      a.folderId === b.folderId &&
      a.kind === b.kind &&
      a.title === b.title &&
      a.preview === b.preview &&
      a.pinned === b.pinned &&
      a.pinKey === b.pinKey &&
      a.sortKey === b.sortKey &&
      a.locked === b.locked &&
      a.keyEpoch === b.keyEpoch &&
      a.deletedAt === b.deletedAt &&
      a.ts.title.t === b.ts.title.t &&
      a.ts.title.d === b.ts.title.d)
  );
}

/**
 * Whether a row's props say the same, its note by its face (above) and
 * everything else as it is: for React.memo on a row.
 */
export function sameRowProps<T extends { note: Note }>(
  prev: T,
  next: T,
  same: Partial<{ [K in keyof T]: (a: T[K], b: T[K]) => boolean }> = {},
): boolean {
  for (const key of new Set([...Object.keys(prev), ...Object.keys(next)]) as Set<keyof T>) {
    const a = prev[key];
    const b = next[key];
    if (key === "note") {
      if (!sameNoteFace(a as Note, b as Note)) return false;
      continue;
    }
    const compare = same[key];
    if (compare ? !compare(a, b) : a !== b) return false;
  }
  return true;
}
