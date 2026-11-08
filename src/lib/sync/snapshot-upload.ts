"use client";

import type { ConvexReactClient } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { toArrayBuffer } from "@/lib/bytes";

/**
 * The largest snapshot sent inside the mutation itself, matching the server's
 * SNAPSHOT_INLINE_LIMIT (Convex documents stop at 1 MiB). Anything larger is
 * uploaded to storage first, so a long note can be locked, or compacted, too.
 */
export const SNAPSHOT_INLINE_LIMIT = 900_000;

/** A snapshot as a mutation takes it: inline when small enough, else by the file it was uploaded as. */
export async function snapshotArg(
  client: ConvexReactClient,
  bytes: Uint8Array,
  iv?: Uint8Array,
): Promise<{ payload?: ArrayBuffer; storageId?: Id<"_storage">; size: number; iv?: ArrayBuffer }> {
  const base = { size: bytes.byteLength, ...(iv ? { iv: toArrayBuffer(iv) } : {}) };
  if (bytes.byteLength <= SNAPSHOT_INLINE_LIMIT) return { ...base, payload: toArrayBuffer(bytes) };
  return { ...base, storageId: await uploadBytes(client, bytes, "application/octet-stream") };
}

/** Uploads bytes to the server's file storage; the id they are kept under. */
export async function uploadBytes(
  client: ConvexReactClient,
  bytes: Uint8Array,
  contentType: string,
): Promise<Id<"_storage">> {
  const uploadUrl = await client.mutation(api.notes.snapshotUploadUrl, {});
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: new Blob([toArrayBuffer(bytes)]),
  });
  if (!response.ok) throw new Error(`upload refused: ${response.status}`);
  const { storageId } = (await response.json()) as { storageId?: unknown };
  if (typeof storageId !== "string") throw new Error("upload answered without a file");
  return storageId as Id<"_storage">;
}
