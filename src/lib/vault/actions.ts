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
import { discardStaged, purgeLockedBlobs } from "@/lib/media/attachments";
import { purgeMediaCache } from "@/lib/media/media-cache";
import {
  copiesForLock,
  releaseHeldCopies,
  withRelockLock,
  withSwaps,
} from "@/lib/media/relock-copies";
import { reloadDoc, withDetachedDoc } from "@/lib/sync/docs";
import { extractText, firstLine } from "@/lib/sync/ydoc";

export type LockOutcome =
  /**
   * `copiesLeft`, after a lock: files copied in from other notes that could
   * not be given an encrypted copy yet and are still readable where they are.
   */
  | { status: "ok"; copiesLeft?: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

/**
 * The largest snapshot sent inside the mutation itself, matching the server's
 * SNAPSHOT_INLINE_LIMIT (Convex documents stop at 1 MiB). Anything larger is
 * uploaded to storage first, so a long note can be locked too.
 */
const SNAPSHOT_INLINE_LIMIT = 900_000;

async function snapshotArg(
  client: ConvexReactClient,
  bytes: Uint8Array,
  iv?: Uint8Array,
): Promise<{ payload?: ArrayBuffer; storageId?: string; size: number; iv?: ArrayBuffer }> {
  const base = { size: bytes.byteLength, ...(iv ? { iv: toArrayBuffer(iv) } : {}) };
  if (bytes.byteLength <= SNAPSHOT_INLINE_LIMIT) return { ...base, payload: toArrayBuffer(bytes) };
  return { ...base, storageId: await uploadBytes(client, bytes, "application/octet-stream") };
}

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
  opts: { origin?: "note" | "folder" } = {},
): Promise<LockOutcome> {
  // The only pass over the note meanwhile: the editor and the repair pass
  // find it locked and pointing at its copies once this is done.
  return withRelockLock(
    noteId,
    true,
    () => lockOnce(client, noteId, opts.origin ?? "note"),
    () => ({ status: "skipped", reason: "busy" }),
  );
}

async function lockOnce(
  client: ConvexReactClient,
  noteId: string,
  origin: "note" | "folder",
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

  // Sealing the note's own files would leave a file copied in from another
  // note readable on the server, so the note gets an encrypted copy of each,
  // and the version sealed below already points at them. Nothing about the
  // copies reaches the server readable, and a lock that does not go through
  // leaves the note as it was. A file that cannot be copied now does not hold
  // the lock up: the editor and the repair pass keep trying, and the caller
  // says how many are left.
  const copies = await copiesForLock(client, noteId);
  // The copies the sealed version points at, once the server has it.
  let kept = new Set<string>();
  try {
    const epoch = note.keyEpoch + 1;
    const { key, wrapped } = await vault.createNoteKey(noteId, epoch);
    const ts = stamp(await deviceId());

    const { state: merged, used } = await withDetachedDoc(noteId, (doc) => withSwaps(doc, copies.swaps));
    const snapshot = await seal(key, merged, ctx.yjsSnapshot(noteId, epoch));
    const titleSealed = await seal(
      key,
      new TextEncoder().encode(note.title ?? ""),
      ctx.noteTitle(noteId, epoch),
    );

    // Attachments are re-encrypted and re-uploaded; the server deletes the
    // plaintext files as part of the same transaction.
    const attachments = await database.attachments.where("noteId").equals(noteId).toArray();
    const swaps = await sealAttachments(
      client,
      attachments.filter((a) => a.status === "committed" && !a.locked),
    );

    const result = await client.mutation(api.vault.lockNote, {
      noteId,
      keyEpoch: epoch,
      coversThroughSeq: note.lastUpdateSeq,
      wrappedKey: wrapped,
      titleSealed: { ct: toArrayBuffer(titleSealed.ct), iv: toArrayBuffer(titleSealed.iv) },
      snapshot: (await snapshotArg(client, snapshot.ct, snapshot.iv)) as never,
      attachments: swaps as never,
      ts,
      origin,
    });
    if (result.status !== "ok") return { status: "failed", reason: result.reason ?? "" };
    kept = used;
    // Sealed pointing at them: the copies may go up now.
    await releaseHeldCopies(copies.staged.filter((id) => used.has(id)));

    await database.snapshots.put({
      noteId,
      data: snapshot.ct,
      iv: snapshot.iv,
      keyEpoch: epoch,
      throughSeq: note.lastUpdateSeq,
    });
    await database.updates.where("noteId").equals(noteId).delete();
    // The local row changes the same way the server's did, at once: the list
    // must not keep showing the plaintext title until the next pull.
    await database.notes.update(noteId, {
      locked: true,
      keyEpoch: epoch,
      wrappedKey: wrapped,
      lockOrigin: origin,
      title: null,
      titleSealed: { ct: toArrayBuffer(titleSealed.ct), iv: toArrayBuffer(titleSealed.iv) },
      preview: null,
      ts: { ...note.ts, lock: ts, title: ts },
    });
    await database.bodies.put({
      noteId,
      throughSeq: note.lastUpdateSeq,
      keyEpoch: epoch,
      text: null,
      updatedAt: Date.now(),
    });
    // Its files were cached here in plaintext while it was an ordinary note,
    // on disk and by the service worker.
    await purgeLockedBlobs([noteId]);
    if (swaps.length > 0) await purgeMediaCache();
    await reloadDoc(noteId);
    return { status: "ok", copiesLeft: copies.left };
  } finally {
    // Not needed after all: the lock did not go through, or the block went.
    for (const id of copies.staged) {
      if (!kept.has(id)) await discardStaged(id).catch(() => {});
    }
  }
}

/** The exact inverse of {@link lockNote}. */
export async function unlockNote(
  client: ConvexReactClient,
  noteId: string,
): Promise<LockOutcome> {
  // Not while the editor or the repair pass is pointing the note at copies
  // only the vault can show.
  return withRelockLock(
    noteId,
    true,
    () => unlockOnce(client, noteId),
    () => ({ status: "skipped", reason: "busy" }),
  );
}

async function unlockOnce(client: ConvexReactClient, noteId: string): Promise<LockOutcome> {
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
  // Edits still on their way would be written under the old key epoch and
  // refused once the lock is off, so they go first.
  const unpushed = await database.updates
    .where("noteId")
    .equals(noteId)
    .filter((u) => u.pushed === 0)
    .count();
  if (unpushed > 0) return { status: "skipped", reason: "unsent" };
  // Files still on their way would go up encrypted under an ordinary note:
  // only stored ones are turned back. So they go first, a copy the editor
  // just made included.
  if ((await uploadsUnderWay(noteId)) > 0) return { status: "skipped", reason: "uploadPending" };

  const key = await vault.noteKey(noteId, note.keyEpoch, note.wrappedKey);
  const epoch = note.keyEpoch + 1;
  const unlockTs = stamp(await deviceId());
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
    snapshot: (await snapshotArg(client, merged)) as never,
    attachments: swaps as never,
    ts: unlockTs,
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
    lockOrigin: undefined,
    title,
    titleSealed: undefined,
    preview: firstLine(text, 160),
    ts: { ...note.ts, lock: unlockTs, title: unlockTs },
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

/**
 * How many of a note's files this device is still sending, or still to
 * confirm as sent. `plainOnly` counts only those going up in plaintext.
 */
export async function uploadsUnderWay(noteId: string, plainOnly = false): Promise<number> {
  const database = db();
  const files = new Set(
    (
      await database.attachments
        .where("noteId")
        .equals(noteId)
        .filter((file) => !plainOnly || !file.locked)
        .primaryKeys()
    ).map(String),
  );
  const [uploading, committing] = await Promise.all([
    database.pendingUploads
      .where("noteId")
      .equals(noteId)
      .filter((row) => !plainOnly || !row.locked)
      .count(),
    database.outbox
      .where("kind")
      .equals("attachment.commit")
      .filter((op) => files.has(op.entityId))
      .count(),
  ]);
  return uploading + committing;
}

/**
 * Encrypts plaintext attachments under fresh keys and uploads the result,
 * returning the swaps for the server to put in place of the plain files.
 * Files whose storage is gone are left out; the server decides what that
 * means for the lock.
 */
export async function sealAttachments(
  client: ConvexReactClient,
  attachments: { attachmentId: string; name: string | null; mime: string | null }[],
): Promise<Record<string, unknown>[]> {
  const swaps: Record<string, unknown>[] = [];
  for (const attachment of attachments) {
    const urls = await client.query(api.attachments.urls, {
      attachmentIds: [attachment.attachmentId],
    });
    const url = urls[attachment.attachmentId];
    if (!url) continue;
    // Not kept by the browser: the plaintext is about to be deleted.
    const plain = new Uint8Array(await (await fetch(url, { cache: "no-store" })).arrayBuffer());

    const attKey = await vault.createAttachmentKey(attachment.attachmentId);
    const encrypted = await seal(attKey.key, plain, ctx.attachmentBody(attachment.attachmentId));
    const meta = await seal(
      attKey.key,
      new TextEncoder().encode(JSON.stringify({ name: attachment.name, mime: attachment.mime })),
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
  return swaps;
}
