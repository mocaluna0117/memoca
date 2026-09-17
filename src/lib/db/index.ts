import Dexie, { type Table } from "dexie";
import type { Attachment, Folder, Note, Sealed } from "@/lib/types";

/** A Yjs update waiting to be merged or sent. */
export type LocalUpdate = {
  localId?: number;
  noteId: string;
  /** Server sequence once acknowledged; null while it is still local-only. */
  seq: number | null;
  opId: string;
  keyEpoch: number;
  /** Plaintext locally unless the note is locked, in which case ciphertext. */
  data: Uint8Array;
  iv?: Uint8Array;
  pushed: 0 | 1;
  createdAt: number;
};

export type LocalSnapshot = {
  noteId: string;
  data: Uint8Array;
  iv?: Uint8Array;
  keyEpoch: number;
  /** How far into the server's update stream this snapshot already reaches. */
  throughSeq: number;
};

/** What the local Yjs document currently contains, per note. */
export type BodyState = {
  noteId: string;
  throughSeq: number;
  keyEpoch: number;
  /** Extracted plain text, used by search. Absent for locked notes. */
  text: string | null;
  updatedAt: number;
};

export type OutboxEntry = {
  opId: string;
  /** Mirrors the server operation union. */
  payload: unknown;
  entityId: string;
  kind: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
};

export type PendingUpload = {
  attachmentId: string;
  noteId: string;
  blob: Blob;
  mime: string;
  name: string;
  width: number | null;
  height: number | null;
  category: "image" | "video" | "other";
  locked: boolean;
  wrappedKey?: Sealed;
  contentIv?: ArrayBuffer;
  metaSealed?: Sealed;
  createdAt: number;
};

export type CachedBlob = {
  attachmentId: string;
  blob: Blob;
  bytes: number;
  lastUsed: number;
};

export type MetaRow = {
  key: string;
  value: unknown;
};

/**
 * The device's own copy of everything. It is the source the UI reads from, so
 * the app renders and accepts edits with no network at all; the sync engine
 * reconciles it with Convex in the background.
 */
export class MemocaDb extends Dexie {
  folders!: Table<Folder, string>;
  notes!: Table<Note, string>;
  updates!: Table<LocalUpdate, number>;
  snapshots!: Table<LocalSnapshot, string>;
  bodies!: Table<BodyState, string>;
  attachments!: Table<Attachment, string>;
  pendingUploads!: Table<PendingUpload, string>;
  blobs!: Table<CachedBlob, string>;
  outbox!: Table<OutboxEntry, string>;
  meta!: Table<MetaRow, string>;

  constructor(name = "memoca") {
    super(name);
    this.version(1).stores({
      folders: "folderId, parentId, deletedAt, system, seq",
      notes: "noteId, folderId, deletedAt, updatedAt, locked, kind, seq",
      updates: "++localId, noteId, opId, [noteId+pushed], pushed, seq",
      snapshots: "noteId",
      bodies: "noteId",
      attachments: "attachmentId, noteId, status",
      pendingUploads: "attachmentId, noteId",
      blobs: "attachmentId, lastUsed",
      outbox: "opId, createdAt, kind",
      meta: "key",
    });
  }
}

let instance: MemocaDb | null = null;

export function db(): MemocaDb {
  if (!instance) instance = new MemocaDb();
  return instance;
}

/**
 * Local data is per account. Signing in as someone else on a shared browser
 * must not surface the previous person's notes.
 */
export async function resetLocalData(): Promise<void> {
  const database = db();
  await database.transaction(
    "rw",
    [
      database.folders,
      database.notes,
      database.updates,
      database.snapshots,
      database.bodies,
      database.attachments,
      database.pendingUploads,
      database.blobs,
      database.outbox,
      database.meta,
    ],
    async () => {
      await Promise.all([
        database.folders.clear(),
        database.notes.clear(),
        database.updates.clear(),
        database.snapshots.clear(),
        database.bodies.clear(),
        database.attachments.clear(),
        database.pendingUploads.clear(),
        database.blobs.clear(),
        database.outbox.clear(),
        database.meta.clear(),
      ]);
    },
  );
}

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await db().meta.get(key);
  return row === undefined ? fallback : (row.value as T);
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db().meta.put({ key, value });
}
