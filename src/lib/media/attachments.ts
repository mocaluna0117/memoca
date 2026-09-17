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
import { categoryOf, prepareImage } from "./compress";

/** Block content stores this, not a signed URL, so links survive re-encryption. */
export const REF_PREFIX = "memoca://att/";

export const refFor = (attachmentId: string) => `${REF_PREFIX}${attachmentId}`;
export const idFromRef = (ref: string) =>
  ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : null;

const BLOB_CACHE_BYTES = 200 * 1024 * 1024;
const objectUrls = new Map<string, string>();

export class QuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaError";
  }
}

/**
 * Accepts a file straight away and uploads it in the background.
 *
 * The blob is written to the device first and the editor gets a reference it
 * can render immediately, so dropping a photo works with no connection at all.
 * {@link flushUploads} sends whatever is waiting once there is a network.
 */
export async function stageUpload(opts: {
  noteId: string;
  file: File;
  locked: boolean;
}): Promise<string> {
  const attachmentId = uuidv7();
  const category = categoryOf(opts.file.type);

  const prepared =
    category === "image"
      ? await prepareImage(opts.file)
      : {
          blob: opts.file,
          mime: opts.file.type || "application/octet-stream",
          width: 0,
          height: 0,
        };

  const database = db();
  await database.pendingUploads.put({
    attachmentId,
    noteId: opts.noteId,
    blob: prepared.blob,
    mime: prepared.mime,
    name: opts.file.name,
    width: prepared.width || null,
    height: prepared.height || null,
    category,
    locked: opts.locked,
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
    locked: opts.locked,
    width: prepared.width || null,
    height: prepared.height || null,
    deletedAt: null,
    seq: 0,
  });

  objectUrls.set(attachmentId, URL.createObjectURL(prepared.blob));
  return refFor(attachmentId);
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

      if (item.locked) {
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
        mime: item.locked ? null : item.mime,
        name: item.locked ? null : item.name,
        width: item.width,
        height: item.height,
        locked: item.locked,
        category: item.category,
        ...(wrappedKey ? { wrappedKey } : {}),
        ...(contentIv ? { contentIv } : {}),
        ...(metaSealed ? { metaSealed } : {}),
      });

      if (reservation.status === "already") {
        await database.pendingUploads.delete(item.attachmentId);
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

      await database.blobs.put({
        attachmentId: item.attachmentId,
        blob: item.blob,
        bytes: item.blob.size,
        lastUsed: Date.now(),
      });
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
  const local = await database.blobs.get(attachmentId);
  if (local) {
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

/** Drops decrypted blob URLs, for example when the vault auto-locks. */
export function revokeResolvedUrls(): void {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
}
