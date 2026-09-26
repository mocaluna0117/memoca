import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import {
  ALLOWED_MIME,
  MAX_REFS_PER_NOTE,
  RESERVATION_TTL_MS,
  SWEEP_BATCH,
  UNREFERENCED_GRACE_MS,
} from "./lib/constants";
import { sealedV } from "./lib/ops";
import { allNotesReported, isInUse, settleUse } from "./lib/refs";
import { openSeq } from "./lib/seq";
import { fileTombstone } from "./lib/files";
import { getConfig, requireUser } from "./lib/user";

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
    // A plaintext file for a locked note would sit readable on the server
    // for as long as it is stored. The client encrypts and asks again.
    if (note.locked && !args.locked) {
      return { status: "rejected" as const, reason: "lockMismatch", uploadUrl: null };
    }

    const seq = await openSeq(ctx, user._id);
    const expiresAt = now + RESERVATION_TTL_MS;

    if (existing) {
      // A retried upload: refresh the window, keep the same reservation. One
      // the reaper let go of holds nothing any more, so none is given back.
      const held = existing.status === "reserved" ? existing.reservedBytes : 0;
      await ctx.db.patch(existing._id, {
        status: "reserved",
        reservedBytes: args.bytes,
        expiresAt,
        seq: seq.next(),
      });
      await ctx.db.patch(user._id, {
        reservedBytes: Math.max(0, user.reservedBytes - held + args.bytes),
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
        category: args.category,
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
 * A device reports which files a note uses, read from its copy of the note.
 *
 * Accepted only when that copy is the server's latest (`throughSeq` equals the
 * note's `lastUpdateSeq`): a device that has not caught up could otherwise
 * report a file as gone that another device just added. Files that end up
 * named by no note are marked unused from now; files named again are unmarked.
 * The note's own files are checked too, which covers files it stopped using
 * before reports existed.
 */
export const reportRefs = mutation({
  args: {
    noteId: v.string(),
    throughSeq: v.number(),
    refs: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    if (args.refs.length > MAX_REFS_PER_NOTE || args.refs.some((id) => id.length > 64)) {
      return { status: "rejected" as const, reason: "tooMany" };
    }
    const note = await ctx.db
      .query("notes")
      .withIndex("by_user_note", (q) => q.eq("userId", user._id).eq("noteId", args.noteId))
      .unique();
    if (!note || note.purged) return { status: "rejected" as const, reason: "unknownNote" };
    if (args.throughSeq !== note.lastUpdateSeq) return { status: "stale" as const };

    const now = Date.now();
    const wanted = new Set(args.refs);
    const existing = await ctx.db
      .query("attachmentRefs")
      .withIndex("by_user_note", (q) => q.eq("userId", user._id).eq("noteId", args.noteId))
      .take(MAX_REFS_PER_NOTE + 1);
    const had = new Set(existing.map((row) => row.attachmentId));
    const changed: string[] = [];
    for (const row of existing) {
      if (wanted.has(row.attachmentId)) continue;
      await ctx.db.delete("attachmentRefs", row._id);
      changed.push(row.attachmentId);
    }
    for (const attachmentId of wanted) {
      if (had.has(attachmentId)) continue;
      await ctx.db.insert("attachmentRefs", { userId: user._id, noteId: args.noteId, attachmentId });
      changed.push(attachmentId);
    }
    const own = await ctx.db
      .query("attachments")
      .withIndex("by_user_note", (q) => q.eq("userId", user._id).eq("noteId", args.noteId))
      .take(MAX_REFS_PER_NOTE);
    await settleUse(ctx, user._id, [...changed, ...own.map((row) => row.attachmentId)], now);

    // Other devices learn the note is reported, so they do not report it again.
    const seq = await openSeq(ctx, user._id);
    await ctx.db.patch("notes", note._id, { refsThroughSeq: args.throughSeq, seq: seq.next() });
    await seq.commit();
    return { status: "ok" as const };
  },
});

/**
 * Deletes files that no note has used for 30 days, and uploads that never
 * completed. Runs daily; `now` exists for tests.
 *
 * A file is deleted only while every note of its owner has reported the files
 * it uses as of its latest change, so a use nobody has reported yet cannot be
 * missed. The row stays as a tombstone so devices drop their copies.
 */
export const sweepUnreferenced = internalMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const cutoff = now - UNREFERENCED_GRACE_MS;

    const orphans = await ctx.db
      .query("attachments")
      .withIndex("by_status_expires", (q) => q.eq("status", "orphan"))
      .take(SWEEP_BATCH);
    for (const row of orphans) {
      if (row.storageId) await ctx.storage.delete(row.storageId);
      await ctx.db.delete("attachments", row._id);
    }

    const expired = ctx.db
      .query("attachments")
      .withIndex("by_unreferenced", (q) => q.gt("unreferencedAt", 0).lt("unreferencedAt", cutoff));
    const ready = new Map<Id<"users">, boolean>();
    const freed = new Map<Id<"users">, number>();
    const writers = new Map<Id<"users">, Awaited<ReturnType<typeof openSeq>>>();
    let deleted = 0;
    let waiting = 0;
    let scanned = 0;
    // Read past files whose owner is not ready yet, so one user's pending
    // reports cannot hold everyone else's deletions back; but only so far.
    for await (const row of expired) {
      scanned += 1;
      if (scanned > SWEEP_BATCH * 10 || deleted >= SWEEP_BATCH) break;
      if (row.status !== "committed" || row.deletedAt !== null) continue;
      if (await isInUse(ctx, row.userId, row.attachmentId)) {
        await ctx.db.patch("attachments", row._id, { unreferencedAt: null });
        continue;
      }
      if (!ready.has(row.userId)) ready.set(row.userId, await allNotesReported(ctx, row.userId));
      if (!ready.get(row.userId)) {
        waiting += 1;
        continue;
      }
      let seq = writers.get(row.userId);
      if (!seq) {
        seq = await openSeq(ctx, row.userId);
        writers.set(row.userId, seq);
      }
      if (row.storageId) await ctx.storage.delete(row.storageId);
      await ctx.db.patch("attachments", row._id, fileTombstone(now, seq.next()));
      freed.set(row.userId, (freed.get(row.userId) ?? 0) + row.bytes);
      deleted += 1;
    }
    for (const [userId, bytes] of freed) {
      const user = await ctx.db.get("users", userId);
      if (user) await ctx.db.patch("users", userId, { usedBytes: Math.max(0, user.usedBytes - bytes) });
    }
    for (const seq of writers.values()) await seq.commit();
    return { orphans: orphans.length, deleted, waiting };
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
