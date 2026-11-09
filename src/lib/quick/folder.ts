"use client";

import { getMeta, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import { lockedFolderIds, trashedFolderIds } from "@/lib/tree";
import type { Folder, FolderNode } from "@/lib/types";

/**
 * Whether the quick note may save into a folder: one there, not in the
 * trash, not locked or inside a locked one (a quick note is written in the
 * clear, and the vault may be closed), and not the templates' folder,
 * whose notes are templates.
 */
export function quickFolderAllowed(folder: Folder | undefined, folders: Folder[]): boolean {
  if (!folder || folder.purged) return false;
  if (folder.system === "templates") return false;
  if (trashedFolderIds(folders).has(folder.folderId)) return false;
  return !lockedFolderIds(folders).has(folder.folderId);
}

/**
 * Where the quick note saves: the folder last chosen on this device for this
 * account, while it may still be saved into, or else Inbox.
 */
export function quickFolderOf(
  chosen: string | null,
  inbox: string | null,
  folders: Folder[],
): string | null {
  if (!chosen || chosen === inbox) return inbox;
  const folder = folders.find((each) => each.folderId === chosen);
  return quickFolderAllowed(folder, folders) ? chosen : inbox;
}

/** As {@link quickFolderAllowed}, for a folder of the tree (one in the trash is not in it). */
export function quickPickable(node: FolderNode): boolean {
  return !node.inLockedTree && node.system !== "templates";
}

const key = (userKey: string) => `${META.quickFolder}:${userKey}`;

/** The folder last chosen on this device, for this account; null if none was. */
export function rememberedQuickFolder(userKey: string): Promise<string | null> {
  return getMeta<string | null>(key(userKey), null);
}

/** Remembers the folder chosen, for the next quick note on this device. */
export function rememberQuickFolder(userKey: string, folderId: string): Promise<void> {
  return setMeta(key(userKey), folderId);
}
