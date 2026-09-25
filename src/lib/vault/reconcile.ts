"use client";

import { vault } from "@/lib/crypto/vault";
import { db, getMeta, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import { renameFolder } from "@/lib/sync/mutations";

export type VaultHealth = {
  /** Folders whose sealed name this vault's key could not open. */
  unreadableFolders: string[];
  /** Locked notes whose key this vault's key could not open. */
  unreadableNotes: string[];
  checkedAt: number;
};

export async function readVaultHealth(): Promise<VaultHealth | null> {
  return getMeta<VaultHealth | null>(META.vaultHealth, null);
}

/**
 * Folders whose name an earlier version sealed. Folder names are plaintext
 * now, so these are moved back as soon as the vault is open.
 */
export async function sealedNameFolders() {
  return db()
    .folders.filter((f) => f.name === null && f.nameSealed !== undefined && !f.purged)
    .toArray();
}

/**
 * Opens every sealed folder name and saves it again in plaintext, through the
 * ordinary rename, so it syncs like any other change and two devices doing it
 * at once simply agree. Names that cannot be opened are left as they are and
 * recorded, never deleted. Returns how many were restored.
 */
let unsealing: Promise<number> | null = null;

export function unsealFolderNames(): Promise<number> {
  // One pass at a time: each rename changes the folders it was started for.
  unsealing ??= unsealOnce().finally(() => {
    unsealing = null;
  });
  return unsealing;
}

async function unsealOnce(): Promise<number> {
  if (!vault.isUnlocked) return 0;
  let restored = 0;
  const unreadable: string[] = [];
  for (const folder of await sealedNameFolders()) {
    let name: string;
    try {
      name = await vault.openFolderName(folder.folderId, folder.nameSealed!);
    } catch {
      unreadable.push(folder.folderId);
      continue;
    }
    await renameFolder(folder.folderId, name);
    restored += 1;
  }
  const health = await readVaultHealth();
  await setMeta(META.vaultHealth, {
    unreadableNotes: health?.unreadableNotes ?? [],
    unreadableFolders: unreadable,
    checkedAt: Date.now(),
  } satisfies VaultHealth);
  return restored;
}
