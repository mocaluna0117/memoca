import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { MAX_NOTES_FOR_SWEEP } from "./constants";

/**
 * Which files are still in use.
 *
 * The server cannot read a note (a locked one is ciphertext), so each device
 * reports the files a note uses once its copy of the note matches the
 * server's (attachments.reportRefs). A file is in use while any note of its
 * owner names it: it may have been copied into a note other than the one it
 * was uploaded to.
 */

export async function isInUse(
  ctx: MutationCtx,
  userId: Id<"users">,
  attachmentId: string,
): Promise<boolean> {
  const row = await ctx.db
    .query("attachmentRefs")
    .withIndex("by_user_attachment", (q) =>
      q.eq("userId", userId).eq("attachmentId", attachmentId),
    )
    .first();
  return row !== null;
}

/**
 * Marks each of these files as unused since now, or as in use again, to match
 * the reported uses. Only uploaded files are marked; one still uploading, or
 * already deleted, is left alone.
 */
export async function settleUse(
  ctx: MutationCtx,
  userId: Id<"users">,
  attachmentIds: Iterable<string>,
  now: number,
): Promise<void> {
  for (const attachmentId of new Set(attachmentIds)) {
    const row = await ctx.db
      .query("attachments")
      .withIndex("by_user_attachment", (q) =>
        q.eq("userId", userId).eq("attachmentId", attachmentId),
      )
      .unique();
    if (!row || row.status !== "committed" || row.deletedAt !== null) continue;
    const used = await isInUse(ctx, userId, attachmentId);
    if (used && row.unreferencedAt !== null) {
      await ctx.db.patch("attachments", row._id, { unreferencedAt: null });
    } else if (!used && row.unreferencedAt === null) {
      await ctx.db.patch("attachments", row._id, { unreferencedAt: now });
    }
  }
}

/** Forgets every use a note reported. Returns the files it had used. */
export async function dropNoteRefs(
  ctx: MutationCtx,
  userId: Id<"users">,
  noteId: string,
  limit: number,
): Promise<string[]> {
  const rows = await ctx.db
    .query("attachmentRefs")
    .withIndex("by_user_note", (q) => q.eq("userId", userId).eq("noteId", noteId))
    .take(limit);
  for (const row of rows) await ctx.db.delete("attachmentRefs", row._id);
  return rows.map((row) => row.attachmentId);
}

/**
 * Whether every note the user has, in the trash or not, has reported the
 * files it uses as of its latest change. Until then a file that looks unused
 * may be named by a note nobody has reported yet, so nothing is deleted.
 * Notes in `except` are not asked: the ones being purged.
 */
export async function allNotesReported(
  ctx: MutationCtx,
  userId: Id<"users">,
  except: ReadonlySet<string> = new Set(),
): Promise<boolean> {
  const notes = await ctx.db
    .query("notes")
    .withIndex("by_user_seq", (q) => q.eq("userId", userId))
    .take(MAX_NOTES_FOR_SWEEP + 1);
  if (notes.length > MAX_NOTES_FOR_SWEEP) return false;
  return notes.every(
    (note) =>
      note.purged ||
      except.has(note.noteId) ||
      (note.refsThroughSeq !== undefined && note.refsThroughSeq >= note.lastUpdateSeq),
  );
}
