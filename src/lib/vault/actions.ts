"use client";

import type { ConvexReactClient } from "convex/react";
import * as Y from "yjs";
import { api } from "@convex/_generated/api";
import { toArrayBuffer } from "@/lib/bytes";
import { ctx } from "@/lib/crypto/context";
import { open, seal } from "@/lib/crypto/primitives";
import { vault } from "@/lib/crypto/vault";
import { db } from "@/lib/db";
import { deviceId } from "@/lib/db/meta";
import { stamp } from "@/lib/sync/clock";
import { reloadDoc, withDetachedDoc } from "@/lib/sync/docs";
import { extractText, firstLine } from "@/lib/sync/ydoc";
import { subtreeIds } from "@/lib/tree";

export type LockOutcome =
  | { status: "ok" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

async function uploadBytes(
  client: ConvexReactClient,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  const uploadUrl = await client.mutation(api.notes.snapshotUploadUrl, {});
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: new Blob([toArrayBuffer(bytes)]),
  });
  const { storageId } = (await response.json()) as { storageId: string };
  return storageId;
}

/**
 * Turns a plaintext note into an encrypted one.
 *
 * Everything is prepared locally first: the whole document is merged into one
 * snapshot, encrypted, and handed to the server together with the epoch bump.
 * The server deletes the plaintext it was holding in the same transaction, so
 * there is no window in which both versions exist.
 */
export async function lockNote(
  client: ConvexReactClient,
  noteId: string,
): Promise<LockOutcome> {
  const database = db();
  const note = await database.notes.get(noteId);
  if (!note) return { status: "skipped", reason: "unknownNote" };
  if (note.locked) return { status: "ok" };
  if (!vault.isUnlocked) return { status: "skipped", reason: "vaultLocked" };

  const body = await database.bodies.get(noteId);
  if (!body || body.throughSeq !== note.lastUpdateSeq) {
    return { status: "skipped", reason: "behind" };
  }
  const unpushed = await database.updates
    .where("noteId")
    .equals(noteId)
    .filter((u) => u.pushed === 0)
    .count();
  if (unpushed > 0) return { status: "skipped", reason: "unsent" };

  const epoch = note.keyEpoch + 1;
  const { key, wrapped } = await vault.createNoteKey(noteId, epoch);

  const merged = await withDetachedDoc(noteId, (doc) => Y.encodeStateAsUpdate(doc));
  const snapshot = await seal(key, merged, ctx.yjsSnapshot(noteId, epoch));
  const titleSealed = await seal(
    key,
    new TextEncoder().encode(note.title ?? ""),
    ctx.noteTitle(noteId, epoch),
  );

  // Attachments are re-encrypted and re-uploaded; the server deletes the
  // plaintext files as part of the same transaction.
  const attachments = await database.attachments.where("noteId").equals(noteId).toArray();
  const swaps: Record<string, unknown>[] = [];

  for (const attachment of attachments) {
    if (attachment.status !== "committed" || attachment.locked) continue;
    const urls = await client.query(api.attachments.urls, {
      attachmentIds: [attachment.attachmentId],
    });
    const url = urls[attachment.attachmentId];
    if (!url) continue;
    const plain = new Uint8Array(await (await fetch(url)).arrayBuffer());

    const attKey = await vault.createAttachmentKey(attachment.attachmentId);
    const encrypted = await seal(attKey.key, plain, ctx.attachmentBody(attachment.attachmentId));
    const meta = await seal(
      attKey.key,
      new TextEncoder().encode(
        JSON.stringify({ name: attachment.name, mime: attachment.mime }),
      ),
      ctx.attachmentMeta(attachment.attachmentId),
    );
    const storageId = await uploadBytes(client, encrypted.ct, "application/octet-stream");

    swaps.push({
      attachmentId: attachment.attachmentId,
      storageId,
      bytes: encrypted.ct.byteLength,
      metaSealed: { ct: toArrayBuffer(meta.ct), iv: toArrayBuffer(meta.iv) },
      wrappedKey: attKey.wrapped,
      contentIv: toArrayBuffer(encrypted.iv),
    });
  }

  const result = await client.mutation(api.vault.lockNote, {
    noteId,
    keyEpoch: epoch,
    coversThroughSeq: note.lastUpdateSeq,
    wrappedKey: wrapped,
    titleSealed: { ct: toArrayBuffer(titleSealed.ct), iv: toArrayBuffer(titleSealed.iv) },
    snapshot: {
      payload: toArrayBuffer(snapshot.ct),
      size: snapshot.ct.byteLength,
      iv: toArrayBuffer(snapshot.iv),
    },
    attachments: swaps as never,
    ts: stamp(await deviceId()),
  });
  if (result.status !== "ok") return { status: "failed", reason: result.reason ?? "" };

  await database.snapshots.put({
    noteId,
    data: snapshot.ct,
    iv: snapshot.iv,
    keyEpoch: epoch,
    throughSeq: note.lastUpdateSeq,
  });
  await database.updates.where("noteId").equals(noteId).delete();
  await database.notes.update(noteId, {
    locked: true,
    keyEpoch: epoch,
    wrappedKey: wrapped,
    preview: null,
  });
  await database.bodies.put({
    noteId,
    throughSeq: note.lastUpdateSeq,
    keyEpoch: epoch,
    text: null,
    updatedAt: Date.now(),
  });
  await reloadDoc(noteId);
  return { status: "ok" };
}

/** The exact inverse of {@link lockNote}. */
export async function unlockNote(
  client: ConvexReactClient,
  noteId: string,
): Promise<LockOutcome> {
  const database = db();
  const note = await database.notes.get(noteId);
  if (!note) return { status: "skipped", reason: "unknownNote" };
  if (!note.locked) return { status: "ok" };
  if (!vault.isUnlocked || !note.wrappedKey) {
    return { status: "skipped", reason: "vaultLocked" };
  }

  const body = await database.bodies.get(noteId);
  if (!body || body.throughSeq !== note.lastUpdateSeq) {
    return { status: "skipped", reason: "behind" };
  }

  const key = await vault.noteKey(noteId, note.keyEpoch, note.wrappedKey);
  const epoch = note.keyEpoch + 1;
  const merged = await withDetachedDoc(noteId, (doc) => Y.encodeStateAsUpdate(doc));

  let title = "";
  if (note.titleSealed) {
    const plain = await open(
      key,
      new Uint8Array(note.titleSealed.ct),
      new Uint8Array(note.titleSealed.iv),
      ctx.noteTitle(noteId, note.keyEpoch),
    );
    title = new TextDecoder().decode(plain);
  }
  const text = await withDetachedDoc(noteId, (doc) => extractText(doc));

  const attachments = await database.attachments.where("noteId").equals(noteId).toArray();
  const swaps: Record<string, unknown>[] = [];

  for (const attachment of attachments) {
    if (attachment.status !== "committed" || !attachment.locked) continue;
    if (!attachment.wrappedKey || !attachment.contentIv) continue;
    const urls = await client.query(api.attachments.urls, {
      attachmentIds: [attachment.attachmentId],
    });
    const url = urls[attachment.attachmentId];
    if (!url) continue;

    const attKey = await vault.attachmentKey(attachment.attachmentId, attachment.wrappedKey);
    const cipher = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const plain = await open(
      attKey,
      cipher,
      new Uint8Array(attachment.contentIv),
      ctx.attachmentBody(attachment.attachmentId),
    );
    let meta = { name: "file", mime: "application/octet-stream" };
    if (attachment.metaSealed) {
      const raw = await open(
        attKey,
        new Uint8Array(attachment.metaSealed.ct),
        new Uint8Array(attachment.metaSealed.iv),
        ctx.attachmentMeta(attachment.attachmentId),
      );
      meta = JSON.parse(new TextDecoder().decode(raw)) as typeof meta;
    }

    const storageId = await uploadBytes(client, plain, meta.mime);
    swaps.push({
      attachmentId: attachment.attachmentId,
      storageId,
      bytes: plain.byteLength,
      name: meta.name,
      mime: meta.mime,
    });
  }

  const result = await client.mutation(api.vault.unlockNote, {
    noteId,
    keyEpoch: epoch,
    coversThroughSeq: note.lastUpdateSeq,
    title,
    preview: firstLine(text, 160),
    snapshot: { payload: toArrayBuffer(merged), size: merged.byteLength },
    attachments: swaps as never,
    ts: stamp(await deviceId()),
  });
  if (result.status !== "ok") return { status: "failed", reason: result.reason ?? "" };

  await database.snapshots.put({
    noteId,
    data: merged,
    keyEpoch: epoch,
    throughSeq: note.lastUpdateSeq,
  });
  await database.updates.where("noteId").equals(noteId).delete();
  await database.notes.update(noteId, {
    locked: false,
    keyEpoch: epoch,
    wrappedKey: undefined,
    title,
    titleSealed: undefined,
    preview: firstLine(text, 160),
  });
  await database.bodies.put({
    noteId,
    throughSeq: note.lastUpdateSeq,
    keyEpoch: epoch,
    text,
    updatedAt: Date.now(),
  });
  await reloadDoc(noteId);
  return { status: "ok" };
}

export type CascadeProgress = { done: number; total: number };

/**
 * Locks a folder and everything under it.
 *
 * The flag is set first and the notes follow one by one, because only this
 * device holds the key. If the run is interrupted the folder is already marked
 * locked, and {@link resumeCascades} finishes the job on next launch rather
 * than leaving plaintext inside a folder the user believes is protected.
 */
export async function setFolderLocked(
  client: ConvexReactClient,
  folderId: string,
  locked: boolean,
  onProgress?: (progress: CascadeProgress) => void,
): Promise<LockOutcome> {
  const database = db();
  const folder = await database.folders.get(folderId);
  if (!folder) return { status: "skipped", reason: "unknownFolder" };
  if (!vault.isUnlocked) return { status: "skipped", reason: "vaultLocked" };

  const device = await deviceId();
  const ts = stamp(device);

  // The name is never sealed any more. A name an earlier version sealed is
  // opened and sent back in plaintext when the lock comes off.
  const legacyName =
    folder.name === null && folder.nameSealed
      ? await vault.openFolderName(folderId, folder.nameSealed).catch(() => null)
      : null;
  const result = await client.mutation(api.vault.setFolderLock, {
    folderId,
    locked,
    ...(!locked && legacyName !== null ? { name: legacyName } : {}),
    ts,
  });
  if (result.status !== "ok") return { status: "failed", reason: result.reason ?? "" };

  await database.folders.update(folderId, {
    locked,
    ...(!locked && legacyName !== null
      ? { name: legacyName, nameSealed: undefined, ts: { ...folder.ts, lock: ts, name: ts } }
      : { ts: { ...folder.ts, lock: ts } }),
  });

  const folders = await database.folders.toArray();
  const ids = new Set(subtreeIds(folders, folderId));
  const notes = (await database.notes.toArray()).filter(
    (note) =>
      note.folderId !== null &&
      ids.has(note.folderId) &&
      !note.purged &&
      note.locked !== locked,
  );

  let done = 0;
  for (const note of notes) {
    const outcome = locked
      ? await lockNote(client, note.noteId)
      : await unlockNote(client, note.noteId);
    done += 1;
    onProgress?.({ done, total: notes.length });
    if (outcome.status === "failed") return outcome;
  }
  return { status: "ok" };
}

/**
 * Finishes any cascade that was cut short, for example by closing the tab
 * halfway through locking a large folder, or by a note created offline inside
 * a folder that was already locked.
 */
export async function resumeCascades(client: ConvexReactClient): Promise<number> {
  if (!vault.isUnlocked) return 0;
  const database = db();
  const folders = await database.folders.toArray();
  const lockedRoots = folders.filter((f) => f.locked && !f.purged);
  if (lockedRoots.length === 0) return 0;

  const covered = new Set<string>();
  for (const root of lockedRoots) {
    for (const id of subtreeIds(folders, root.folderId)) covered.add(id);
  }

  const notes = await database.notes.toArray();
  const pending = notes.filter(
    (note) =>
      !note.locked &&
      !note.purged &&
      note.deletedAt === null &&
      note.folderId !== null &&
      covered.has(note.folderId),
  );

  let repaired = 0;
  for (const note of pending) {
    const outcome = await lockNote(client, note.noteId);
    if (outcome.status === "ok") repaired += 1;
  }
  return repaired;
}
