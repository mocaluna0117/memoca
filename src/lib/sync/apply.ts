"use client";

import type { FunctionReturnType } from "convex/server";
import type { api } from "@convex/_generated/api";
import { db, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import { isNewer } from "@/lib/hlc";
import type { Folder, Note } from "@/lib/types";

/** `null` is the signed-out case, which never reaches {@link applyBatch}. */
export type PullBatch = NonNullable<FunctionReturnType<typeof api.sync.pull>>;
type RemoteFolder = PullBatch["folders"][number];
type RemoteNote = PullBatch["notes"][number];

/** Yjs updates that arrived from a peer and still need applying to open docs. */
export type IncomingUpdate = {
  noteId: string;
  keyEpoch: number;
  data: Uint8Array;
  iv?: Uint8Array;
};

export type ApplyResult = {
  /** Notes whose stored body is behind and should be fetched. */
  needBodies: string[];
  /** Notes whose key epoch changed, so their local document must be rebuilt. */
  reload: string[];
  incoming: IncomingUpdate[];
};

/**
 * Field-group last-writer-wins, applied locally with the same rule the server
 * uses.
 *
 * Without this, an incoming row would briefly stomp an edit this device has
 * made but not yet pushed, and the user would watch their rename flicker back.
 */
function mergeFolder(local: Folder, remote: RemoteFolder): Folder {
  const next: Folder = { ...local };
  if (isNewer(remote.ts.name, local.ts.name)) {
    next.name = remote.name;
    next.nameSealed = remote.nameSealed;
    next.icon = remote.icon;
    next.ts = { ...next.ts, name: remote.ts.name };
  }
  if (isNewer(remote.ts.place, local.ts.place)) {
    next.parentId = remote.parentId;
    next.sortKey = remote.sortKey;
    next.ts = { ...next.ts, place: remote.ts.place };
  }
  if (isNewer(remote.ts.trash, local.ts.trash)) {
    next.deletedAt = remote.deletedAt;
    next.ts = { ...next.ts, trash: remote.ts.trash };
  }
  if (isNewer(remote.ts.lock, local.ts.lock)) {
    next.locked = remote.locked;
    next.ts = { ...next.ts, lock: remote.ts.lock };
  }
  next.system = remote.system;
  next.purged = remote.purged;
  next.seq = remote.seq;
  return next;
}

function mergeNote(local: Note, remote: RemoteNote): Note {
  const next: Note = { ...local };
  if (isNewer(remote.ts.title, local.ts.title)) {
    next.title = remote.title;
    next.titleSealed = remote.titleSealed;
    next.preview = remote.preview;
    next.ts = { ...next.ts, title: remote.ts.title };
  }
  if (isNewer(remote.ts.place, local.ts.place)) {
    next.folderId = remote.folderId;
    next.sortKey = remote.sortKey;
    next.ts = { ...next.ts, place: remote.ts.place };
  }
  if (isNewer(remote.ts.pin, local.ts.pin)) {
    next.pinned = remote.pinned;
    next.ts = { ...next.ts, pin: remote.ts.pin };
  }
  if (isNewer(remote.ts.trash, local.ts.trash)) {
    next.deletedAt = remote.deletedAt;
    next.ts = { ...next.ts, trash: remote.ts.trash };
  }
  // Lock state is never a local guess: it comes with the wrapped key and the
  // epoch, which only the server transaction can hand out consistently.
  if (isNewer(remote.ts.lock, local.ts.lock) || remote.keyEpoch !== local.keyEpoch) {
    next.locked = remote.locked;
    next.keyEpoch = remote.keyEpoch;
    next.wrappedKey = remote.wrappedKey;
    next.ts = { ...next.ts, lock: remote.ts.lock };
    if (remote.locked) {
      next.title = remote.title;
      next.titleSealed = remote.titleSealed;
      next.preview = null;
    }
  }
  next.purged = remote.purged;
  // The note row is not resent for every content change, so a row that arrives
  // later can still carry an older value than the update stream already gave us.
  next.lastUpdateSeq = Math.max(local.lastUpdateSeq, remote.lastUpdateSeq);
  next.snapshotSeq = Math.max(local.snapshotSeq, remote.snapshotSeq);
  next.seq = remote.seq;
  next.updatedAt = Math.max(local.updatedAt, remote.updatedAt);
  return next;
}

const toNote = (remote: RemoteNote): Note => ({ ...remote });
const toFolder = (remote: RemoteFolder): Folder => ({ ...remote });

export async function applyBatch(batch: PullBatch): Promise<ApplyResult> {
  const database = db();
  const needBodies = new Set<string>();
  const reload = new Set<string>();
  const incoming: IncomingUpdate[] = [];

  await database.transaction(
    "rw",
    [
      database.folders,
      database.notes,
      database.updates,
      database.bodies,
      database.attachments,
      database.meta,
    ],
    async () => {
      for (const remote of batch.folders) {
        if (remote.purged) {
          await database.folders.delete(remote.folderId);
          continue;
        }
        const local = await database.folders.get(remote.folderId);
        await database.folders.put(local ? mergeFolder(local, remote) : toFolder(remote));
      }

      for (const remote of batch.notes) {
        if (remote.purged) {
          await database.notes.delete(remote.noteId);
          await database.updates.where("noteId").equals(remote.noteId).delete();
          await database.snapshots.delete(remote.noteId);
          await database.bodies.delete(remote.noteId);
          continue;
        }
        const local = await database.notes.get(remote.noteId);
        const merged = local ? mergeNote(local, remote) : toNote(remote);
        await database.notes.put(merged);

        const body = await database.bodies.get(remote.noteId);
        if (!body || body.keyEpoch !== remote.keyEpoch) {
          // A lock or unlock replaced the body wholesale.
          if (body) reload.add(remote.noteId);
          if (remote.lastUpdateSeq > 0 || remote.snapshotSeq > 0) {
            needBodies.add(remote.noteId);
          }
        } else if (body.throughSeq < remote.snapshotSeq) {
          needBodies.add(remote.noteId);
        }
      }

      for (const remote of batch.updates) {
        const own = await database.updates.where("opId").equals(remote.opId).first();
        if (own) {
          // Our own write coming back; record that the server has it.
          if (own.seq !== remote.seq || own.pushed !== 1) {
            await database.updates.update(own.localId!, { seq: remote.seq, pushed: 1 });
          }
        } else {
          const data = new Uint8Array(remote.payload);
          const iv = remote.iv ? new Uint8Array(remote.iv) : undefined;
          await database.updates.add({
            noteId: remote.noteId,
            seq: remote.seq,
            opId: remote.opId,
            keyEpoch: remote.keyEpoch,
            data,
            iv,
            pushed: 1,
            createdAt: Date.now(),
          });
          incoming.push({ noteId: remote.noteId, keyEpoch: remote.keyEpoch, data, iv });
          await database.notes.update(remote.noteId, { updatedAt: Date.now() });
        }

        // How far the local document reaches has to advance for this device's
        // own writes too. Locking and compaction both refuse to act unless the
        // local copy is known to cover every update on the server, and leaving
        // the marker behind on an echo makes that condition unreachable.
        const body = await database.bodies.get(remote.noteId);
        await database.bodies.put({
          noteId: remote.noteId,
          throughSeq: Math.max(body?.throughSeq ?? 0, remote.seq),
          keyEpoch: remote.keyEpoch,
          text: body?.text ?? null,
          updatedAt: Date.now(),
        });
        // `lastUpdateSeq` is only carried on the note row, which is not resent
        // for content changes; keep it in step from the update itself.
        const note = await database.notes.get(remote.noteId);
        if (note && note.lastUpdateSeq < remote.seq) {
          await database.notes.update(remote.noteId, { lastUpdateSeq: remote.seq });
        }
      }

      for (const header of batch.snapshots) {
        const body = await database.bodies.get(header.noteId);
        if (
          !body ||
          body.keyEpoch !== header.keyEpoch ||
          body.throughSeq < header.coversThroughSeq
        ) {
          needBodies.add(header.noteId);
        }
      }

      for (const remote of batch.attachments) {
        if (remote.deletedAt !== null) {
          await database.attachments.delete(remote.attachmentId);
          await database.blobs.delete(remote.attachmentId);
          continue;
        }
        await database.attachments.put({ ...remote });
      }

      await setMeta(META.cursor, batch.cursor);
      await setMeta(META.lastSyncAt, Date.now());
    },
  );

  return { needBodies: [...needBodies], reload: [...reload], incoming };
}
