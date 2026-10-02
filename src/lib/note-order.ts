import { between } from "@/lib/sortkey";
import type { Note } from "@/lib/types";

/**
 * How a list of notes is ordered: last changed first (as it always was),
 * last made first, by name, or as placed by hand. Pinned notes come first
 * whichever it is.
 */
export type NoteOrder = "updated" | "created" | "title" | "manual";

export const NOTE_ORDERS: readonly { value: NoteOrder; label: string }[] = [
  { value: "updated", label: "更新順" },
  { value: "created", label: "作成順" },
  { value: "title", label: "タイトル順" },
  { value: "manual", label: "手動" },
];

/**
 * When a note was made, from its id: a UUIDv7, whose first 48 bits are the
 * time it was made, in milliseconds. Null for an id of any other kind.
 */
export function createdAt(noteId: string): number | null {
  const hex = noteId.replace(/-/g, "");
  if (!/^[0-9a-f]{12}7/i.test(hex)) return null;
  return Number.parseInt(hex.slice(0, 12), 16);
}

export const isNoteOrder = (value: unknown): value is NoteOrder =>
  NOTE_ORDERS.some((order) => order.value === value);

/** Names compared as a person reads them: 2 before 10, あ and ア alike. */
const byName = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });

/**
 * Pinned notes in their order among the pinned, as placed by hand (their
 * pin keys, which every device shares); those pinned before there were keys
 * (with none) first, the one pinned last first, as one pinned now goes.
 */
export function byPinPlace(a: Note, b: Note): number {
  const left = a.pinKey ?? "";
  const right = b.pinKey ?? "";
  if (left !== right) return left < right ? -1 : 1;
  const pinnedLater = b.ts.pin.t - a.ts.pin.t;
  if (pinnedLater !== 0) return pinnedLater;
  return a.noteId < b.noteId ? 1 : a.noteId > b.noteId ? -1 : 0;
}

/**
 * Notes in an order, pinned ones first, in their own order among the pinned
 * (as placed by hand, whichever the order is). `names` are the names shown, for
 * ordering by name (a locked note's title is only known decrypted); a note
 * with none is ordered by its title. By hand, the order is the notes' sort
 * keys, which every device shares. A note's id is made from the time it
 * was made, so it orders them by that.
 */
export function orderNotes(
  notes: Note[],
  order: NoteOrder = "updated",
  names?: ReadonlyMap<string, string>,
): Note[] {
  const updated = (a: Note, b: Note) => b.updatedAt - a.updatedAt;
  const compare: Record<NoteOrder, (a: Note, b: Note) => number> = {
    updated,
    created: (a, b) => (a.noteId < b.noteId ? 1 : a.noteId > b.noteId ? -1 : 0),
    title: (a, b) =>
      byName.compare(
        names?.get(a.noteId) ?? a.title ?? "",
        names?.get(b.noteId) ?? b.title ?? "",
      ) || updated(a, b),
    // Two with one key (made at once on two devices): the newer first, as a
    // note made goes first.
    manual: (a, b) =>
      a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : compare.created(a, b),
  };
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned) return byPinPlace(a, b);
    return compare[order](a, b);
  });
}

/**
 * The sort key that puts a note at `index` among `others` (the notes it is
 * placed among, in their order by key, itself not one of them), and any of
 * them to be given a new key first. That is only when the note goes between
 * two that share a key (made at once on two devices, say), so that no key
 * fits between them: then those from there on that share it are given new
 * keys after the note's, before the next key along. No other note is
 * touched: a new key is a new place for a note, and one written for a note
 * that was being moved elsewhere on another device would take it back.
 */
export function placeAt(
  others: readonly Pick<Note, "noteId" | "sortKey">[],
  index: number,
): { key: string; rekeyed: { noteId: string; sortKey: string }[] } {
  const before = others[index - 1]?.sortKey ?? null;
  const after = others[index]?.sortKey ?? null;
  if (before === null || after === null || before < after) {
    return { key: between(before, after), rekeyed: [] };
  }
  // The run from `index` on that shares the key before it, and the key past it.
  let end = index;
  while (end < others.length && others[end]!.sortKey <= before) end += 1;
  const next = others[end]?.sortKey ?? null;
  const key = between(before, next);
  const rekeyed: { noteId: string; sortKey: string }[] = [];
  let last = key;
  for (let at = index; at < end; at += 1) {
    last = between(last, next);
    rekeyed.push({ noteId: others[at]!.noteId, sortKey: last });
  }
  return { key, rekeyed };
}
