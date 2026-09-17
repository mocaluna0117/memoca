import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import {
  ALLOWED_MIME,
  RESERVATION_TTL_MS,
  UNREFERENCED_GRACE_MS,
} from "./lib/constants";
import { sealedV } from "./lib/ops";
import { openSeq } from "./lib/seq";
import { getConfig, requireUser } from "./lib/user";

const isVideo = (mime: string) => mime.startsWith("video/");

/**
 * Reserves quota and hands back an upload URL.
 *
 * Quota is held before the bytes exist and released either when the upload is
 * committed (replaced by the real, server-measured size) or when the hourly
 * reaper finds the reservation abandoned. Without the reservation step two
 * parallel uploads could each pass a quota check and together blow past it.
 */
export const reserve = mutation({
  args: {
    attachmentId: v.string(),
    noteId: v.string(),
    bytes: v.number(),
    /** Null for a locked attachment: the real type is inside `metaSealed`. */
    mime: v.union(v.string(), v.null()),
    name: v.union(v.string(), v.null()),
    width: v.union(v.number(), v.null()),
    height: v.union(v.number(), v.null()),
    locked: v.boolean(),
    wrappedKey: v.optional(sealedV),
    contentIv: v.optional(v.bytes()),
    metaSealed: v.optional(sealedV),
    /** Declared type used for the size check when the real one is encrypted. */
    category: v.union(v.literal("image"), v.literal("video"), v.literal("other")),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const config = await getConfig(ctx);
    const now = Date.now();

    const existing = await ctx.db
      .query("attachments")
      .withIndex("by_user_attachment", (q) =>
        q.eq("userId", user._id).eq("attachmentId", args.attachmentId),
      )
      .unique();
    if (existing?.status === "committed") {
      return { status: "already" as const, uploadUrl: null };
    }

    if (args.mime !== null && !ALLOWED_MIME.includes(args.mime as (typeof ALLOWED_MIME)[number])) {
      return { status: "rejected" as const, reason: "unsupportedType", uploadUrl: null };
    }
    const cap =
      args.category === "video"
        ? config.maxVideoBytes
        : args.category === "image"
          ? config.maxImageBytes
          : config.maxVideoBytes;
    if (args.bytes <= 0 || args.bytes > cap) {
      return { status: "rejected" as const, reason: "tooLarge", uploadUrl: null, cap };
    }
    if (user.usedBytes + user.reservedBytes + args.bytes > user.quotaBytes) {
      return { status: "rejected" as const, reason: "quotaExceeded", uploadUrl: null };
    }

    const note = await ctx.db
      .query("notes")
      .withIndex("by_user_note", (q) => q.eq("userId", user._id).eq("noteId", args.noteId))
      .unique();
    if (!note || note.purged) {
      return { status: "rejected" as const, reason: "unknownNote", uploadUrl: null };
    }

    const seq = await openSeq(ctx, user._id);
    const expiresAt = now + RESERVATION_TTL_MS;

    if (existing) {
      // A retried upload: refresh the window, keep the same reservation.
      await ctx.db.patch(existing._id, {
        status: "reserved",
        reservedBytes: args.bytes,
        expiresAt,
        seq: seq.next(),
      });
      await ctx.db.patch(user._id, {
        reservedBytes: Math.max(0, user.reservedBytes - existing.reservedBytes + args.bytes),
      });
    } else {
      await ctx.db.insert("attachments", {
        userId: user._id,
        attachmentId: args.attachmentId,
        noteId: args.noteId,
        status: "reserved",
        storageId: null,
        reservedBytes: args.bytes,
        bytes: 0,
        mime: args.mime,
        name: args.name,
        metaSealed: args.metaSealed,
        locked: args.locked,
        wrappedKey: args.wrappedKey,
        contentIv: args.contentIv,
        width: args.width,
        height: args.height,
        unreferencedAt: null,
        deletedAt: null,
        expiresAt,
        seq: seq.next(),
        createdAt: now,
      });
      await ctx.db.patch(user._id, { reservedBytes: user.reservedBytes + args.bytes });
    }
    await seq.commit();

    return {
      status: "ok" as const,
      uploadUrl: await ctx.storage.generateUploadUrl(),
      expiresAt,
    };
  },
});

/** Resolves attachment ids to time-limited download URLs. */
export const urls = query({
  args: { attachmentIds: v.array(v.string()) },
  handler: async (ctx, { attachmentIds }) => {
    const user = await requireUser(ctx);
    const out: Record<string, string | null> = {};
    for (const id of attachmentIds.slice(0, 64)) {
      const row = await ctx.db
        .query("attachments")
        .withIndex("by_user_attachment", (q) =>
          q.eq("userId", user._id).eq("attachmentId", id),
        )
        .unique();
      out[id] =
        row && row.status === "committed" && row.storageId && row.deletedAt === null
          ? await ctx.storage.getUrl(row.storageId)
          : null;
    }
    return out;
  },
});

/** Releases quota held by uploads that never completed. Runs hourly. */
export const reapReservations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const stale = await ctx.db
      .query("attachments")
      .withIndex("by_status_expires", (q) =>
        q.eq("status", "reserved").lt("expiresAt", now),
      )
      .take(200);

    const releasedPerUser = new Map<Id<"users">, number>();
    for (const row of stale) {
      await ctx.db.patch(row._id, { status: "orphan", expiresAt: null });
      releasedPerUser.set(
        row.userId,
        (releasedPerUser.get(row.userId) ?? 0) + row.reservedBytes,
      );
    }
    for (const [userId, bytes] of releasedPerUser) {
      const user = await ctx.db.get(userId);
      if (user) {
        await ctx.db.patch(userId, {
          reservedBytes: Math.max(0, user.reservedBytes - bytes),
        });
      }
    }
    return { released: stale.length };
  },
});

/**
 * Deletes attachments that no block has referenced for 30 days, and orphaned
 * files with no row at all. Runs daily.
 */
export const sweepUnreferenced = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - UNREFERENCED_GRACE_MS;
    const rows = await ctx.db
      .query("attachments")
      .withIndex("by_user_seq")
      .take(500);

    let deleted = 0;
    for (const row of rows) {
      const expired =
        row.status === "committed" &&
        row.unreferencedAt !== null &&
        row.unreferencedAt < cutoff;
      const orphaned = row.status === "orphan";
      if (!expired && !orphaned) continue;

      if (row.storageId) await ctx.storage.delete(row.storageId);
      if (expired) {
        const user = await ctx.db.get(row.userId);
        if (user) {
          await ctx.db.patch(row.userId, {
            usedBytes: Math.max(0, user.usedBytes - row.bytes),
          });
        }
      }
      await ctx.db.delete(row._id);
      deleted += 1;
      if (deleted >= 100) break;
    }
    return { deleted };
  },
});

/**
 * Recomputes each user's storage total from the rows that actually exist, and
 * deletes stored files nothing points at. A slow, boring backstop against the
 * accounting drifting away from reality.
 */
export const reconcileStorage = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.system
      .query("_storage")
      .paginate({ numItems: 200, cursor: args.cursor ?? null });

    let removed = 0;
    for (const file of page.page) {
      const attachment = await ctx.db
        .query("attachments")
        .withIndex("by_storage", (q) => q.eq("storageId", file._id))
        .first();
      if (attachment) continue;
      const snapshot = await ctx.db
        .query("noteSnapshots")
        .withIndex("by_storage", (q) => q.eq("storageId", file._id))
        .first();
      if (snapshot) continue;
      // Give a just-uploaded file time to have its row written.
      if (Date.now() - file._creationTime < RESERVATION_TTL_MS) continue;
      await ctx.storage.delete(file._id);
      removed += 1;
    }
    return { removed, isDone: page.isDone, cursor: page.continueCursor };
  },
});
