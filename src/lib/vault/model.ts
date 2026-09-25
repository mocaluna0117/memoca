import type { Folder, Note } from "@/lib/types";
import { subtreeIds } from "@/lib/tree";

/**
 * Which folder's lock covers each folder: its own, or its nearest locked
 * ancestor's. Folders outside any lock are absent.
 *
 * Inbox's flag is ignored: Inbox cannot be locked any more, and a flag left
 * from an earlier version must not turn every quick note into a locked one.
 * Trashed folders still count; purged ones do not.
 */
export function lockCoverage(folders: Folder[]): Map<string, string> {
  const byId = new Map(folders.filter((f) => !f.purged).map((f) => [f.folderId, f]));
  const coverage = new Map<string, string>();
  const resolve = (id: string, seen: Set<string>): string | null => {
    if (coverage.has(id)) return coverage.get(id)!;
    if (seen.has(id)) return null;
    seen.add(id);
    const folder = byId.get(id);
    if (!folder) return null;
    const own = folder.locked && folder.system !== "inbox" ? folder.folderId : null;
    const cover = own ?? (folder.parentId !== null ? resolve(folder.parentId, seen) : null);
    if (cover) coverage.set(id, cover);
    return cover;
  };
  for (const folder of byId.values()) resolve(folder.folderId, new Set());
  return coverage;
}

export type FolderLockKind = "own" | "inherited" | "none";

export function folderLockKind(folderId: string, coverage: Map<string, string>): FolderLockKind {
  const cover = coverage.get(folderId);
  if (!cover) return "none";
  return cover === folderId ? "own" : "inherited";
}

/** The locked folder that covers a note, if any. */
export function coveringFolderOf(note: Note, coverage: Map<string, string>): string | null {
  return note.folderId !== null ? (coverage.get(note.folderId) ?? null) : null;
}

/**
 * Why a locked note is locked. Notes locked before the reason was recorded
 * count as the folder's when a folder lock covers them, which is what they
 * would have been: those are the ones a folder lock used to create.
 */
export function lockOriginOf(
  note: Note,
  coverage: Map<string, string>,
): "note" | "folder" | null {
  if (!note.locked) return null;
  if (note.lockOrigin) return note.lockOrigin;
  return coveringFolderOf(note, coverage) ? "folder" : "note";
}

/** A plaintext note inside a locked folder: it should be locked and is not. */
export function needsLock(note: Note, coverage: Map<string, string>): boolean {
  return !note.purged && !note.locked && coveringFolderOf(note, coverage) !== null;
}

/** Plaintext notes a lock on this folder would encrypt, trashed ones included. */
export function planFolderLock(folderId: string, folders: Folder[], notes: Note[]): string[] {
  const inside = new Set(subtreeIds(folders, folderId));
  return notes
    .filter((n) => !n.purged && !n.locked && n.folderId !== null && inside.has(n.folderId))
    .map((n) => n.noteId);
}

/**
 * What taking this folder's lock off would do to its locked notes.
 *
 * Only the notes this lock alone protects come unlocked. A note someone
 * locked by hand stays locked, and so does one still covered by another lock:
 * a locked subfolder, or a locked folder above this one.
 */
export function planFolderUnlock(
  folderId: string,
  folders: Folder[],
  notes: Note[],
): { unlock: string[]; keep: string[] } {
  const before = lockCoverage(folders);
  const after = lockCoverage(
    folders.map((f) => (f.folderId === folderId ? { ...f, locked: false } : f)),
  );
  const inside = new Set(subtreeIds(folders, folderId));
  const unlock: string[] = [];
  const keep: string[] = [];
  for (const note of notes) {
    if (note.purged || !note.locked || note.folderId === null || !inside.has(note.folderId)) {
      continue;
    }
    const stillCovered = coveringFolderOf(note, after) !== null;
    if (stillCovered || lockOriginOf(note, before) === "note") keep.push(note.noteId);
    else unlock.push(note.noteId);
  }
  return { unlock, keep };
}

export function canLockFolder(folder: Folder, coverage: Map<string, string>): boolean {
  return folder.system !== "inbox" && folderLockKind(folder.folderId, coverage) === "none";
}
