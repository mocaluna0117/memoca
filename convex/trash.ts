import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, internalMutation, mutation } from "./_generated/server";
import { MAX_REFS_PER_NOTE, TOMBSTONE_MS, UNREFERENCED_GRACE_MS } from "./lib/constants";
import { fileTombstone } from "./lib/files";
import { type Stamp, isNewer } from "./lib/hlc";
import { stampV } from "./lib/ops";
import { allNotesReported, dropNoteRefs, isInUse, settleUse } from "./lib/refs";
import { type SeqWriter, openSeq } from "./lib/seq";
import { requireUser } from "./lib/user";
import { dropVersions } from "./versions";

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
  othersReported: () => Promise<boolean>,
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
  await dropVersions(ctx, note.userId, note.noteId);

  // This note's own uses go first, so a file it shares with another note is
  // judged by the other note's use alone.
  const used = await dropNoteRefs(ctx, note.userId, note.noteId, MAX_REFS_PER_NOTE);

  const attachments = await ctx.db
    .query("attachments")
    .withIndex("by_user_note", (q) =>
      q.eq("userId", note.userId).eq("noteId", note.noteId),
    )
    .take(500);
  const now = Date.now();
  for (const row of attachments) {
    if (row.deletedAt !== null) continue;
    const live = row.status === "committed";
    // Copied into another note that still shows it: it stays, for that note.
    if (live && (await isInUse(ctx, note.userId, row.attachmentId))) continue;
    if (live && !(await othersReported())) {
      // Another note may show it without having said so yet. Deleting it now
      // would take it from that note on every device, so the sweep deletes
      // it, and gives its bytes back, once every note has reported.
      await ctx.db.patch(row._id, { unreferencedAt: now - UNREFERENCED_GRACE_MS });
      continue;
    }
    if (row.storageId) await ctx.storage.delete(row.storageId);
    if (live) freed += row.bytes;
    // Kept as a tombstone, as the sweep keeps what it deletes: a device
    // learns the file is gone and lets go of its copy, rather than keeping
    // the row of a file that no longer exists. A reservation keeps its
    // status, for the reaper to give its room back.
    await ctx.db.patch(row._id, fileTombstone(now, seq.next()));
  }
  // Files of other notes that only this one still used are unused from now.
  await settleUse(ctx, note.userId, used, Date.now());

  await ctx.db.patch(note._id, {
    purged: true,
    purgedAt: Date.now(),
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

/**
 * Whether a purge asked for still applies: the item is in the trash, or the
 * asking device put it there after it was last taken out, by a trashing on
 * its way here still. One taken out of the trash on another device since is
 * left alone: emptying a trash that showed it then would delete it for good.
 */
function stillTrashed(
  row: { deletedAt: number | null; ts: { trash: Stamp } },
  trashedAt: Stamp | undefined,
): boolean {
  if (row.deletedAt !== null) return true;
  return trashedAt !== undefined && isNewer(trashedAt, row.ts.trash);
}

async function purgeTargets(
  ctx: MutationCtx,
  user: Doc<"users">,
  seq: SeqWriter,
  folderIds: string[],
  noteIds: string[],
  trashedAt: Record<string, Stamp> = {},
): Promise<{ freed: number; more: boolean }> {
  let freed = 0;
  let budget = PURGE_BATCH;
  let more = false;

  const pendingFolders: Doc<"folders">[] = [];
  // Whether every note but the ones going now has reported the files it
  // uses: asked at most once, and only if a file's fate turns on it.
  const purging = new Set(noteIds);
  let reported: Promise<boolean> | null = null;
  const othersReported = () => (reported ??= allNotesReported(ctx, user._id, purging));

  const subtrees = [];
  for (const folderId of folderIds) {
    const root = await ctx.db
      .query("folders")
      .withIndex("by_user_folder", (q) => q.eq("userId", user._id).eq("folderId", folderId))
      .unique();
    if (!root || root.purged || !stillTrashed(root, trashedAt[folderId])) continue;
    const subtree = await collectSubtree(ctx, user._id, folderId);
    for (const note of subtree.notes) purging.add(note.noteId);
    subtrees.push(subtree);
  }

  for (const { folders, notes } of subtrees) {
    for (const note of notes) {
      if (budget <= 0) {
        more = true;
        break;
      }
      freed += await purgeNote(ctx, note, seq, othersReported);
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
    if (!note || note.purged || !stillTrashed(note, trashedAt[noteId])) continue;
    freed += await purgeNote(ctx, note, seq, othersReported);
    budget -= 1;
  }

  if (!more) {
    for (const folder of pendingFolders) {
      if (folder.system !== null) continue;
      await ctx.db.patch(folder._id, {
        purged: true,
        purgedAt: Date.now(),
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
  args: {
    folderIds: v.array(v.string()),
    noteIds: v.array(v.string()),
    /**
     * When the asking device put each of them in the trash, by id. Older
     * clients send nothing, and only what is in the trash here goes.
     */
    trashedAt: v.optional(v.record(v.string(), stampV)),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const seq = await openSeq(ctx, user._id);
    const { freed, more } = await purgeTargets(
      ctx,
      user,
      seq,
      args.folderIds,
      args.noteIds,
      args.trashedAt,
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
        trashedAt: args.trashedAt,
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
    trashedAt: v.optional(v.record(v.string(), stampV)),
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
      args.trashedAt,
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
 * choice. Each table is gone through a page at a time to its end: items of
 * someone keeping their trash longer, oldest first, would otherwise fill
 * every page and keep anyone else's from ever being reached.
 */
export const purgeExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const table of ["notes", "folders"] as const) {
      await ctx.scheduler.runAfter(0, internal.trash.purgeExpiredPage, { table, cursor: null });
    }
  },
});

/** Rows of trash looked at per page by {@link purgeExpiredPage}. */
const EXPIRED_PAGE = 200;

export const purgeExpiredPage = internalMutation({
  args: {
    table: v.union(v.literal("notes"), v.literal("folders")),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { table, cursor }) => {
    const now = Date.now();
    const scanCutoff = now - MIN_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const page = await ctx.db
      .query(table)
      .withIndex("by_purge", (q) =>
        q.eq("purged", false).gt("deletedAt", 0).lt("deletedAt", scanCutoff),
      )
      .paginate({ numItems: EXPIRED_PAGE, cursor });

    const retention = new Map<Id<"users">, number | null>();
    const byUser = new Map<Id<"users">, string[]>();
    for (const row of page.page) {
      if (row.deletedAt === null) continue;
      if (!retention.has(row.userId)) {
        const user = await ctx.db.get(row.userId);
        retention.set(row.userId, user ? user.settings.trashRetentionDays : null);
      }
      const days = retention.get(row.userId);
      if (days == null || row.deletedAt >= now - days * 24 * 60 * 60 * 1000) continue;
      const id = "noteId" in row ? row.noteId : row.folderId;
      byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), id]);
    }

    for (const [userId, ids] of byUser) {
      await ctx.scheduler.runAfter(0, internal.trash.purgeMore, {
        userId,
        folderIds: table === "folders" ? ids : [],
        noteIds: table === "notes" ? ids : [],
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.trash.purgeExpiredPage, {
        table,
        cursor: page.continueCursor,
      });
    }
    return { users: byUser.size };
  },
});

/** Tombstones of notes, and of folders, looked at per run; it runs again at once while there are more. */
const TOMBSTONE_BATCH = 300;

/**
 * Drops tombstones old enough that no realistic client is still behind them.
 * A device offline longer than this resets its cursor and resyncs from scratch.
 *
 * Old enough is counted from the purge: not from the last edit, which may be
 * long before, nor from the trashing, which a folder purged with its parent
 * never had. A tombstone from before purges were dated is dated when first
 * seen here, so it too is kept the whole time from now.
 */
export const dropOldTombstones = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - TOMBSTONE_MS;
    let removed = 0;
    let full = false;
    for (const table of ["notes", "folders"] as const) {
      const undated = await ctx.db
        .query(table)
        .withIndex("by_purged_at", (q) => q.eq("purged", true).eq("purgedAt", undefined))
        .take(TOMBSTONE_BATCH);
      for (const row of undated) await ctx.db.patch(row._id, { purgedAt: now });
      const old = await ctx.db
        .query(table)
        .withIndex("by_purged_at", (q) =>
          q.eq("purged", true).gt("purgedAt", 0).lt("purgedAt", cutoff),
        )
        .take(TOMBSTONE_BATCH);
      for (const row of old) await ctx.db.delete(row._id);
      removed += old.length;
      full ||= undated.length === TOMBSTONE_BATCH || old.length === TOMBSTONE_BATCH;
    }
    if (full) await ctx.scheduler.runAfter(0, internal.trash.dropOldTombstones, {});
    // Files deleted as long ago, in batches of their own until none are left.
    else await ctx.scheduler.runAfter(0, internal.trash.dropOldFileTombstones, {});
    return { removed };
  },
});

/** Tombstones of files taken per run; it runs again at once while there are more. */
const FILE_TOMBSTONE_BATCH = 300;

/**
 * Drops the rows of files deleted more than {@link TOMBSTONE_MS} ago. Their
 * bytes were given back when they were deleted.
 */
export const dropOldFileTombstones = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - TOMBSTONE_MS;
    const files = await ctx.db
      .query("attachments")
      .withIndex("by_deleted_at", (q) => q.gt("deletedAt", 0).lt("deletedAt", cutoff))
      .take(FILE_TOMBSTONE_BATCH);
    for (const row of files) {
      if (row.storageId) await ctx.storage.delete(row.storageId);
      await ctx.db.delete(row._id);
    }
    if (files.length === FILE_TOMBSTONE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.trash.dropOldFileTombstones, {});
    }
    return { removed: files.length };
  },
});
