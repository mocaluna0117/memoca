"use client";

import type { ConvexReactClient } from "convex/react";
import { api } from "@convex/_generated/api";
import { VaultLockedError, vault } from "@/lib/crypto/vault";
import { db, getMeta, setMeta } from "@/lib/db";
import { META, deviceId } from "@/lib/db/meta";
import { stamp } from "@/lib/sync/clock";
import { flushAll } from "@/lib/sync/docs";
import type { SyncEngine } from "@/lib/sync/engine";
import { lockNote, unlockNote, uploadsUnderWay } from "./actions";
import { lockCoverage, needsLock, planFolderLock, planFolderUnlock } from "./model";

export type CascadeResult = {
  total: number;
  done: number;
  /** Notes that could not be changed this time, and why. */
  pending: { noteId: string; reason: string }[];
  /** Stopped part way: the vault closed, or the network went. */
  aborted?: "vaultClosed" | "offline";
  /** The folder's own flag could not be changed; nothing else was tried. */
  failed?: string;
  /** Unlocking only: notes left locked on purpose. */
  kept?: number;
  /**
   * Locking only: files copied in from other notes that could not be given
   * an encrypted copy yet, and are still readable where they are.
   */
  copiesLeft?: number;
};

/** Filled in by {@link changeNote} as it locks notes. */
export type LockReport = { copiesLeft: number };

type Progress = (done: number, total: number) => void;

/** A folder unlock not yet finished, resumed on this device only. */
type UnlockJob = { folderId: string; noteIds: string[] };

class CascadeAbort extends Error {
  constructor(readonly reason: "vaultClosed" | "offline") {
    super(reason);
  }
}

/**
 * One cascade at a time across tabs, sharing with the repair pass: two of
 * them working through the same notes would only get in each other's way.
 */
async function exclusive<T>(fn: () => Promise<T>, ifAvailable = false): Promise<T | null> {
  if (typeof navigator === "undefined" || !navigator.locks) return fn();
  return navigator.locks.request("memoca-vault-cascade", { ifAvailable }, (lock) =>
    lock ? fn() : null,
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until a note is ready to be swapped: every local edit written and
 * pushed, and this device caught up with every update the server has.
 * Returns whether it got there within the time allowed.
 */
async function settle(
  engine: SyncEngine | null,
  noteId: string,
  direction: "lock" | "unlock",
  timeoutMs = 10_000,
) {
  await flushAll();
  engine?.kick(0);
  const database = db();
  const deadline = Date.now() + timeoutMs;
  let fetched = false;
  while (Date.now() < deadline) {
    const [note, body, unpushed, queued, uploading] = await Promise.all([
      database.notes.get(noteId),
      database.bodies.get(noteId),
      database.updates.where("noteId").equals(noteId).filter((u) => u.pushed === 0).count(),
      database.outbox.filter((op) => op.entityId === noteId).count(),
      // Its files on their way. A lock waits for the plain ones only: the
      // server refuses to lock a note while one is only reserved, and
      // encrypted ones, such as the copies a lock makes, do not hold it up.
      // An unlock waits for all of them: it turns back only stored files.
      uploadsUnderWay(noteId, direction === "lock"),
    ]);
    const behind = !note || !body || body.throughSeq < note.lastUpdateSeq;
    if (!behind && unpushed === 0 && queued === 0 && uploading === 0) return true;
    if (behind && !fetched && engine) {
      fetched = true;
      void engine.fetchBodies([noteId]).catch(() => undefined);
    }
    await sleep(250);
  }
  return false;
}

/** Reasons that clear up once the note has synced, so worth another try. */
const TRANSIENT = new Set(["behind", "unsent", "uploadPending", "attachmentsNotCovered", "epochMismatch"]);

/**
 * Locks or unlocks one note, fixing what can be fixed along the way: waiting
 * for sync, or compacting a note with too many update rows. Returns null when
 * done, or the reason it is still pending.
 */
export async function changeNote(
  client: ConvexReactClient,
  engine: SyncEngine | null,
  noteId: string,
  direction: "lock" | "unlock",
  origin: "note" | "folder",
  report?: LockReport,
): Promise<string | null> {
  let reason = "unknown";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!vault.isUnlocked) throw new CascadeAbort("vaultClosed");
    if (typeof navigator !== "undefined" && !navigator.onLine) throw new CascadeAbort("offline");
    let outcome;
    try {
      outcome =
        direction === "lock"
          ? await lockNote(client, noteId, { origin })
          : await unlockNote(client, noteId);
    } catch (cause) {
      if (cause instanceof VaultLockedError) throw new CascadeAbort("vaultClosed");
      // A failed fetch of an attachment or an upload: the network is gone.
      if (cause instanceof TypeError) throw new CascadeAbort("offline");
      throw cause;
    }
    if (outcome.status === "ok") {
      if (report) report.copiesLeft += outcome.copiesLeft ?? 0;
      return null;
    }
    reason = outcome.reason;
    if (reason === "alreadyLocked" || reason === "notLocked" || reason === "unknownNote") return null;
    if (reason === "vaultLocked") throw new CascadeAbort("vaultClosed");
    if (reason === "compactFirst" && engine) {
      await engine.compact(noteId).catch(() => undefined);
      continue;
    }
    if (TRANSIENT.has(reason)) {
      await settle(engine, noteId, direction);
      continue;
    }
    return reason;
  }
  return reason;
}

async function runNotes(
  client: ConvexReactClient,
  engine: SyncEngine | null,
  noteIds: string[],
  direction: "lock" | "unlock",
  onProgress?: Progress,
): Promise<Pick<CascadeResult, "done" | "pending" | "aborted" | "copiesLeft">> {
  const pending: CascadeResult["pending"] = [];
  const report: LockReport = { copiesLeft: 0 };
  let done = 0;
  for (const [index, noteId] of noteIds.entries()) {
    try {
      const reason = await changeNote(client, engine, noteId, direction, "folder", report);
      if (reason) pending.push({ noteId, reason });
      else done += 1;
    } catch (cause) {
      if (!(cause instanceof CascadeAbort)) throw cause;
      for (const rest of noteIds.slice(index)) pending.push({ noteId: rest, reason: cause.reason });
      return { done, pending, aborted: cause.reason, copiesLeft: report.copiesLeft };
    }
    onProgress?.(index + 1, noteIds.length);
  }
  return { done, pending, copiesLeft: report.copiesLeft };
}

/**
 * Locks a folder: its flag first, then every plaintext note inside, so that a
 * note left over by an interruption is found and locked by the repair pass.
 * Holds the vault open throughout.
 */
export async function lockFolder(
  client: ConvexReactClient,
  engine: SyncEngine | null,
  folderId: string,
  onProgress?: Progress,
): Promise<CascadeResult> {
  const result = await exclusive(async (): Promise<CascadeResult> => {
    const release = vault.hold();
    try {
      if (!navigator.onLine) return { total: 0, done: 0, pending: [], aborted: "offline" };
      const database = db();
      const folder = await database.folders.get(folderId);
      if (!folder) return { total: 0, done: 0, pending: [], failed: "unknownFolder" };
      const ts = stamp(await deviceId());
      const flag = await client.mutation(api.vault.setFolderLock, { folderId, locked: true, ts });
      if (flag.status !== "ok") return { total: 0, done: 0, pending: [], failed: flag.reason };
      await database.folders.update(folderId, { locked: true, ts: { ...folder.ts, lock: ts } });

      const noteIds = planFolderLock(folderId, await database.folders.toArray(), await database.notes.toArray());
      onProgress?.(0, noteIds.length);
      const run = await runNotes(client, engine, noteIds, "lock", onProgress);
      return { total: noteIds.length, ...run };
    } finally {
      release();
    }
  });
  return result ?? { total: 0, done: 0, pending: [], failed: "busy" };
}

/**
 * Takes a folder's lock off: its flag first, then only the notes that lock
 * alone protected. Notes locked by hand, or still covered by another lock,
 * stay locked. What is left undone is remembered on this device and finished
 * the next time the vault opens here.
 */
export async function unlockFolder(
  client: ConvexReactClient,
  engine: SyncEngine | null,
  folderId: string,
  onProgress?: Progress,
): Promise<CascadeResult> {
  const result = await exclusive(async (): Promise<CascadeResult> => {
    const release = vault.hold();
    try {
      if (!navigator.onLine) return { total: 0, done: 0, pending: [], aborted: "offline" };
      const database = db();
      const folder = await database.folders.get(folderId);
      if (!folder) return { total: 0, done: 0, pending: [], failed: "unknownFolder" };
      // Planned while the flag is still on: that is what tells a note the
      // folder locked apart from one locked by hand.
      const plan = planFolderUnlock(folderId, await database.folders.toArray(), await database.notes.toArray());

      const ts = stamp(await deviceId());
      const flag = await client.mutation(api.vault.setFolderLock, { folderId, locked: false, ts });
      if (flag.status !== "ok") return { total: 0, done: 0, pending: [], failed: flag.reason };
      await database.folders.update(folderId, { locked: false, ts: { ...folder.ts, lock: ts } });
      await setMeta(META.unlockJob, { folderId, noteIds: plan.unlock } satisfies UnlockJob);

      onProgress?.(0, plan.unlock.length);
      const run = await runNotes(client, engine, plan.unlock, "unlock", onProgress);
      await saveJob(folderId, run.pending.map((p) => p.noteId));
      return { total: plan.unlock.length, kept: plan.keep.length, ...run };
    } finally {
      release();
    }
  });
  return result ?? { total: 0, done: 0, pending: [], failed: "busy" };
}

async function saveJob(folderId: string, remaining: string[]) {
  if (remaining.length === 0) await db().meta.delete(META.unlockJob);
  else await setMeta(META.unlockJob, { folderId, noteIds: remaining } satisfies UnlockJob);
}

/** Finishes a folder unlock this device left part way. */
export async function resumeUnlockJob(
  client: ConvexReactClient,
  engine: SyncEngine | null,
): Promise<CascadeResult | null> {
  const job = await getMeta<UnlockJob | null>(META.unlockJob, null);
  if (!job || !vault.isUnlocked) return null;
  return exclusive(async () => {
    const release = vault.hold();
    try {
      const database = db();
      const folders = await database.folders.toArray();
      const coverage = lockCoverage(folders);
      // Locked again meanwhile, here or elsewhere: nothing left to undo.
      if (coverage.has(job.folderId)) {
        await database.meta.delete(META.unlockJob);
        return null;
      }
      const notes = await Promise.all(job.noteIds.map((id) => database.notes.get(id)));
      const still = notes
        .filter((note) => note && note.locked && !note.purged && !needsCover(note.folderId, coverage))
        .map((note) => note!.noteId);
      const run = await runNotes(client, engine, still, "unlock");
      await saveJob(job.folderId, run.pending.map((p) => p.noteId));
      return { total: still.length, ...run };
    } finally {
      release();
    }
  }, true);
}

const needsCover = (folderId: string | null, coverage: Map<string, string>) =>
  folderId !== null && coverage.has(folderId);

/**
 * Locks every plaintext note inside a locked folder: those left over when a
 * folder lock was interrupted, or that arrived from a device that wrote them
 * in plaintext. Skipped while another cascade runs. Returns how many.
 */
export async function lockUncovered(
  client: ConvexReactClient,
  engine: SyncEngine | null,
): Promise<number> {
  if (!vault.isUnlocked || (typeof navigator !== "undefined" && !navigator.onLine)) return 0;
  const result = await exclusive(async () => {
    const database = db();
    const coverage = lockCoverage(await database.folders.toArray());
    const noteIds = (await database.notes.toArray())
      .filter((note) => needsLock(note, coverage))
      .map((note) => note.noteId);
    if (noteIds.length === 0) return 0;
    const release = vault.hold();
    try {
      return (await runNotes(client, engine, noteIds, "lock")).done;
    } finally {
      release();
    }
  }, true);
  return result ?? 0;
}
