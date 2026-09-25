import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";
import { MAX_PASSKEYS, PASSKEY_LABEL_MAX, SNAPSHOT_INLINE_LIMIT } from "./lib/constants";
import { sealedV, stampV } from "./lib/ops";
import { type SeqWriter, openSeq } from "./lib/seq";
import { getUser, requireUser } from "./lib/user";

const wrapV = v.object({ hkdfSalt: v.bytes(), ct: v.bytes(), iv: v.bytes() });

const snapshotV = v.object({
  payload: v.optional(v.bytes()),
  storageId: v.optional(v.id("_storage")),
  size: v.number(),
  iv: v.optional(v.bytes()),
});

/** What a client may see of its vault: ciphertext and salts only. */
function shape(vault: Doc<"vaults">) {
  return {
    argon: vault.argon,
    saltPw: vault.saltPw,
    pwWrap: vault.pwWrap,
    hasRecovery: vault.recWrap !== null,
    recWrap: vault.recWrap,
    passkeys: vault.prfWraps.map((p) => ({
      credentialId: p.credentialId,
      prfInput: p.prfInput,
      hkdfSalt: p.hkdfSalt,
      ct: p.ct,
      iv: p.iv,
      label: p.label,
      createdAt: p.createdAt,
    })),
    version: vault.version,
  };
}

/**
 * The wrapped vault key and its unlock methods.
 *
 * Everything here is ciphertext or a salt. The vault key itself is generated in
 * the browser and never sent, so the server can hand this straight back without
 * being able to open anything.
 *
 * Kept for clients from before `record`; it throws before sign-in.
 */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const vault = await ctx.db
      .query("vaults")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    return vault ? shape(vault) : null;
  },
});

/**
 * The vault record, safe to keep subscribed from app start.
 *
 * Unlike `status`, it answers before sign-in instead of throwing, and it says
 * which of three states applies. "none" and "signed out" must never be
 * confused: only a confirmed "none" may lead to creating a vault.
 */
export const record = query({
  args: {},
  handler: async (ctx) => {
    const user = await getUser(ctx);
    if (!user) return { state: "signedOut" as const };
    const vault = await ctx.db
      .query("vaults")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    if (!vault) return { state: "none" as const };
    return {
      state: "exists" as const,
      record: {
        ...shape(vault),
        recoveryFormat: vault.recoveryFormat ?? null,
        recoveryCheckedAt: vault.recoveryCheckedAt ?? null,
      },
    };
  },
});

export const setup = mutation({
  args: {
    argon: v.object({ m: v.number(), t: v.number(), p: v.number() }),
    saltPw: v.bytes(),
    pwWrap: sealedV,
    recWrap: wrapV,
    recoveryFormat: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const existing = await ctx.db
      .query("vaults")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    if (existing) return { status: "already" as const };
    await ctx.db.insert("vaults", {
      userId: user._id,
      argon: args.argon,
      saltPw: args.saltPw,
      pwWrap: args.pwWrap,
      recWrap: args.recWrap,
      prfWraps: [],
      version: 1,
      updatedAt: Date.now(),
      ...(args.recoveryFormat !== undefined ? { recoveryFormat: args.recoveryFormat } : {}),
    });
    return { status: "ok" as const };
  },
});

/**
 * Replaces the password and/or recovery wrapping of the same vault key.
 *
 * Only 48-byte blobs move: the note contents are encrypted under per-note keys
 * wrapped by the vault key, so changing a password never rewrites a document.
 */
export const rewrap = mutation({
  args: {
    argon: v.optional(v.object({ m: v.number(), t: v.number(), p: v.number() })),
    saltPw: v.optional(v.bytes()),
    pwWrap: v.optional(sealedV),
    recWrap: v.optional(wrapV),
    /**
     * The version the client based this on. Two devices changing the password
     * or recovery key at once would otherwise silently keep only the last.
     */
    expectedVersion: v.optional(v.number()),
    recoveryFormat: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const vault = await ctx.db
      .query("vaults")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    if (!vault) return { status: "noVault" as const };
    if (args.expectedVersion !== undefined && args.expectedVersion !== vault.version) {
      return { status: "stale" as const, version: vault.version };
    }
    await ctx.db.patch("vaults", vault._id, {
      ...(args.argon ? { argon: args.argon } : {}),
      ...(args.saltPw ? { saltPw: args.saltPw } : {}),
      ...(args.pwWrap ? { pwWrap: args.pwWrap } : {}),
      // A new recovery key has not been confirmed as kept, whatever the old
      // one's state was.
      ...(args.recWrap
        ? {
            recWrap: args.recWrap,
            recoveryFormat: args.recoveryFormat,
            recoveryCheckedAt: undefined,
          }
        : {}),
      version: vault.version + 1,
      updatedAt: Date.now(),
    });
    return { status: "ok" as const, version: vault.version + 1 };
  },
});

/** Records that the person proved they kept the current recovery key. */
export const markRecoveryChecked = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const vault = await ctx.db
      .query("vaults")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    if (!vault) return { status: "noVault" as const };
    await ctx.db.patch("vaults", vault._id, { recoveryCheckedAt: Date.now() });
    return { status: "ok" as const };
  },
});

/** Registers a passkey's PRF-derived wrapping of the vault key. */
export const addPasskey = mutation({
  args: {
    credentialId: v.string(),
    prfInput: v.bytes(),
    hkdfSalt: v.bytes(),
    ct: v.bytes(),
    iv: v.bytes(),
    label: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const vault = await ctx.db
      .query("vaults")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    if (!vault) return { status: "noVault" as const };
    const others = vault.prfWraps.filter((p) => p.credentialId !== args.credentialId);
    if (others.length >= MAX_PASSKEYS) return { status: "tooMany" as const };
    const prfWraps = [
      ...others,
      { ...args, label: args.label.slice(0, PASSKEY_LABEL_MAX), createdAt: Date.now() },
    ];
    await ctx.db.patch("vaults", vault._id, { prfWraps, updatedAt: Date.now() });
    return { status: "ok" as const };
  },
});

export const removePasskey = mutation({
  args: { credentialId: v.string() },
  handler: async (ctx, { credentialId }) => {
    const user = await requireUser(ctx);
    const vault = await ctx.db
      .query("vaults")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();
    if (!vault) return { status: "noVault" as const };
    await ctx.db.patch(vault._id, {
      prfWraps: vault.prfWraps.filter((p) => p.credentialId !== credentialId),
      updatedAt: Date.now(),
    });
    return { status: "ok" as const };
  },
});

async function replaceBody(
  ctx: MutationCtx,
  userId: Id<"users">,
  noteId: string,
  seq: SeqWriter,
  keyEpoch: number,
  coversThroughSeq: number,
  snapshot: { payload?: ArrayBuffer; storageId?: Id<"_storage">; size: number; iv?: ArrayBuffer },
) {
  // Every update row goes, including the plaintext ones being replaced. This is
  // the step that actually makes the old content unreadable on the server.
  const updates = await ctx.db
    .query("noteUpdates")
    .withIndex("by_note_seq", (q) => q.eq("userId", userId).eq("noteId", noteId))
    .take(2000);
  for (const row of updates) await ctx.db.delete(row._id);

  const previous = await ctx.db
    .query("noteSnapshots")
    .withIndex("by_user_note", (q) => q.eq("userId", userId).eq("noteId", noteId))
    .unique();
  if (previous) {
    if (previous.storageId) await ctx.storage.delete(previous.storageId);
    await ctx.db.delete(previous._id);
  }

  await ctx.db.insert("noteSnapshots", {
    userId,
    noteId,
    keyEpoch,
    coversThroughSeq,
    payload: snapshot.payload,
    storageId: snapshot.storageId,
    iv: snapshot.iv,
    size: snapshot.size,
    seq: seq.next(),
    createdAt: Date.now(),
  });
}

const attachmentSwapV = v.array(
  v.object({
    attachmentId: v.string(),
    storageId: v.id("_storage"),
    bytes: v.number(),
    /** Locking: the plaintext name and type move into `metaSealed`. */
    metaSealed: v.optional(sealedV),
    wrappedKey: v.optional(sealedV),
    contentIv: v.optional(v.bytes()),
    /** Unlocking: the plaintext values come back. */
    name: v.optional(v.string()),
    mime: v.optional(v.string()),
  }),
);

async function swapAttachments(
  ctx: MutationCtx,
  userId: Id<"users">,
  seq: SeqWriter,
  locked: boolean,
  swaps: {
    attachmentId: string;
    storageId: Id<"_storage">;
    bytes: number;
    metaSealed?: { ct: ArrayBuffer; iv: ArrayBuffer };
    wrappedKey?: { ct: ArrayBuffer; iv: ArrayBuffer };
    contentIv?: ArrayBuffer;
    name?: string;
    mime?: string;
  }[],
): Promise<number> {
  let delta = 0;
  for (const swap of swaps) {
    const row = await ctx.db
      .query("attachments")
      .withIndex("by_user_attachment", (q) =>
        q.eq("userId", userId).eq("attachmentId", swap.attachmentId),
      )
      .unique();
    if (!row || row.status !== "committed") continue;
    if (row.storageId) await ctx.storage.delete(row.storageId);
    delta += swap.bytes - row.bytes;
    await ctx.db.patch(row._id, {
      storageId: swap.storageId,
      bytes: swap.bytes,
      locked,
      metaSealed: swap.metaSealed,
      wrappedKey: swap.wrappedKey,
      contentIv: swap.contentIv,
      name: locked ? null : (swap.name ?? null),
      mime: locked ? null : (swap.mime ?? null),
      seq: seq.next(),
    });
  }
  return delta;
}

/**
 * Turns a plaintext note into an encrypted one in a single transaction.
 *
 * `coversThroughSeq` must equal the note's newest update, which proves the
 * caller folded every update into the snapshot it is replacing them with. The
 * epoch bump is what makes any in-flight plaintext write from another device
 * fail instead of landing after the lock.
 */
export const lockNote = mutation({
  args: {
    noteId: v.string(),
    keyEpoch: v.number(),
    coversThroughSeq: v.number(),
    wrappedKey: sealedV,
    titleSealed: sealedV,
    snapshot: snapshotV,
    attachments: attachmentSwapV,
    ts: stampV,
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const note = await ctx.db
      .query("notes")
      .withIndex("by_user_note", (q) => q.eq("userId", user._id).eq("noteId", args.noteId))
      .unique();
    if (!note || note.purged) return { status: "rejected" as const, reason: "unknownNote" };
    if (note.locked) return { status: "rejected" as const, reason: "alreadyLocked" };
    if (args.keyEpoch !== note.keyEpoch + 1) {
      return { status: "rejected" as const, reason: "epochMismatch" };
    }
    if (args.coversThroughSeq !== note.lastUpdateSeq) {
      return { status: "rejected" as const, reason: "behind" };
    }
    if (!args.snapshot.iv) return { status: "rejected" as const, reason: "missingIv" };
    if (args.snapshot.payload && args.snapshot.payload.byteLength > SNAPSHOT_INLINE_LIMIT) {
      return { status: "rejected" as const, reason: "snapshotTooLargeInline" };
    }

    const seq = await openSeq(ctx, user._id);
    await replaceBody(
      ctx,
      user._id,
      args.noteId,
      seq,
      args.keyEpoch,
      args.coversThroughSeq,
      args.snapshot,
    );
    const attachmentDelta = await swapAttachments(
      ctx,
      user._id,
      seq,
      true,
      args.attachments,
    );

    await ctx.db.patch(note._id, {
      locked: true,
      keyEpoch: args.keyEpoch,
      wrappedKey: args.wrappedKey,
      title: null,
      titleSealed: args.titleSealed,
      preview: null,
      snapshotSeq: args.coversThroughSeq,
      sinceSnapshot: { count: 0, bytes: 0 },
      bodyBytes: args.snapshot.size,
      ts: { ...note.ts, lock: args.ts, title: args.ts },
      seq: seq.next(),
      updatedAt: Date.now(),
    });
    await ctx.db.patch(user._id, {
      usedBytes: Math.max(
        0,
        user.usedBytes - note.bodyBytes + args.snapshot.size + attachmentDelta,
      ),
    });
    await seq.commit();
    return { status: "ok" as const };
  },
});

/** The exact inverse of {@link lockNote}: ciphertext out, plaintext in. */
export const unlockNote = mutation({
  args: {
    noteId: v.string(),
    keyEpoch: v.number(),
    coversThroughSeq: v.number(),
    title: v.string(),
    preview: v.union(v.string(), v.null()),
    snapshot: snapshotV,
    attachments: attachmentSwapV,
    ts: stampV,
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const note = await ctx.db
      .query("notes")
      .withIndex("by_user_note", (q) => q.eq("userId", user._id).eq("noteId", args.noteId))
      .unique();
    if (!note || note.purged) return { status: "rejected" as const, reason: "unknownNote" };
    if (!note.locked) return { status: "rejected" as const, reason: "notLocked" };
    if (args.keyEpoch !== note.keyEpoch + 1) {
      return { status: "rejected" as const, reason: "epochMismatch" };
    }
    if (args.coversThroughSeq !== note.lastUpdateSeq) {
      return { status: "rejected" as const, reason: "behind" };
    }
    if (args.snapshot.iv) return { status: "rejected" as const, reason: "unexpectedIv" };

    const seq = await openSeq(ctx, user._id);
    await replaceBody(
      ctx,
      user._id,
      args.noteId,
      seq,
      args.keyEpoch,
      args.coversThroughSeq,
      args.snapshot,
    );
    const attachmentDelta = await swapAttachments(
      ctx,
      user._id,
      seq,
      false,
      args.attachments,
    );

    await ctx.db.patch(note._id, {
      locked: false,
      keyEpoch: args.keyEpoch,
      wrappedKey: undefined,
      title: args.title,
      titleSealed: undefined,
      preview: args.preview,
      snapshotSeq: args.coversThroughSeq,
      sinceSnapshot: { count: 0, bytes: 0 },
      bodyBytes: args.snapshot.size,
      ts: { ...note.ts, lock: args.ts, title: args.ts },
      seq: seq.next(),
      updatedAt: Date.now(),
    });
    await ctx.db.patch(user._id, {
      usedBytes: Math.max(
        0,
        user.usedBytes - note.bodyBytes + args.snapshot.size + attachmentDelta,
      ),
    });
    await seq.commit();
    return { status: "ok" as const };
  },
});

/**
 * Flips a folder's lock flag. The cascade over descendant notes runs on the
 * client, one {@link lockNote} per note, because only the client holds the key.
 * An interrupted cascade is detected and resumed on next launch.
 */
export const setFolderLock = mutation({
  args: {
    folderId: v.string(),
    locked: v.boolean(),
    name: v.union(v.string(), v.null()),
    nameSealed: v.optional(sealedV),
    ts: stampV,
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const folder = await ctx.db
      .query("folders")
      .withIndex("by_user_folder", (q) =>
        q.eq("userId", user._id).eq("folderId", args.folderId),
      )
      .unique();
    if (!folder || folder.purged) return { status: "rejected" as const, reason: "unknownFolder" };
    if (args.locked && !args.nameSealed) {
      return { status: "rejected" as const, reason: "missingSealedName" };
    }

    const seq = await openSeq(ctx, user._id);
    await ctx.db.patch(folder._id, {
      locked: args.locked,
      name: args.locked ? null : args.name,
      nameSealed: args.locked ? args.nameSealed : undefined,
      ts: { ...folder.ts, lock: args.ts, name: args.ts },
      seq: seq.next(),
    });
    await seq.commit();
    return { status: "ok" as const };
  },
});

/** Notes still in plaintext inside a locked folder: an interrupted cascade. */
export const pendingLockCascade = query({
  args: { folderIds: v.array(v.string()) },
  handler: async (ctx, { folderIds }) => {
    const user = await requireUser(ctx);
    const pending: string[] = [];
    for (const folderId of folderIds.slice(0, 64)) {
      const notes = await ctx.db
        .query("notes")
        .withIndex("by_user_folder", (q) =>
          q.eq("userId", user._id).eq("folderId", folderId),
        )
        .take(500);
      for (const note of notes) {
        if (!note.locked && !note.purged && note.deletedAt === null) pending.push(note.noteId);
      }
    }
    return pending;
  },
});
