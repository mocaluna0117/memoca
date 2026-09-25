import { type Infer, v } from "convex/values";

export const stampV = v.object({ t: v.number(), d: v.string() });
export const sealedV = v.object({ ct: v.bytes(), iv: v.bytes() });

/**
 * Metadata writes are grouped by field, and each group carries its own stamp.
 * Renaming a note on one device while moving it on another therefore keeps both
 * edits instead of one clobbering the other.
 */
export const folderOpV = v.object({
  kind: v.literal("folder"),
  opId: v.string(),
  folderId: v.string(),
  /** Used only when the row does not exist yet. */
  create: v.optional(
    v.object({
      parentId: v.union(v.string(), v.null()),
      sortKey: v.string(),
      system: v.union(v.literal("inbox"), v.null()),
    }),
  ),
  name: v.optional(
    v.object({
      value: v.union(v.string(), v.null()),
      sealed: v.optional(sealedV),
      icon: v.union(v.string(), v.null()),
      ts: stampV,
    }),
  ),
  place: v.optional(
    v.object({
      parentId: v.union(v.string(), v.null()),
      sortKey: v.string(),
      ts: stampV,
    }),
  ),
  trash: v.optional(
    v.object({ deletedAt: v.union(v.number(), v.null()), ts: stampV }),
  ),
});

export const noteOpV = v.object({
  kind: v.literal("note"),
  opId: v.string(),
  noteId: v.string(),
  create: v.optional(
    v.object({
      noteKind: v.union(v.literal("note"), v.literal("quick")),
      folderId: v.union(v.string(), v.null()),
      sortKey: v.string(),
      /**
       * Created already locked, inside a locked folder, so nothing of it is
       * ever stored in plaintext. Its title arrives sealed and every update
       * encrypted under this key epoch.
       */
      lock: v.optional(
        v.object({ keyEpoch: v.number(), wrappedKey: sealedV, ts: stampV }),
      ),
    }),
  ),
  title: v.optional(
    v.object({
      value: v.union(v.string(), v.null()),
      sealed: v.optional(sealedV),
      preview: v.union(v.string(), v.null()),
      ts: stampV,
    }),
  ),
  /**
   * The preview on its own, sent when the body changes. Carrying no title
   * means a body edit can never overwrite a rename it had not seen yet.
   */
  preview: v.optional(
    v.object({ value: v.union(v.string(), v.null()), ts: stampV }),
  ),
  place: v.optional(
    v.object({
      folderId: v.union(v.string(), v.null()),
      sortKey: v.string(),
      ts: stampV,
    }),
  ),
  pin: v.optional(v.object({ pinned: v.boolean(), ts: stampV })),
  trash: v.optional(
    v.object({ deletedAt: v.union(v.number(), v.null()), ts: stampV }),
  ),
});

/**
 * A batch of Yjs updates for one note. `keyEpoch` must match the note's current
 * epoch, which is how plaintext written before a lock gets rejected instead of
 * silently landing on the server in the clear.
 */
export const updateOpV = v.object({
  kind: v.literal("update"),
  opId: v.string(),
  noteId: v.string(),
  keyEpoch: v.number(),
  payload: v.bytes(),
  iv: v.optional(v.bytes()),
});

export const attachmentCommitOpV = v.object({
  kind: v.literal("attachment.commit"),
  opId: v.string(),
  attachmentId: v.string(),
  storageId: v.id("_storage"),
});

/** Reports which attachments a note still references, after a compaction. */
export const attachmentSweepOpV = v.object({
  kind: v.literal("attachment.sweep"),
  opId: v.string(),
  noteId: v.string(),
  referenced: v.array(v.string()),
});

export const opV = v.union(
  folderOpV,
  noteOpV,
  updateOpV,
  attachmentCommitOpV,
  attachmentSweepOpV,
);

export type Op = Infer<typeof opV>;
export type OpKind = Op["kind"];

export const opResultV = v.object({
  opId: v.string(),
  status: v.union(v.literal("ok"), v.literal("rejected")),
  reason: v.optional(v.string()),
});

export type OpResult = Infer<typeof opResultV>;
