import type { BodyState } from "@/lib/db";
import { trashedFolderIds } from "@/lib/tree";
import type { Folder, Note } from "@/lib/types";
import { titleKey } from "@/lib/vault/titles";
import type { IndexInput } from "./engine";

export type SearchScope = {
  rows: IndexInput[];
  /** Locked notes outside the trash, whether or not they could be searched. */
  locked: number;
};

/**
 * What search looks through.
 *
 * A locked note is left out while the vault is closed: even its placeholder
 * title would only match the word "ロック". While the vault is open it is
 * searched by its real title, opened in memory; its body text is never on
 * disk in the clear, so it is not searched at all.
 */
export function searchScope(
  notes: Note[],
  folders: Folder[],
  bodies: Pick<BodyState, "noteId" | "text" | "reading">[],
  vault: { open: boolean; titles: ReadonlyMap<string, string> },
): SearchScope {
  const trashed = trashedFolderIds(folders);
  const folderName = new Map(folders.map((f) => [f.folderId, f.name ?? ""]));
  const body = new Map(bodies.map((b) => [b.noteId, b]));

  let locked = 0;
  const rows: IndexInput[] = [];
  for (const note of notes) {
    if (note.purged || note.deletedAt !== null) continue;
    if (note.folderId !== null && trashed.has(note.folderId)) continue;
    const place = note.folderId ? (folderName.get(note.folderId) ?? "") : "";

    if (note.locked) {
      locked += 1;
      if (!vault.open) continue;
      // Not opened yet, or cannot be: left out rather than shown as a
      // placeholder. A locked note with no title has nothing to open.
      const title = note.titleSealed ? vault.titles.get(titleKey(note)) : "";
      if (title === undefined) continue;
      rows.push({
        noteId: note.noteId,
        folderId: note.folderId,
        title,
        body: null,
        folderName: place,
        locked: true,
        updatedAt: note.updatedAt,
        reading: null,
      });
      continue;
    }

    const own = body.get(note.noteId);
    rows.push({
      noteId: note.noteId,
      folderId: note.folderId,
      title: note.title ?? "",
      body: own?.text ?? null,
      folderName: place,
      locked: false,
      updatedAt: note.updatedAt,
      reading: own?.reading ?? null,
    });
  }
  return { rows, locked };
}

/** The line under the result count, when locked notes change what is found. */
export function lockedSearchNote(locked: { count: number; open: boolean }): string | null {
  if (locked.count === 0) return null;
  return locked.open
    ? "ロックされたメモの本文は検索されません。"
    : "ロックされたメモは、金庫を開くとタイトルで検索できます。";
}
