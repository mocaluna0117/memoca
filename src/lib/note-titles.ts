/**
 * Notes of one folder have names of their own, as files in a folder do: one
 * given a name another there has already is numbered, 会議 (2), 会議 (3), as
 * Finder and Explorer number a copy. Notes with no title (whose first line
 * stands in for one) are not named, and locked ones' names cannot be read:
 * neither is held to this.
 */

/** A name as it is compared: blanks round it, width and case making no difference. */
export function titleKey(title: string): string {
  return title.normalize("NFKC").trim().toLowerCase();
}

/** A number put after a name, as this numbers one: 会議 (2). */
const NUMBERED = /^(.*?)\s*\((\d+)\)$/;

/**
 * `title`, if no name in `taken` (by {@link titleKey}) is it; otherwise the
 * first of it numbered from 2 that none is. A name numbered already is
 * numbered on from what it was numbered after: 会議 (2) taken, 会議 (3).
 */
export function freeTitle(title: string, taken: ReadonlySet<string>): string {
  const trimmed = title.trim();
  if (!taken.has(titleKey(trimmed))) return trimmed;
  const base = NUMBERED.exec(trimmed)?.[1]?.trim() || trimmed;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} (${n})`;
    if (!taken.has(titleKey(candidate))) return candidate;
  }
}

/** What a note's name is held against: one of a folder's, readable, not trashed. */
export type Named = {
  noteId: string;
  title: string | null;
  locked: boolean;
  deletedAt: number | null;
  purged: boolean;
};

/** Whether a note has a name held to this: one readable, not empty, not trashed. */
export const isNamed = (note: Named): note is Named & { title: string } =>
  !note.locked && !note.purged && note.deletedAt === null && (note.title?.trim() ?? "") !== "";

/**
 * The renames that leave no two of a folder's notes with one name: the one
 * made first (the smallest id: a note's id begins with when it was made)
 * keeps it, each after it is numbered. Every device works out the same
 * from the same notes, so two that do it at once write the same names.
 * `except`: a note whose name is being written, left as it is for now.
 */
export function duplicateRenames(
  notes: readonly Named[],
  except: ReadonlySet<string> = new Set(),
): { noteId: string; title: string }[] {
  const named = notes.filter(isNamed).sort((a, b) => (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0));
  // Every name there is, so that none numbered is given one of them.
  const taken = new Set(named.map((note) => titleKey(note.title)));
  const kept = new Set<string>();
  const renames: { noteId: string; title: string }[] = [];
  for (const note of named) {
    // Neither renamed nor keeping its name from another: settled once written.
    if (except.has(note.noteId)) continue;
    const key = titleKey(note.title);
    if (!kept.has(key)) {
      kept.add(key);
      continue;
    }
    const title = freeTitle(note.title, taken);
    taken.add(titleKey(title));
    kept.add(titleKey(title));
    renames.push({ noteId: note.noteId, title });
  }
  return renames;
}
