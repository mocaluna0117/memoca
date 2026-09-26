import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { UNREFERENCED_GRACE_MS } from "./lib/constants";
import { requireUser } from "./lib/user";

/** Rows read of each kind, at most; the answer says when there were more. */
const READ_LIMIT = 5000;
/** How many of the largest files are listed. */
const LARGEST = 20;

type Kind = "image" | "video" | "other";

/** What kind of file a row is: as declared, else by its type, else unknown. */
function kindOf(row: Doc<"attachments">): Kind {
  if (row.category) return row.category;
  if (row.mime?.startsWith("image/")) return "image";
  if (row.mime?.startsWith("video/")) return "video";
  return "other";
}

/**
 * Where the account's storage goes, worked out from the rows themselves: note
 * text, in use and in the trash; files by kind; files of notes in the trash;
 * files no note uses any more, deleted a while after; uploads still under
 * way; and the largest files, with the notes that show them. `recomputedBytes`
 * is the total those rows add up to, to compare with the running total the
 * server keeps (`usedBytes`).
 *
 * Reads every note and file of the account: to be fetched when asked for,
 * never subscribed to, or it would be read again at every edit.
 */
export const breakdown = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);

    // A note is in the trash when it was put there, or a folder above it was.
    const folders = await ctx.db
      .query("folders")
      .withIndex("by_user_seq", (q) => q.eq("userId", user._id))
      .take(READ_LIMIT);
    const parentOf = new Map(folders.map((folder) => [folder.folderId, folder]));
    const binnedFolder = (folderId: string | null): boolean => {
      const seen = new Set<string>();
      for (let at = folderId; at !== null && !seen.has(at); ) {
        seen.add(at);
        const folder = parentOf.get(at);
        if (!folder) return false;
        if (folder.deletedAt !== null) return true;
        at = folder.parentId;
      }
      return false;
    };

    const notes = await ctx.db
      .query("notes")
      .withIndex("by_user_seq", (q) => q.eq("userId", user._id))
      .take(READ_LIMIT);
    const bodies = { live: 0, trashed: 0 };
    const trashed = new Set<string>();
    for (const note of notes) {
      if (note.purged) continue;
      if (note.deletedAt !== null || binnedFolder(note.folderId)) {
        bodies.trashed += note.bodyBytes;
        trashed.add(note.noteId);
      } else {
        bodies.live += note.bodyBytes;
      }
    }
    /** Whether a note out of the trash shows the file: emptying the trash would not free it then. */
    const shownOutsideTrash = async (attachmentId: string) => {
      const uses = await ctx.db
        .query("attachmentRefs")
        .withIndex("by_user_attachment", (q) => q.eq("userId", user._id).eq("attachmentId", attachmentId))
        .take(50);
      return uses.some((use) => !trashed.has(use.noteId));
    };

    const rows = await ctx.db
      .query("attachments")
      .withIndex("by_user_seq", (q) => q.eq("userId", user._id))
      .take(READ_LIMIT);
    const files = { image: 0, video: 0, other: 0 };
    const unused = { bytes: 0, count: 0, nextDeleteAt: null as number | null };
    let trashedFiles = 0;
    let uploading = 0;
    const stored: Doc<"attachments">[] = [];
    /** Files counted as the trash's: they go when it is emptied. */
    const binned = new Set<string>();
    for (const row of rows) {
      if (row.status === "reserved" && row.deletedAt === null) {
        uploading += row.reservedBytes;
        continue;
      }
      if (row.status !== "committed" || row.deletedAt !== null) continue;
      stored.push(row);
      if (row.unreferencedAt !== null) {
        unused.bytes += row.bytes;
        unused.count += 1;
        const due = row.unreferencedAt + UNREFERENCED_GRACE_MS;
        if (unused.nextDeleteAt === null || due < unused.nextDeleteAt) unused.nextDeleteAt = due;
      } else if (trashed.has(row.noteId) && !(await shownOutsideTrash(row.attachmentId))) {
        trashedFiles += row.bytes;
        binned.add(row.attachmentId);
      } else {
        files[kindOf(row)] += row.bytes;
      }
    }

    const largest = [];
    for (const row of stored.sort((x, y) => y.bytes - x.bytes).slice(0, LARGEST)) {
      const uses = await ctx.db
        .query("attachmentRefs")
        .withIndex("by_user_attachment", (q) => q.eq("userId", user._id).eq("attachmentId", row.attachmentId))
        .take(10);
      largest.push({
        attachmentId: row.attachmentId,
        noteId: row.noteId,
        bytes: row.bytes,
        kind: kindOf(row),
        // A locked file's name and type are encrypted: the device reads them.
        name: row.locked ? null : row.name,
        mime: row.locked ? null : row.mime,
        locked: row.locked,
        width: row.width,
        height: row.height,
        trashed: binned.has(row.attachmentId),
        unused: row.unreferencedAt !== null,
        usedBy: uses.map((use) => use.noteId),
      });
    }

    const recomputedBytes =
      bodies.live + bodies.trashed + stored.reduce((sum, row) => sum + row.bytes, 0);
    return {
      quotaBytes: user.quotaBytes,
      usedBytes: user.usedBytes,
      reservedBytes: user.reservedBytes,
      recomputedBytes,
      bodies,
      files,
      trashedFiles,
      unused,
      uploading,
      largest,
      truncated: notes.length === READ_LIMIT || rows.length === READ_LIMIT || folders.length === READ_LIMIT,
    };
  },
});
