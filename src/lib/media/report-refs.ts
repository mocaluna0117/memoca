"use client";

import type { ConvexReactClient } from "convex/react";
import { api } from "@convex/_generated/api";
import { vault } from "@/lib/crypto/vault";
import { db } from "@/lib/db";
import { withDetachedDoc } from "@/lib/sync/docs";
import { attachmentRefs, bodyFragment } from "@/lib/sync/ydoc";
import type { Note } from "@/lib/types";

/** The server refuses a report naming more files than this. */
const MAX_REFS = 500;
/** A note that could not be reported is left alone this long. */
const RETRY_MS = 60_000;

const lastTried = new Map<string, number>();

const behind = (note: Note) =>
  !note.purged && (note.refsThroughSeq === undefined || note.refsThroughSeq < note.lastUpdateSeq);

/**
 * Tells the server which files notes use, for notes whose last report is
 * older than their latest change: the server deletes a file only once no note
 * has used it for 30 days, and only while every note's report is current.
 *
 * A note is reported only when this device's copy is exactly the server's:
 * nothing waiting to be sent, and every update received. A locked note needs
 * the vault open. A note whose body this device lacks is fetched, and
 * reported on a later pass. Returns how many notes were reported.
 */
export async function reportAttachmentRefs(
  client: ConvexReactClient,
  fetchBodies: (noteIds: string[]) => Promise<void>,
  { limit = 5, now = Date.now() }: { limit?: number; now?: number } = {},
): Promise<number> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return 0;
  const database = db();
  const due = (await database.notes.filter(behind).toArray()).filter(
    (note) => now - (lastTried.get(note.noteId) ?? 0) >= RETRY_MS,
  );

  let reported = 0;
  const missing: string[] = [];
  for (const note of due) {
    if (reported >= limit) break;
    if (note.locked && (!note.wrappedKey || !vault.isUnlocked)) continue;
    const [body, unpushed, queued] = await Promise.all([
      database.bodies.get(note.noteId),
      database.updates.where("noteId").equals(note.noteId).filter((u) => u.pushed === 0).count(),
      database.outbox.filter((op) => op.entityId === note.noteId).count(),
    ]);
    // Changes of its own not yet sent: the server's copy is not this one.
    if (unpushed > 0 || queued > 0) continue;

    // A note with no content yet uses nothing, and needs no body to say so.
    const empty = note.lastUpdateSeq === 0 && note.snapshotSeq === 0;
    if (!empty && (!body || body.keyEpoch !== note.keyEpoch || body.throughSeq < note.lastUpdateSeq)) {
      if (missing.length < limit) missing.push(note.noteId);
      continue;
    }
    const throughSeq = empty ? 0 : body!.throughSeq;

    lastTried.set(note.noteId, now);
    // A locked note read without its key comes out empty, which would report
    // every file it shows as gone. The vault is held open while it is read,
    // and a note that reads as no blocks at all is not reported: every note
    // the editor has touched has at least one.
    const release = note.locked ? vault.hold() : null;
    try {
      if (note.locked && !vault.isUnlocked) continue;
      const read = empty
        ? { refs: [], blocks: 0 }
        : await withDetachedDoc(note.noteId, (doc) => ({
            refs: attachmentRefs(doc),
            blocks: bodyFragment(doc).length,
          }));
      if (!empty && read.blocks === 0) continue;
      const refs = read.refs;
      if (refs.length > MAX_REFS) continue;
      const result = await client.mutation(api.attachments.reportRefs, {
        noteId: note.noteId,
        throughSeq,
        refs,
      });
      if (result.status !== "ok") continue;
      lastTried.delete(note.noteId);
      await database.notes
        .where("noteId")
        .equals(note.noteId)
        .modify((row) => {
          if ((row.refsThroughSeq ?? -1) < throughSeq) row.refsThroughSeq = throughSeq;
        });
      reported += 1;
    } catch {
      // Offline mid-way, or a note that could not be read: a later pass retries.
    } finally {
      release?.();
    }
  }
  if (missing.length > 0) await fetchBodies(missing).catch(() => {});
  return reported;
}

/** Forgets the retry timers, for tests. */
export function resetReportRefs(): void {
  lastTried.clear();
}
