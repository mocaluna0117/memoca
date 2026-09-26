import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  type MutationCtx,
  type QueryCtx,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { PULL_BYTE_BUDGET, SNAPSHOT_INLINE_LIMIT } from "./lib/constants";
import { openSeq } from "./lib/seq";
import { requireUser } from "./lib/user";

const PRUNE_BATCH = 500;

const findNote = (ctx: QueryCtx, userId: Id<"users">, noteId: string) =>
  ctx.db
    .query("notes")
    .withIndex("by_user_note", (q) => q.eq("userId", userId).eq("noteId", noteId))
    .unique();

const findSnapshot = (ctx: QueryCtx, userId: Id<"users">, noteId: string) =>
  ctx.db
    .query("noteSnapshots")
    .withIndex("by_user_note", (q) => q.eq("userId", userId).eq("noteId", noteId))
    .unique();

/**
 * Fetches note bodies for the notes a device is actually behind on.
 *
 * `haveThroughSeq` is how far the device's local Yjs document already reaches.
 * Anything at or below that is skipped, which is what keeps opening the app on
 * a synced device close to free. Yjs merges are idempotent, so sending a little
 * overlap is harmless.
 */
export const getBodies = query({
  args: {
    items: v.array(v.object({ noteId: v.string(), haveThroughSeq: v.number() })),
  },
  handler: async (ctx, { items }) => {
    const user = await requireUser(ctx);
    let budget = PULL_BYTE_BUDGET;
    const bodies: {
      noteId: string;
      keyEpoch: number;
      lastUpdateSeq: number;
      snapshot: {
        coversThroughSeq: number;
        size: number;
        payload?: ArrayBuffer;
        url?: string;
        iv?: ArrayBuffer;
      } | null;
      updates: {
        opId: string;
        keyEpoch: number;
        payload: ArrayBuffer;
        iv?: ArrayBuffer;
        seq: number;
      }[];
    }[] = [];
    let truncated = false;

    for (const item of items.slice(0, 64)) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      const note = await findNote(ctx, user._id, item.noteId);
      if (!note || note.purged) continue;

      const snapRow = await findSnapshot(ctx, user._id, item.noteId);
      let snapshot = null;
      let from = item.haveThroughSeq;

      if (snapRow && snapRow.coversThroughSeq > item.haveThroughSeq) {
        snapshot = {
          coversThroughSeq: snapRow.coversThroughSeq,
          size: snapRow.size,
          // Large snapshots live in file storage and are fetched over HTTP so
          // they do not have to travel through a Convex query response.
          payload: snapRow.payload,
          url: snapRow.storageId
            ? ((await ctx.storage.getUrl(snapRow.storageId)) ?? undefined)
            : undefined,
          iv: snapRow.iv,
        };
        from = snapRow.coversThroughSeq;
        budget -= snapRow.size;
      }

      const updateRows = await ctx.db
        .query("noteUpdates")
        .withIndex("by_note_seq", (q) =>
          q.eq("userId", user._id).eq("noteId", item.noteId).gt("seq", from),
        )
        .take(400);

      const updates: (typeof bodies)[number]["updates"] = [];
      for (const row of updateRows) {
        if (updates.length > 0 && budget - row.size < 0) {
          truncated = true;
          break;
        }
        updates.push({
          opId: row.opId,
          keyEpoch: row.keyEpoch,
          payload: row.payload,
          iv: row.iv,
          seq: row.seq,
        });
        budget -= row.size;
      }

      bodies.push({
        noteId: note.noteId,
        keyEpoch: note.keyEpoch,
        lastUpdateSeq: note.lastUpdateSeq,
        snapshot,
        updates,
      });
    }

    return { bodies, truncated };
  },
});

/** Upload target for a snapshot too large to inline in a document. */
export const snapshotUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Replaces a note's accumulated Yjs updates with a single merged snapshot.
 *
 * Only a client can do this, because a locked note's updates are ciphertext the
 * server cannot merge. `coversThroughSeq` must equal the note's newest update:
 * that is the proof the caller had seen every update it is about to delete.
 * Peers are safe because the new snapshot header travels in the same feed, and
 * a device whose local copy is older than the snapshot refetches on sight.
 */
export const compact = mutation({
  args: {
    noteId: v.string(),
    keyEpoch: v.number(),
    coversThroughSeq: v.number(),
    payload: v.optional(v.bytes()),
    storageId: v.optional(v.id("_storage")),
    size: v.number(),
    iv: v.optional(v.bytes()),
    /**
     * Sent by older clients and ignored: it listed this device's files for
     * the note, not the ones it uses. Uses come from attachments.reportRefs.
     */
    referenced: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const note = await findNote(ctx, user._id, args.noteId);
    if (!note || note.purged) {
      return { status: "rejected" as const, reason: "unknownNote" };
    }
    if (note.keyEpoch !== args.keyEpoch) {
      return { status: "rejected" as const, reason: "epochMismatch" };
    }
    if (args.coversThroughSeq !== note.lastUpdateSeq) {
      return { status: "rejected" as const, reason: "behind" };
    }
    if (note.locked && !args.iv) {
      return { status: "rejected" as const, reason: "plaintextIntoLockedNote" };
    }
    if (!args.payload && !args.storageId) {
      return { status: "rejected" as const, reason: "emptySnapshot" };
    }
    if (args.payload && args.payload.byteLength > SNAPSHOT_INLINE_LIMIT) {
      return { status: "rejected" as const, reason: "snapshotTooLargeInline" };
    }

    const seq = await openSeq(ctx, user._id);
    const now = Date.now();

    const previous = await findSnapshot(ctx, user._id, args.noteId);
    if (previous) {
      if (previous.storageId) await ctx.storage.delete(previous.storageId);
      await ctx.db.delete(previous._id);
    }

    await ctx.db.insert("noteSnapshots", {
      userId: user._id,
      noteId: args.noteId,
      keyEpoch: args.keyEpoch,
      coversThroughSeq: args.coversThroughSeq,
      payload: args.payload,
      storageId: args.storageId,
      iv: args.iv,
      size: args.size,
      seq: seq.next(),
      createdAt: now,
    });

    const remaining = await pruneUpdatesUpTo(
      ctx,
      user._id,
      args.noteId,
      args.coversThroughSeq,
      PRUNE_BATCH,
    );
    if (remaining) {
      await ctx.scheduler.runAfter(0, internal.notes.pruneUpdates, {
        userId: user._id,
        noteId: args.noteId,
        throughSeq: args.coversThroughSeq,
      });
    }

    await ctx.db.patch(note._id, {
      snapshotSeq: args.coversThroughSeq,
      sinceSnapshot: { count: 0, bytes: 0 },
      bodyBytes: args.size,
    });
    await ctx.db.patch(user._id, {
      usedBytes: Math.max(0, user.usedBytes - note.bodyBytes + args.size),
    });
    await seq.commit();

    return { status: "ok" as const };
  },
});

async function pruneUpdatesUpTo(
  ctx: MutationCtx,
  userId: Id<"users">,
  noteId: string,
  throughSeq: number,
  batch: number,
): Promise<boolean> {
  const rows = await ctx.db
    .query("noteUpdates")
    .withIndex("by_note_seq", (q) =>
      q.eq("userId", userId).eq("noteId", noteId).lte("seq", throughSeq),
    )
    .take(batch + 1);
  const more = rows.length > batch;
  for (const row of rows.slice(0, batch)) await ctx.db.delete(row._id);
  return more;
}

export const pruneUpdates = internalMutation({
  args: { userId: v.id("users"), noteId: v.string(), throughSeq: v.number() },
  handler: async (ctx, args) => {
    const more = await pruneUpdatesUpTo(
      ctx,
      args.userId,
      args.noteId,
      args.throughSeq,
      PRUNE_BATCH,
    );
    if (more) {
      await ctx.scheduler.runAfter(0, internal.notes.pruneUpdates, args);
    }
  },
});

/**
 * Full metadata for one note, used when a device opens a note it has never
 * seen (for example from a shared link or a deep link into search results).
 */
export const get = query({
  args: { noteId: v.string() },
  handler: async (ctx, { noteId }) => {
    const user = await requireUser(ctx);
    const note = await findNote(ctx, user._id, noteId);
    if (!note || note.purged) return null;
    return note;
  },
});

export function assertOwned(user: Doc<"users">, row: { userId: Id<"users"> }) {
  if (row.userId !== user._id) {
    throw new ConvexError({ code: "FORBIDDEN", message: "権限がありません。" });
  }
}
