"use client";

import type { ConvexReactClient } from "convex/react";
import { uuidv7 } from "uuidv7";
import { api } from "@convex/_generated/api";
import { toArrayBuffer } from "@/lib/bytes";
import { ctx } from "@/lib/crypto/context";
import { open, seal } from "@/lib/crypto/primitives";
import { vault } from "@/lib/crypto/vault";
import { db } from "@/lib/db";
import { enqueue } from "@/lib/sync/outbox";
import { type PreparedImage, categoryOf, prepareImage } from "./compress";

/** Block content stores this, not a signed URL, so links survive re-encryption. */
export const REF_PREFIX = "memoca://att/";

export const refFor = (attachmentId: string) => `${REF_PREFIX}${attachmentId}`;
export const idFromRef = (ref: string) =>
  ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : null;

const BLOB_CACHE_BYTES = 200 * 1024 * 1024;
const objectUrls = new Map<string, string>();

/** How long to wait for a file from the server before calling it unreachable. */
const DOWNLOAD_TIMEOUT_MS = 20_000;

export class QuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaError";
  }
}

/** A file this device cannot get at: `offline` when it needs a network there is not. */
export class AttachmentUnavailableError extends Error {
  constructor(readonly reason: "offline" | "missing") {
    super(reason);
    this.name = "AttachmentUnavailableError";
  }
}

/** The account figures the server checks a reservation against, as `users.me` reports them. */
type Allowance = {
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
  limits?: { maxImageBytes: number };
};

/**
 * Whether the server will accept an image of this size.
 *
 * Asked before staging, because a refusal later, in {@link flushUploads},
 * happens in the background with nobody to tell, and leaves the block
 * pointing at a file that is gone. `queued` is what this device is still to
 * send (see {@link queuedBytes}): the server's figures do not know about it,
 * and offline they never catch up.
 */
export function fitsAllowance(me: Allowance, bytes: number, queued = 0): boolean {
  if (me.limits && bytes > me.limits.maxImageBytes) return false;
  return me.usedBytes + me.reservedBytes + queued + bytes <= me.quotaBytes;
}

/**
 * The size of every file waiting in this device's upload queue. A file whose
 * reservation has already been made is counted by the server too; counting it
 * twice for the moment only makes {@link fitsAllowance} stricter.
 */
export async function queuedBytes(): Promise<number> {
  const waiting = await db().pendingUploads.toArray();
  return waiting.reduce((sum, row) => sum + row.blob.size, 0);
}

/**
 * Whether a file is kept encrypted: it is marked locked, or it belongs to a
 * locked note that has yet to encrypt it. A copy of it may only go where it
 * will be encrypted as well.
 */
export async function isLockedFile(attachmentId: string): Promise<boolean> {
  const database = db();
  const row = await database.attachments.get(attachmentId);
  if (!row) return false;
  return row.locked || (await database.notes.get(row.noteId))?.locked === true;
}

/**
 * Accepts a file straight away and uploads it in the background.
 *
 * The blob is written to the device first and the editor gets a reference it
 * can render immediately, so dropping a photo works with no connection at all.
 * {@link flushUploads} sends whatever is waiting once there is a network.
 *
 * `prepared` is an image that has already been encoded, such as a crop, so it
 * is not compressed a second time.
 */
export async function stageUpload(opts: {
  noteId: string;
  file: File;
  locked?: boolean;
  prepared?: PreparedImage;
}): Promise<string> {
  const attachmentId = uuidv7();
  const category = categoryOf(opts.prepared?.mime ?? opts.file.type);

  const prepared =
    opts.prepared ??
    (category === "image"
      ? await prepareImage(opts.file)
      : {
          blob: opts.file,
          mime: opts.file.type || "application/octet-stream",
          width: 0,
          height: 0,
        });

  const database = db();
  // Read now, not when the editor was set up: the note may have been locked
  // since, and a locked note's file is marked as one from the start.
  const locked = opts.locked === true || (await database.notes.get(opts.noteId))?.locked === true;
  await database.pendingUploads.put({
    attachmentId,
    noteId: opts.noteId,
    blob: prepared.blob,
    mime: prepared.mime,
    name: opts.file.name,
    width: prepared.width || null,
    height: prepared.height || null,
    category,
    locked,
    createdAt: Date.now(),
  });

  // A local row so the note list and the editor can see it before it uploads.
  await database.attachments.put({
    attachmentId,
    noteId: opts.noteId,
    status: "reserved",
    bytes: prepared.blob.size,
    mime: prepared.mime,
    name: opts.file.name,
    locked,
    width: prepared.width || null,
    height: prepared.height || null,
    deletedAt: null,
    seq: 0,
  });

  objectUrls.set(attachmentId, URL.createObjectURL(prepared.blob));
  return refFor(attachmentId);
}

/**
 * Takes back a file staged a moment ago that turned out not to be needed,
 * before anything refers to it.
 */
export async function discardStaged(attachmentId: string): Promise<void> {
  const database = db();
  await database.pendingUploads.delete(attachmentId);
  const row = await database.attachments.get(attachmentId);
  if (row?.status === "reserved") await database.attachments.delete(attachmentId);
  const url = objectUrls.get(attachmentId);
  if (url) URL.revokeObjectURL(url);
  objectUrls.delete(attachmentId);
}

/**
 * Sends everything waiting in the upload queue.
 *
 * Reserving quota before the bytes move is what stops two uploads from each
 * passing a check and together exceeding the allowance; the server replaces the
 * reservation with the real measured size at commit time.
 */
export async function flushUploads(client: ConvexReactClient): Promise<void> {
  const database = db();
  const pending = await database.pendingUploads.toArray();

  for (const item of pending) {
    try {
      let body: Blob = item.blob;
      let wrappedKey: { ct: ArrayBuffer; iv: ArrayBuffer } | undefined;
      let contentIv: ArrayBuffer | undefined;
      let metaSealed: { ct: ArrayBuffer; iv: ArrayBuffer } | undefined;
      // Read again now: the note may have been locked since the file was
      // added, and a locked note's file must go up encrypted.
      const note = await database.notes.get(item.noteId);
      const locked = item.locked || note?.locked === true;

      if (locked) {
        if (!vault.isUnlocked) continue; // Retried after the vault opens.
        const key = await vault.createAttachmentKey(item.attachmentId);
        const plain = new Uint8Array(await item.blob.arrayBuffer());
        const sealed = await seal(key.key, plain, ctx.attachmentBody(item.attachmentId));
        const meta = await seal(
          key.key,
          new TextEncoder().encode(JSON.stringify({ name: item.name, mime: item.mime })),
          ctx.attachmentMeta(item.attachmentId),
        );
        body = new Blob([toArrayBuffer(sealed.ct)], { type: "application/octet-stream" });
        wrappedKey = key.wrapped;
        contentIv = toArrayBuffer(sealed.iv);
        metaSealed = { ct: toArrayBuffer(meta.ct), iv: toArrayBuffer(meta.iv) };
      }

      const reservation = await client.mutation(api.attachments.reserve, {
        attachmentId: item.attachmentId,
        noteId: item.noteId,
        bytes: body.size,
        mime: locked ? null : item.mime,
        name: locked ? null : item.name,
        width: item.width,
        height: item.height,
        locked,
        category: item.category,
        ...(wrappedKey ? { wrappedKey } : {}),
        ...(contentIv ? { contentIv } : {}),
        ...(metaSealed ? { metaSealed } : {}),
      });

      if (reservation.status === "already") {
        await database.pendingUploads.delete(item.attachmentId);
        continue;
      }
      if (reservation.status === "rejected" && reservation.reason === "lockMismatch") {
        // The server knows the note is locked before this device does. Keep
        // the file, and send it encrypted on the next pass.
        await database.pendingUploads.update(item.attachmentId, { locked: true });
        continue;
      }
      if (reservation.status === "rejected" || !reservation.uploadUrl) {
        await database.pendingUploads.delete(item.attachmentId);
        await database.attachments.delete(item.attachmentId);
        throw new QuotaError(reservation.reason ?? "rejected");
      }

      const response = await fetch(reservation.uploadUrl, {
        method: "POST",
        headers: { "Content-Type": body.type || "application/octet-stream" },
        body,
      });
      const { storageId } = (await response.json()) as { storageId: string };

      // The commit goes through the outbox so a lost response replays safely.
      await enqueue({
        kind: "attachment.commit",
        entityId: item.attachmentId,
        payload: {
          kind: "attachment.commit",
          attachmentId: item.attachmentId,
          storageId,
        },
      });

      // Only plain files are cached: a locked note's file must not sit on the
      // device in plaintext.
      if (!locked) {
        await database.blobs.put({
          attachmentId: item.attachmentId,
          blob: item.blob,
          bytes: item.blob.size,
          lastUsed: Date.now(),
        });
      }
      await database.pendingUploads.delete(item.attachmentId);
    } catch (error) {
      if (error instanceof QuotaError) throw error;
      // Anything else (offline, transient failure) is retried next drain.
      return;
    }
  }

  await trimBlobCache();
}

async function trimBlobCache(): Promise<void> {
  const database = db();
  const rows = await database.blobs.orderBy("lastUsed").toArray();
  let total = rows.reduce((sum, row) => sum + row.bytes, 0);
  for (const row of rows) {
    if (total <= BLOB_CACHE_BYTES) break;
    await database.blobs.delete(row.attachmentId);
    total -= row.bytes;
  }
}

/**
 * Turns a `memoca://` reference into something an `<img>` or `<video>` can use.
 *
 * Locked attachments are downloaded and decrypted here, so their plaintext
 * exists only as a blob URL inside this tab.
 */
export async function resolveAttachment(
  client: ConvexReactClient,
  attachmentId: string,
): Promise<string | null> {
  const cached = objectUrls.get(attachmentId);
  if (cached) return cached;

  const database = db();
  const row0 = await database.attachments.get(attachmentId);
  const local = await database.blobs.get(attachmentId);
  if (local && row0?.locked) {
    // A plaintext copy of a locked file, left by an earlier version.
    await database.blobs.delete(attachmentId);
  } else if (local) {
    await database.blobs.update(attachmentId, { lastUsed: Date.now() });
    const url = URL.createObjectURL(local.blob);
    objectUrls.set(attachmentId, url);
    return url;
  }

  const waiting = await database.pendingUploads.get(attachmentId);
  if (waiting) {
    const url = URL.createObjectURL(waiting.blob);
    objectUrls.set(attachmentId, url);
    return url;
  }

  const row = await database.attachments.get(attachmentId);
  if (!row || row.status !== "committed") return null;

  const urls = await client.query(api.attachments.urls, { attachmentIds: [attachmentId] });
  const remote = urls[attachmentId];
  if (!remote) return null;

  if (!row.locked) {
    // Plain files are served straight from storage and cached by the service
    // worker; no need to hold a copy in memory.
    return remote;
  }
  if (!row.wrappedKey || !row.contentIv || !vault.isUnlocked) return null;

  const key = await vault.attachmentKey(attachmentId, row.wrappedKey);
  const cipher = new Uint8Array(await (await fetch(remote)).arrayBuffer());
  const plain = await open(
    key,
    cipher,
    new Uint8Array(row.contentIv),
    ctx.attachmentBody(attachmentId),
  );

  let mime = "application/octet-stream";
  if (row.metaSealed) {
    const raw = await open(
      key,
      new Uint8Array(row.metaSealed.ct),
      new Uint8Array(row.metaSealed.iv),
      ctx.attachmentMeta(attachmentId),
    );
    mime = (JSON.parse(new TextDecoder().decode(raw)) as { mime: string }).mime;
  }

  const url = URL.createObjectURL(new Blob([toArrayBuffer(plain)], { type: mime }));
  objectUrls.set(attachmentId, url);
  return url;
}

/**
 * The bytes of an attachment, for work such as trimming an image.
 *
 * Looks on the device first: a file still waiting to upload, then the cache
 * of plain files. A locked file's plaintext is never in that cache, so it
 * comes from this tab's decrypted copy, or is downloaded and decrypted again.
 * Anything that needs the server and cannot reach it in time is reported as
 * `offline`, rather than left waiting for a connection that may not come.
 */
export async function loadAttachmentBlob(
  client: ConvexReactClient,
  attachmentId: string,
): Promise<Blob> {
  const database = db();
  const waiting = await database.pendingUploads.get(attachmentId);
  if (waiting) return waiting.blob;

  const row = await database.attachments.get(attachmentId);
  if (!row?.locked) {
    const local = await database.blobs.get(attachmentId);
    if (local) return local.blob;
  }

  if (!objectUrls.has(attachmentId) && !navigator.onLine) {
    throw new AttachmentUnavailableError("offline");
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AttachmentUnavailableError("offline")),
      DOWNLOAD_TIMEOUT_MS,
    );
  });
  const download = async () => {
    const url = await resolveAttachment(client, attachmentId);
    if (!url) throw new AttachmentUnavailableError("missing");
    const response = await fetch(url).catch(() => {
      throw new AttachmentUnavailableError(navigator.onLine ? "missing" : "offline");
    });
    if (!response.ok) throw new AttachmentUnavailableError("missing");
    return response.blob();
  };
  try {
    return await Promise.race([download(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deletes plaintext copies of locked notes' files from the device cache.
 * Earlier versions kept them after locking; needs no vault.
 */
export async function purgeLockedBlobs(noteIds?: string[]): Promise<number> {
  const database = db();
  const lockedNotes = new Set(
    noteIds ?? (await database.notes.filter((n) => n.locked).primaryKeys()).map(String),
  );
  const cached = new Set((await database.blobs.toCollection().primaryKeys()).map(String));
  const doomed = (await database.attachments.toArray())
    .filter((a) => cached.has(a.attachmentId) && (a.locked || lockedNotes.has(a.noteId)))
    .map((a) => a.attachmentId);
  await database.blobs.bulkDelete(doomed);
  for (const id of doomed) {
    const url = objectUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    objectUrls.delete(id);
  }
  return doomed.length;
}

/** Drops decrypted blob URLs, for example when the vault auto-locks. */
export function revokeResolvedUrls(): void {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
}
