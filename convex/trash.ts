import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, internalMutation, mutation } from "./_generated/server";
import { MAX_REFS_PER_NOTE, TOMBSTONE_MS } from "./lib/constants";
import { dropNoteRefs, isInUse, settleUse } from "./lib/refs";
import { type SeqWriter, openSeq } from "./lib/seq";
import { requireUser } from "./lib/user";

/** Notes purged per transaction before the rest is rescheduled. */
const PURGE_BATCH = 40;
/** The shortest retention any user can pick; nothing younger can be due. */
const MIN_RETENTION_DAYS = 7;

/**
 * Permanently removes a note: its updates, its snapshot, its files, and the
 * bytes they held against the quota. The metadata row survives as a tombstone
 * so devices that were offline learn the note is gone rather than resurrecting
 * it from their own copy.
 */
async function purgeNote(
  ctx: MutationCtx,
  note: Doc<"notes">,
  seq: SeqWriter,
): Promise<number> {
  let freed = 0;

  const updates = await ctx.db
    .query("noteUpdates")
    .withIndex("by_note_seq", (q) => q.eq("userId", note.userId).eq("noteId", note.noteId))
    .take(2000);
  for (const row of updates) await ctx.db.delete(row._id);

  const snapshot = await ctx.db
    .query("noteSnapshots")
    .withIndex("by_user_note", (q) =>
      q.eq("userId", note.userId).eq("noteId", note.noteId),
    )
    .unique();
  if (snapshot) {
    if (snapshot.storageId) await ctx.storage.delete(snapshot.storageId);
    await ctx.db.delete(snapshot._id);
  }
  freed += note.bodyBytes;

  // This note's own uses go first, so a file it shares with another note is
  // judged by the other note's use alone.
  const used = await dropNoteRefs(ctx, note.userId, note.noteId, MAX_REFS_PER_NOTE);

  const attachments = await ctx.db
    .query("attachments")
    .withIndex("by_user_note", (q) =>
      q.eq("userId", note.userId).eq("noteId", note.noteId),
    )
    .take(500);
  for (const row of attachments) {
    const live = row.status === "committed" && row.deletedAt === null;
    // Copied into another note that still shows it: it stays, for that note.
    if (live && (await isInUse(ctx, note.userId, row.attachmentId))) continue;
    if (row.storageId) await ctx.storage.delete(row.storageId);
    // A file the daily sweep already deleted gave its bytes back then.
    if (live) freed += row.bytes;
    await ctx.db.delete(row._id);
  }
  // Files of other notes that only this one still used are unused from now.
  await settleUse(ctx, note.userId, used, Date.now());

  await ctx.db.patch(note._id, {
    purged: true,
    title: null,
    titleSealed: undefined,
    preview: null,
    wrappedKey: undefined,
    bodyBytes: 0,
    lastUpdateSeq: 0,
    snapshotSeq: 0,
    sinceSnapshot: { count: 0, bytes: 0 },
    seq: seq.next(),
  });

  return freed;
}

/**
 * Collects a folder and everything under it, deepest last, so notes are purged
 * before the folders that contain them.
 */
async function collectSubtree(
  ctx: MutationCtx,
  userId: Id<"users">,
  rootFolderId: string,
): Promise<{ folders: Doc<"folders">[]; notes: Doc<"notes">[] }> {
  const folders: Doc<"folders">[] = [];
  const notes: Doc<"notes">[] = [];
  const queue = [rootFolderId];
  const seen = new Set<string>([rootFolderId]);

  const root = await ctx.db
    .query("folders")
    .withIndex("by_user_folder", (q) => q.eq("userId", userId).eq("folderId", rootFolderId))
    .unique();
  if (root && !root.purged) folders.push(root);

  while (queue.length > 0 && folders.length + notes.length < 2000) {
    const current = queue.shift()!;
    const children = await ctx.db
      .query("folders")
      .withIndex("by_user_parent", (q) => q.eq("userId", userId).eq("parentId", current))
      .take(500);
    for (const child of children) {
      if (child.purged || seen.has(child.folderId)) continue;
      seen.add(child.folderId);
      folders.push(child);
      queue.push(child.folderId);
    }
    const contained = await ctx.db
      .query("notes")
      .withIndex("by_user_folder", (q) => q.eq("userId", userId).eq("folderId", current))
      .take(500);
    for (const note of contained) if (!note.purged) notes.push(note);
  }

  return { folders, notes };
}

async function purgeTargets(
  ctx: MutationCtx,
  user: Doc<"users">,
  seq: SeqWriter,
  folderIds: string[],
  noteIds: string[],
): Promise<{ freed: number; more: boolean }> {
  let freed = 0;
  let budget = PURGE_BATCH;
  let more = false;

  const pendingFolders: Doc<"folders">[] = [];

  for (const folderId of folderIds) {
    const { folders, notes } = await collectSubtree(ctx, user._id, folderId);
    for (const note of notes) {
      if (budget <= 0) {
        more = true;
        break;
      }
      freed += await purgeNote(ctx, note, seq);
      budget -= 1;
    }
    // Folders only disappear once nothing is left inside them, so a rescheduled
    // continuation can still find the remaining notes by walking the tree.
    if (!more) pendingFolders.push(...folders);
    else break;
  }

  for (const noteId of noteIds) {
    if (budget <= 0) {
      more = true;
      break;
    }
    const note = await ctx.db
      .query("notes")
      .withIndex("by_user_note", (q) => q.eq("userId", user._id).eq("noteId", noteId))
      .unique();
    if (!note || note.purged) continue;
    freed += await purgeNote(ctx, note, seq);
    budget -= 1;
  }

  if (!more) {
    for (const folder of pendingFolders) {
      if (folder.system === "inbox") continue;
      await ctx.db.patch(folder._id, {
        purged: true,
        name: null,
        nameSealed: undefined,
        seq: seq.next(),
      });
    }
  }

  return { freed, more };
}

/** Permanent delete from the trash screen. */
export const purge = mutation({
  args: { folderIds: v.array(v.string()), noteIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const seq = await openSeq(ctx, user._id);
    const { freed, more } = await purgeTargets(
      ctx,
      user,
      seq,
      args.folderIds,
      args.noteIds,
    );
    if (freed > 0) {
      await ctx.db.patch(user._id, { usedBytes: Math.max(0, user.usedBytes - freed) });
    }
    await seq.commit();
    if (more) {
      await ctx.scheduler.runAfter(0, internal.trash.purgeMore, {
        userId: user._id,
        folderIds: args.folderIds,
        noteIds: args.noteIds,
      });
    }
    return { freed, complete: !more };
  },
});

export const purgeMore = internalMutation({
  args: {
    userId: v.id("users"),
    folderIds: v.array(v.string()),
    noteIds: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) return;
    const seq = await openSeq(ctx, user._id);
    const { freed, more } = await purgeTargets(
      ctx,
      user,
      seq,
      args.folderIds,
      args.noteIds,
    );
    if (freed > 0) {
      await ctx.db.patch(user._id, { usedBytes: Math.max(0, user.usedBytes - freed) });
    }
    await seq.commit();
    if (more) await ctx.scheduler.runAfter(0, internal.trash.purgeMore, args);
  },
});

/**
 * Deletes trashed items whose retention window has closed.
 *
 * Retention is a per-user setting, so the scan takes everything older than the
 * shortest possible window and then checks each row against its own owner's
 * choice.
 */
export const purgeExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const scanCutoff = now - MIN_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const notes = await ctx.db
      .query("notes")
      .withIndex("by_purge", (q) =>
        q.eq("purged", false).gt("deletedAt", 0).lt("deletedAt", scanCutoff),
      )
      .take(200);
    const folders = await ctx.db
      .query("folders")
      .withIndex("by_purge", (q) =>
        q.eq("purged", false).gt("deletedAt", 0).lt("deletedAt", scanCutoff),
      )
      .take(200);

    const byUser = new Map<Id<"users">, { folderIds: string[]; noteIds: string[] }>();
    const due = async (userId: Id<"users">, deletedAt: number) => {
      const user = await ctx.db.get(userId);
      if (!user) return false;
      return deletedAt < now - user.settings.trashRetentionDays * 24 * 60 * 60 * 1000;
    };

    for (const note of notes) {
      if (note.deletedAt === null || !(await due(note.userId, note.deletedAt))) continue;
      const entry = byUser.get(note.userId) ?? { folderIds: [], noteIds: [] };
      entry.noteIds.push(note.noteId);
      byUser.set(note.userId, entry);
    }
    for (const folder of folders) {
      if (folder.deletedAt === null || !(await due(folder.userId, folder.deletedAt))) continue;
      const entry = byUser.get(folder.userId) ?? { folderIds: [], noteIds: [] };
      entry.folderIds.push(folder.folderId);
      byUser.set(folder.userId, entry);
    }

    for (const [userId, targets] of byUser) {
      await ctx.scheduler.runAfter(0, internal.trash.purgeMore, { userId, ...targets });
    }
    return { users: byUser.size };
  },
});

/**
 * Drops tombstones old enough that no realistic client is still behind them.
 * A device offline longer than this resets its cursor and resyncs from scratch.
 */
export const dropOldTombstones = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - TOMBSTONE_MS;
    let removed = 0;
    const notes = await ctx.db
      .query("notes")
      .withIndex("by_purge", (q) => q.eq("purged", true))
      .take(300);
    for (const row of notes) {
      if (row.updatedAt < cutoff) {
        await ctx.db.delete(row._id);
        removed += 1;
      }
    }
    const folders = await ctx.db
      .query("folders")
      .withIndex("by_purge", (q) => q.eq("purged", true))
      .take(300);
    for (const row of folders) {
      if ((row.deletedAt ?? 0) < cutoff) {
        await ctx.db.delete(row._id);
        removed += 1;
      }
    }
    return { removed };
  },
});
