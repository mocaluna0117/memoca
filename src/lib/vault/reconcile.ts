"use client";

import type { ConvexReactClient } from "convex/react";
import { api } from "@convex/_generated/api";
import { vault } from "@/lib/crypto/vault";
import { db, getMeta, setMeta } from "@/lib/db";
import { META, deviceId } from "@/lib/db/meta";
import { purgeLockedBlobs } from "@/lib/media/attachments";
import { stamp } from "@/lib/sync/clock";
import type { SyncEngine } from "@/lib/sync/engine";
import { renameFolder } from "@/lib/sync/mutations";
import { sealAttachments } from "./actions";
import { lockUncovered, resumeUnlockJob } from "./cascade";

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

/**
 * Takes the old lock flag off Inbox, which can no longer be locked. Needs no
 * vault; notes locked inside stay locked. Returns whether it did.
 */
export async function clearInboxLock(client: ConvexReactClient): Promise<boolean> {
  const database = db();
  const inbox = await database.folders.where("system").equals("inbox").first();
  if (!inbox || !inbox.locked || inbox.purged) return false;
  if (typeof navigator !== "undefined" && !navigator.onLine) return false;
  const ts = stamp(await deviceId());
  const result = await client.mutation(api.vault.setFolderLock, {
    folderId: inbox.folderId,
    locked: false,
    ts,
  });
  if (result.status !== "ok") return false;
  await database.folders.update(inbox.folderId, { locked: false, ts: { ...inbox.ts, lock: ts } });
  return true;
}

/**
 * Encrypts files an earlier version left in plaintext on a locked note, and
 * swaps them in. Returns how many were fixed.
 */
export async function lockPlaintextAttachments(client: ConvexReactClient): Promise<number> {
  if (!vault.isUnlocked || (typeof navigator !== "undefined" && !navigator.onLine)) return 0;
  const database = db();
  const locked = new Set((await database.notes.filter((n) => n.locked && !n.purged).toArray()).map((n) => n.noteId));
  const plain = (await database.attachments.toArray()).filter(
    (a) => locked.has(a.noteId) && a.status === "committed" && !a.locked && a.deletedAt === null,
  );
  const byNote = new Map<string, typeof plain>();
  for (const a of plain) byNote.set(a.noteId, [...(byNote.get(a.noteId) ?? []), a]);

  let fixed = 0;
  for (const [noteId, attachments] of byNote) {
    try {
      const swaps = await sealAttachments(client, attachments);
      if (swaps.length === 0) continue;
      const result = await client.mutation(api.vault.lockAttachments, {
        noteId,
        attachments: swaps as never,
      });
      if (result.status === "ok") fixed += swaps.length;
    } catch {
      // Offline, or the vault closed: the next pass tries again.
    }
  }
  return fixed;
}

/**
 * Tries every locked note's key with this vault's key, and records the ones
 * it cannot open. Nothing is deleted: a note locked under a key that was
 * never saved (an earlier bug could do that) stays for the person to decide.
 */
export async function checkVaultHealth(): Promise<VaultHealth | null> {
  if (!vault.isUnlocked) return null;
  const database = db();
  const unreadableNotes: string[] = [];
  for (const note of await database.notes.filter((n) => n.locked && !n.purged).toArray()) {
    if (!note.wrappedKey) {
      unreadableNotes.push(note.noteId);
      continue;
    }
    try {
      await vault.noteKey(note.noteId, note.keyEpoch, note.wrappedKey);
    } catch {
      unreadableNotes.push(note.noteId);
    }
  }
  const previous = await readVaultHealth();
  const health: VaultHealth = {
    unreadableNotes,
    unreadableFolders: previous?.unreadableFolders ?? [],
    checkedAt: Date.now(),
  };
  await setMeta(META.vaultHealth, health);
  return health;
}

export type RepairReport = {
  inboxUnlocked: boolean;
  namesRestored: number;
  notesLocked: number;
  unlockResumed: boolean;
  attachmentsLocked: number;
  unreadable: number;
};

let repairing: Promise<RepairReport> | null = null;

/**
 * Everything that puts right what earlier versions left behind, in one pass:
 * run whenever the vault opens, the network returns or sync settles. Safe to
 * run any number of times; one pass at a time.
 */
export function repairLocks(
  client: ConvexReactClient,
  engine: SyncEngine | null,
): Promise<RepairReport> {
  repairing ??= (async () => {
    const report: RepairReport = {
      inboxUnlocked: false,
      namesRestored: 0,
      notesLocked: 0,
      unlockResumed: false,
      attachmentsLocked: 0,
      unreadable: 0,
    };
    await purgeLockedBlobs().catch(() => 0);
    report.inboxUnlocked = await clearInboxLock(client).catch(() => false);
    if (!vault.isUnlocked) return report;
    report.namesRestored = await unsealFolderNames();
    const resumed = await resumeUnlockJob(client, engine).catch(() => null);
    report.unlockResumed = Boolean(resumed && resumed.total > 0 && resumed.pending.length === 0);
    report.notesLocked = await lockUncovered(client, engine).catch(() => 0);
    report.attachmentsLocked = await lockPlaintextAttachments(client);
    report.unreadable = (await checkVaultHealth())?.unreadableNotes.length ?? 0;
    return report;
  })().finally(() => {
    repairing = null;
  });
  return repairing;
}
