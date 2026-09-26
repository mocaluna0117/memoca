import type { FunctionReturnType } from "convex/server";
import type { api } from "@convex/_generated/api";
import type { Note } from "@/lib/types";

export type Breakdown = FunctionReturnType<typeof api.usage.breakdown>;
export type LargeFile = Breakdown["largest"][number];

/** The account's figures as `users.me` reports them, live. */
export type Figures = { quotaBytes: number; usedBytes: number; reservedBytes: number };

/** The parts of the bar, in order. */
export const PARTS = [
  "images",
  "videos",
  "lockedFiles",
  "otherFiles",
  "text",
  "trash",
  "unused",
  "uploading",
  "uncounted",
] as const;
export type Part = (typeof PARTS)[number];

/**
 * What each part holds. `uncounted` is what the running total holds beyond
 * what the rows add up to, so the parts together are the total the page
 * shows above, and the free space after them is the free space it states.
 */
export function amounts(usage: Breakdown, live: Figures): Record<Part, number> {
  const parts: Record<Part, number> = {
    images: usage.files.image,
    videos: usage.files.video,
    lockedFiles: usage.files.locked,
    otherFiles: usage.files.other,
    text: usage.bodies.live,
    trash: usage.bodies.trashed + usage.trashedFiles,
    unused: usage.unused.bytes,
    uploading: usage.uploading,
    uncounted: 0,
  };
  const counted = PARTS.reduce((sum, part) => sum + parts[part], 0);
  parts.uncounted = Math.max(0, live.usedBytes + live.reservedBytes - counted);
  return parts;
}

/** Room left, as the page states it above. */
export function freeBytes(live: Figures): number {
  return Math.max(0, live.quotaBytes - live.usedBytes - live.reservedBytes);
}

/** A part too small to see is still drawn this wide, in per cent. */
const SLIVER = 0.5;

/**
 * How wide each part is drawn, in per cent of the allowance (or of the parts,
 * should they add up to more): a sliver at least for any part that holds
 * something, and never more than the whole bar between them.
 */
export function widths(parts: Record<Part, number>, quota: number): Record<Part, number> {
  const total = Math.max(quota, PARTS.reduce((sum, part) => sum + parts[part], 0), 1);
  const raw = Object.fromEntries(
    PARTS.map((part) => [part, parts[part] > 0 ? Math.max(SLIVER, (parts[part] / total) * 100) : 0]),
  ) as Record<Part, number>;
  const drawn = PARTS.reduce((sum, part) => sum + raw[part], 0);
  if (drawn <= 100) return raw;
  return Object.fromEntries(PARTS.map((part) => [part, (raw[part] * 100) / drawn])) as Record<Part, number>;
}

/** Differences smaller than this between the running total and a recount are not worth a word. */
export const MISMATCH_BYTES = 64 * 1024;

/**
 * How far the running total is from what the rows add up to, when that is
 * worth saying: never from a count that did not read every row.
 */
export function mismatch(usage: Breakdown): number | null {
  if (usage.truncated) return null;
  const difference = usage.usedBytes - usage.recomputedBytes;
  return Math.abs(difference) > MISMATCH_BYTES ? difference : null;
}

/**
 * Where a large file is, for its row: in a note to open (one out of the
 * trash first), in the trash, in no note any more, or in a note this device
 * does not have. `notes` is this device's copy of the notes it names.
 */
export function placeOf(
  file: LargeFile,
  notes: ReadonlyMap<string, Note | undefined>,
): { state: "note" | "trash" | "unused" | "missing"; noteId: string } {
  if (file.unused) return { state: "unused", noteId: file.noteId };
  if (file.trashed) return { state: "trash", noteId: file.noteId };
  const candidates = [...file.usedBy, file.noteId];
  const here = (noteId: string) => {
    const note = notes.get(noteId);
    return note !== undefined && !note.purged;
  };
  const open = candidates.find((noteId) => here(noteId) && notes.get(noteId)!.deletedAt === null);
  if (open) return { state: "note", noteId: open };
  const binned = candidates.find(here);
  if (binned) return { state: "trash", noteId: binned };
  return { state: "missing", noteId: file.noteId };
}
