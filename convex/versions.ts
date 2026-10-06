import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, internalMutation, mutation, query } from "./_generated/server";
import { uploadedSize } from "./lib/files";
import { requireUser } from "./lib/user";
import { VERSION_GAP_MS, VERSION_KEEP_MS, versionsToDrop } from "./lib/versions";

const versionsOf = (ctx: MutationCtx, userId: Id<"users">, noteId: string) =>
  ctx.db
    .query("noteVersions")
    .withIndex("by_user_note_created", (q) => q.eq("userId", userId).eq("noteId", noteId))
    .order("desc")
    .take(500);

async function drop(ctx: MutationCtx, version: Doc<"noteVersions">) {
  await ctx.storage.delete(version.storageId);
  await ctx.db.delete(version._id);
}

/** Lets go of every version of a note: when it is purged, locked or unlocked. */
export async function dropVersions(ctx: MutationCtx, userId: Id<"users">, noteId: string) {
  for (const version of await versionsOf(ctx, userId, noteId)) await drop(ctx, version);
}

/**
 * Keeps a version of a note: its whole state, as a device has it, uploaded
 * to file storage first (notes.snapshotUploadUrl), sealed as the note's
 * updates are when it is locked. One at most every ten minutes
 * ("tooSoon" otherwise), unless `beforeRestore`: the note as it was just
 * before an earlier version was put back, so that can be undone too. Fewer
 * are kept the older they are (versionsToDrop).
 */
export const save = mutation({
  args: {
    noteId: v.string(),
    keyEpoch: v.number(),
    storageId: v.id("_storage"),
    iv: v.optional(v.bytes()),
    beforeRestore: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    // An upload not taken is let go of at once, unless something else has it.
    const refuse = async (reason: string) => {
      if ((await uploadedSize(ctx, args.storageId)) !== null)
        await ctx.storage.delete(args.storageId);
      return { status: "rejected" as const, reason };
    };
    const note = await ctx.db
      .query("notes")
      .withIndex("by_user_note", (q) => q.eq("userId", user._id).eq("noteId", args.noteId))
      .unique();
    if (!note || note.purged) return refuse("unknownNote");
    if (note.keyEpoch !== args.keyEpoch) return refuse("epochMismatch");
    if (note.locked && !args.iv) return refuse("plaintextIntoLockedNote");

    const now = Date.now();
    const versions = await versionsOf(ctx, user._id, args.noteId);
    if (!args.beforeRestore && versions[0] && now - versions[0].createdAt < VERSION_GAP_MS) {
      return refuse("tooSoon");
    }
    const size = await uploadedSize(ctx, args.storageId);
    if (size === null) return refuse("missingUpload");

    await ctx.db.insert("noteVersions", {
      userId: user._id,
      noteId: args.noteId,
      keyEpoch: args.keyEpoch,
      storageId: args.storageId,
      iv: args.iv,
      size,
      createdAt: now,
    });
    for (const old of versionsToDrop(versions, now)) await drop(ctx, old);
    return { status: "ok" as const };
  },
});

/** A note's versions, newest first: when each was kept, and its size. */
export const list = query({
  args: { noteId: v.string() },
  handler: async (ctx, { noteId }) => {
    const user = await requireUser(ctx);
    const rows = await ctx.db
      .query("noteVersions")
      .withIndex("by_user_note_created", (q) => q.eq("userId", user._id).eq("noteId", noteId))
      .order("desc")
      .take(200);
    return rows.map((row) => ({
      versionId: row._id,
      createdAt: row.createdAt,
      size: row.size,
      keyEpoch: row.keyEpoch,
    }));
  },
});

/** Where to download one version's state from, and how it is sealed. */
export const get = query({
  args: { versionId: v.id("noteVersions") },
  handler: async (ctx, { versionId }) => {
    const user = await requireUser(ctx);
    const row = await ctx.db.get(versionId);
    if (!row || row.userId !== user._id) return null;
    return {
      noteId: row.noteId,
      keyEpoch: row.keyEpoch,
      createdAt: row.createdAt,
      url: await ctx.storage.getUrl(row.storageId),
      iv: row.iv ?? null,
    };
  },
});

/** Lets go of versions past 30 days, a page at a time: for notes no longer edited, whose saves would. */
export const expire = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db
      .query("noteVersions")
      .withIndex("by_created", (q) => q.lt("createdAt", Date.now() - VERSION_KEEP_MS))
      .take(200);
    for (const version of old) await drop(ctx, version);
    return { dropped: old.length };
  },
});
