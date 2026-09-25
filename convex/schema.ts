import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * A hybrid logical clock stamp. `t` is wall-clock milliseconds nudged forward so
 * it never goes backwards on a device; `d` is the device id and breaks ties so
 * two devices can never both "win" a field.
 */
export const stamp = v.object({ t: v.number(), d: v.string() });

/** Ciphertext blob plus its AES-GCM initialisation vector. */
export const sealed = v.object({ ct: v.bytes(), iv: v.bytes() });

const folderStamps = v.object({
  name: stamp,
  place: stamp,
  trash: stamp,
  lock: stamp,
});

const noteStamps = v.object({
  title: stamp,
  /**
   * The list preview is derived from the body, so it changes on every edit
   * while the title changes only when someone renames the note. Sharing one
   * stamp meant a body edit had to resend the title it had read moments
   * earlier, and a rename landing in between was overwritten with the stale
   * value. Optional because rows written before this existed have no stamp.
   */
  preview: v.optional(stamp),
  place: stamp,
  pin: stamp,
  trash: stamp,
  lock: stamp,
});

export default defineSchema({
  /** One row per person. `authId` is the Better Auth user id. */
  users: defineTable({
    authId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    role: v.union(v.literal("user"), v.literal("admin")),
    quotaBytes: v.number(),
    usedBytes: v.number(),
    reservedBytes: v.number(),
    settings: v.object({
      theme: v.union(v.literal("system"), v.literal("light"), v.literal("dark")),
      trashRetentionDays: v.number(),
      autoLockMinutes: v.number(),
      prefetchBodies: v.boolean(),
    }),
    createdAt: v.number(),
  })
    .index("by_authId", ["authId"])
    .index("by_email", ["email"]),

  /**
   * The per-user sync clock. Every mutation that writes syncable rows reads this
   * document, stamps each written row with an incremented `seq`, and writes it
   * back. Convex serialises conflicting transactions on this single document, so
   * seq order is guaranteed to equal commit order — which is what makes a simple
   * "give me everything after N" cursor correct.
   */
  syncHeads: defineTable({
    userId: v.id("users"),
    seq: v.number(),
    /** deviceId -> last push time. Used to detect that another device is active. */
    lastPushByDevice: v.record(v.string(), v.number()),
  }).index("by_user", ["userId"]),

  /** Single-row service configuration, editable from the admin screen. */
  appConfig: defineTable({
    key: v.literal("global"),
    signupOpen: v.boolean(),
    maxUsers: v.number(),
    userCount: v.number(),
    defaultQuotaBytes: v.number(),
    maxImageBytes: v.number(),
    maxVideoBytes: v.number(),
  }).index("by_key", ["key"]),

  inviteCodes: defineTable({
    code: v.string(),
    createdBy: v.union(v.id("users"), v.null()),
    usesLeft: v.number(),
    expiresAt: v.union(v.number(), v.null()),
    memo: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_code", ["code"]),

  folders: defineTable({
    userId: v.id("users"),
    /** Client-generated UUIDv7. Stable across devices; `_id` is never synced. */
    folderId: v.string(),
    parentId: v.union(v.string(), v.null()),
    /** Plaintext name, or null when the folder is locked. */
    name: v.union(v.string(), v.null()),
    /** Encrypted name, present only when locked. */
    nameSealed: v.optional(sealed),
    icon: v.union(v.string(), v.null()),
    sortKey: v.string(),
    locked: v.boolean(),
    /** "inbox" marks the undeletable quick-capture folder. */
    system: v.union(v.literal("inbox"), v.null()),
    deletedAt: v.union(v.number(), v.null()),
    purged: v.boolean(),
    ts: folderStamps,
    deviceId: v.string(),
    seq: v.number(),
  })
    .index("by_user_seq", ["userId", "seq"])
    .index("by_user_folder", ["userId", "folderId"])
    .index("by_user_parent", ["userId", "parentId"])
    .index("by_user_system", ["userId", "system"])
    .index("by_purge", ["purged", "deletedAt"]),

  notes: defineTable({
    userId: v.id("users"),
    noteId: v.string(),
    folderId: v.union(v.string(), v.null()),
    kind: v.union(v.literal("note"), v.literal("quick")),
    /** Plaintext title, or null when locked. */
    title: v.union(v.string(), v.null()),
    titleSealed: v.optional(sealed),
    /** Short plaintext excerpt for list rows; null when locked. */
    preview: v.union(v.string(), v.null()),
    pinned: v.boolean(),
    sortKey: v.string(),
    locked: v.boolean(),
    /** Bumped on every lock/unlock so stale writes from other devices are rejected. */
    keyEpoch: v.number(),
    /** Per-note data key wrapped by the vault key. Present only when locked. */
    wrappedKey: v.optional(sealed),
    deletedAt: v.union(v.number(), v.null()),
    purged: v.boolean(),
    /** seq of the newest row in noteUpdates for this note (0 when none). */
    lastUpdateSeq: v.number(),
    /** `coversThroughSeq` of the current snapshot (0 when none). */
    snapshotSeq: v.number(),
    /** How much has accumulated since the snapshot; drives compaction. */
    sinceSnapshot: v.object({ count: v.number(), bytes: v.number() }),
    /** Snapshot + pending updates, counted against the storage quota. */
    bodyBytes: v.number(),
    ts: noteStamps,
    deviceId: v.string(),
    seq: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_seq", ["userId", "seq"])
    .index("by_user_note", ["userId", "noteId"])
    .index("by_user_folder", ["userId", "folderId"])
    .index("by_user_updated", ["userId", "updatedAt"])
    .index("by_purge", ["purged", "deletedAt"]),

  /** Yjs document updates. Append-only until compaction folds them into a snapshot. */
  noteUpdates: defineTable({
    userId: v.id("users"),
    noteId: v.string(),
    /** Client-generated; de-duplicates replayed pushes. */
    opId: v.string(),
    deviceId: v.string(),
    keyEpoch: v.number(),
    payload: v.bytes(),
    /** Present when the note is locked (payload is then ciphertext). */
    iv: v.optional(v.bytes()),
    size: v.number(),
    seq: v.number(),
  })
    .index("by_user_seq", ["userId", "seq"])
    .index("by_note_seq", ["userId", "noteId", "seq"])
    .index("by_user_op", ["userId", "opId"]),

  /** Exactly one row per note: the merged Yjs state up to `coversThroughSeq`. */
  noteSnapshots: defineTable({
    userId: v.id("users"),
    noteId: v.string(),
    keyEpoch: v.number(),
    coversThroughSeq: v.number(),
    /** Inline for small documents. */
    payload: v.optional(v.bytes()),
    /** Used instead of `payload` when the snapshot approaches the 1 MiB doc limit. */
    storageId: v.optional(v.id("_storage")),
    iv: v.optional(v.bytes()),
    size: v.number(),
    seq: v.number(),
    createdAt: v.number(),
  })
    .index("by_user_seq", ["userId", "seq"])
    .index("by_user_note", ["userId", "noteId"])
    .index("by_storage", ["storageId"]),

  attachments: defineTable({
    userId: v.id("users"),
    attachmentId: v.string(),
    noteId: v.string(),
    /** reserved -> committed, or -> orphan when the upload never completed. */
    status: v.union(v.literal("reserved"), v.literal("committed"), v.literal("orphan")),
    storageId: v.union(v.id("_storage"), v.null()),
    /** Quota held while the upload is in flight. */
    reservedBytes: v.number(),
    /** Real size, read back from Convex storage at commit time. */
    bytes: v.number(),
    mime: v.union(v.string(), v.null()),
    name: v.union(v.string(), v.null()),
    /** Encrypted {name, mime} for locked attachments. */
    metaSealed: v.optional(sealed),
    locked: v.boolean(),
    wrappedKey: v.optional(sealed),
    /** IV of the encrypted file body. */
    contentIv: v.optional(v.bytes()),
    width: v.union(v.number(), v.null()),
    height: v.union(v.number(), v.null()),
    /** Set when no block references it any more; deleted 30 days later. */
    unreferencedAt: v.union(v.number(), v.null()),
    deletedAt: v.union(v.number(), v.null()),
    /** Reservation deadline; the hourly reaper releases anything past it. */
    expiresAt: v.union(v.number(), v.null()),
    seq: v.number(),
    createdAt: v.number(),
  })
    .index("by_user_seq", ["userId", "seq"])
    .index("by_user_attachment", ["userId", "attachmentId"])
    .index("by_user_note", ["userId", "noteId"])
    .index("by_status_expires", ["status", "expiresAt"])
    .index("by_storage", ["storageId"]),

  /**
   * The vault key, wrapped once per unlock method. The key itself never leaves
   * the browser, so the server holds only ciphertext it cannot open.
   */
  vaults: defineTable({
    userId: v.id("users"),
    argon: v.object({ m: v.number(), t: v.number(), p: v.number() }),
    saltPw: v.bytes(),
    pwWrap: sealed,
    recWrap: v.union(
      v.object({ hkdfSalt: v.bytes(), ct: v.bytes(), iv: v.bytes() }),
      v.null(),
    ),
    prfWraps: v.array(
      v.object({
        credentialId: v.string(),
        prfInput: v.bytes(),
        hkdfSalt: v.bytes(),
        ct: v.bytes(),
        iv: v.bytes(),
        label: v.string(),
        createdAt: v.number(),
      }),
    ),
    version: v.number(),
    updatedAt: v.number(),
    /**
     * How the recovery key was shown when this wrapping was made: 2 means in
     * full. Missing means before that fix, when the display cut the key short
     * and it could never open the vault.
     */
    recoveryFormat: v.optional(v.number()),
    /** When the person last confirmed they kept the current recovery key. */
    recoveryCheckedAt: v.optional(v.number()),
  }).index("by_user", ["userId"]),
});
