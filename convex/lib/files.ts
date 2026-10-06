import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * What a deleted file's row becomes: a tombstone, kept so every device learns
 * the file is gone and lets go of its own copy. Nothing about the file is
 * kept with it, its name included; `bytes` stays, for the record.
 */
export function fileTombstone(now: number, seq: number) {
  return {
    storageId: null,
    unreferencedAt: null,
    deletedAt: now,
    name: null,
    mime: null,
    width: null,
    height: null,
    metaSealed: undefined,
    wrappedKey: undefined,
    contentIv: undefined,
    seq,
  };
}

/**
 * The size of a file a client says it has just uploaded, read from storage
 * rather than taken from the client; null when there is no such file, or a
 * note or file row already points at it. Counted against the quota, a size
 * the client declared could be anything, and a file two rows pointed at
 * would be deleted under one of them when the other let go of it.
 */
export async function uploadedSize(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
): Promise<number | null> {
  const file = await ctx.db.system.get(storageId);
  if (!file) return null;
  const attachment = await ctx.db
    .query("attachments")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
  if (attachment) return null;
  const snapshot = await ctx.db
    .query("noteSnapshots")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
  if (snapshot) return null;
  const version = await ctx.db
    .query("noteVersions")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
  if (version) return null;
  return file.size;
}
