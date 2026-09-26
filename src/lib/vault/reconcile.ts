"use client";

import type { ConvexReactClient } from "convex/react";
import { api } from "@convex/_generated/api";
import { vault } from "@/lib/crypto/vault";
import { db, getMeta, setMeta } from "@/lib/db";
import { META, deviceId } from "@/lib/db/meta";
import { purgeLockedBlobs } from "@/lib/media/attachments";
import { purgeMediaCache } from "@/lib/media/media-cache";
import { relockCopies, settleHeldCopies } from "@/lib/media/relock-copies";
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
  // The service worker may still hold the plaintext it fetched before.
  if (fixed > 0) await purgeMediaCache();
  return fixed;
}

/**
 * Locked notes looked at for copied files: the update they were looked at,
 * and when to look again even so (never, when nothing was left to do).
 */
const copiesChecked = new Map<string, { seq: number; retryAt: number }>();
/** Notes read per pass: each is decrypted in full to find what it shows. */
const COPY_CHECKS_PER_PASS = 5;
/** A note whose copies could not all be made is tried again after this. */
const COPY_RETRY_MS = 10 * 60 * 1000;
/** Where the last pass stopped, so every note gets its turn. */
let copyCursor = "";

/**
 * Gives locked notes their own encrypted copy of any file copied in from
 * another note, which locking left readable on the server (see
 * relock-copies.ts). A note is read again once it has changed, or a while
 * after a copy could not be made; a few per pass, taking turns. Returns how
 * many files now have a copy, and how many do not fit the allowance.
 */
export async function relockCopiedFiles(
  client: ConvexReactClient,
): Promise<{ copied: number; tooLarge: number }> {
  const result = { copied: 0, tooLarge: 0 };
  if (!vault.isUnlocked || (typeof navigator !== "undefined" && !navigator.onLine)) return result;
  const database = db();
  const now = Date.now();
  const due = (
    await database.notes.filter((n) => n.locked && !n.purged && Boolean(n.wrappedKey)).toArray()
  )
    .filter((note) => {
      const seen = copiesChecked.get(note.noteId);
      return !seen || seen.seq !== note.lastUpdateSeq || now >= seen.retryAt;
    })
    .sort((x, y) => (x.noteId < y.noteId ? -1 : 1));
  // Carry on after the note the last pass stopped at.
  const start = due.findIndex((note) => note.noteId > copyCursor);
  const turn = start < 0 ? due : [...due.slice(start), ...due.slice(0, start)];

  let read = 0;
  for (const note of turn) {
    if (read >= COPY_CHECKS_PER_PASS) break;
    // Only a note this device holds in full: one missing updates would be
    // looked at without the files those updates added.
    const body = await database.bodies.get(note.noteId);
    if (!body || body.keyEpoch !== note.keyEpoch || body.throughSeq < note.lastUpdateSeq) continue;
    read += 1;
    copyCursor = note.noteId;
    try {
      const outcome = await relockCopies(client, note.noteId);
      // Closed meanwhile: an empty answer means nothing was read.
      if (!vault.isUnlocked) break;
      result.copied += outcome.copied;
      result.tooLarge += outcome.tooLarge;
      const stuck = outcome.pending + outcome.tooLarge > 0;
      copiesChecked.set(note.noteId, {
        seq: note.lastUpdateSeq,
        // A note it just copied into changes once that edit is sent, and is
        // read once more then; one with copies left is tried again later.
        retryAt: stuck ? Date.now() + COPY_RETRY_MS : Number.POSITIVE_INFINITY,
      });
    } catch {
      if (!vault.isUnlocked) break;
      // A note this key cannot open (the health check reports those): not
      // read again until it changes, so it cannot take every pass's turn.
      copiesChecked.set(note.noteId, { seq: note.lastUpdateSeq, retryAt: Number.POSITIVE_INFINITY });
    }
  }
  return result;
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
  /** Files copied into locked notes that now have an encrypted copy there. */
  copiesLocked: number;
  /** Files copied into locked notes whose copy does not fit the allowance. */
  copiesTooLarge: number;
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
      copiesLocked: 0,
      copiesTooLarge: 0,
      unreadable: 0,
    };
    await purgeLockedBlobs().catch(() => 0);
    await settleHeldCopies(engine?.current ?? null).catch(() => 0);
    report.inboxUnlocked = await clearInboxLock(client).catch(() => false);
    if (!vault.isUnlocked) return report;
    report.namesRestored = await unsealFolderNames();
    const resumed = await resumeUnlockJob(client, engine).catch(() => null);
    report.unlockResumed = Boolean(resumed && resumed.total > 0 && resumed.pending.length === 0);
    report.notesLocked = await lockUncovered(client, engine).catch(() => 0);
    report.attachmentsLocked = await lockPlaintextAttachments(client);
    const copies = await relockCopiedFiles(client).catch(() => ({ copied: 0, tooLarge: 0 }));
    report.copiesLocked = copies.copied;
    report.copiesTooLarge = copies.tooLarge;
    report.unreadable = (await checkVaultHealth())?.unreadableNotes.length ?? 0;
    return report;
  })().finally(() => {
    repairing = null;
  });
  return repairing;
}
