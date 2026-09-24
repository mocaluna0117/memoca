import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { type MutationCtx, mutation, query } from "./_generated/server";
import {
  COMPACT_UPDATE_BYTES,
  COMPACT_UPDATE_COUNT,
  MAX_FOLDER_DEPTH,
  PULL_BYTE_BUDGET,
  PULL_PAGE_LIMIT,
} from "./lib/constants";
import { ZERO_STAMP, type Stamp, isFromTheFuture, isNewer } from "./lib/hlc";
import { type Op, type OpResult, opV } from "./lib/ops";
import { type SeqWriter, openSeq } from "./lib/seq";
import { getUser, requireUser } from "./lib/user";

/* -------------------------------------------------------------------------- */
/*  Pull                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Everything that changed after `since`, as one reactive subscription.
 *
 * Each table is paged independently, which creates a trap: advancing the cursor
 * to the highest sequence seen would skip rows in whichever table filled its
 * page first. So the cursor moves only as far as the *lowest* end-of-page among
 * the tables that were full, and rows beyond that are dropped and re-sent next
 * round.
 */
export const pull = query({
  args: { since: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    // Returns null rather than throwing while the client is signed out or its
    // token has not attached yet. A subscription that throws is a subscription
    // that stops delivering, and this one runs from the moment the app starts,
    // including before the auth token lands on a cold load.
    const user = await getUser(ctx);
    if (!user) return null;
    const limit = Math.min(Math.max(args.limit ?? PULL_PAGE_LIMIT, 1), 500);
    const since = Math.max(args.since, 0);
    const userId = user._id;

    const head = await ctx.db
      .query("syncHeads")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    const headSeq = head?.seq ?? 0;

    // Written out per table rather than through a generic helper: the index
    // range builder's types are table-specific and do not survive a type
    // parameter.
    const folderRows = await ctx.db
      .query("folders")
      .withIndex("by_user_seq", (q) => q.eq("userId", userId).gt("seq", since))
      .take(limit);
    const noteRows = await ctx.db
      .query("notes")
      .withIndex("by_user_seq", (q) => q.eq("userId", userId).gt("seq", since))
      .take(limit);
    const rawUpdateRows = await ctx.db
      .query("noteUpdates")
      .withIndex("by_user_seq", (q) => q.eq("userId", userId).gt("seq", since))
      .take(limit);
    const snapshotRows = await ctx.db
      .query("noteSnapshots")
      .withIndex("by_user_seq", (q) => q.eq("userId", userId).gt("seq", since))
      .take(limit);
    const attachmentRows = await ctx.db
      .query("attachments")
      .withIndex("by_user_seq", (q) => q.eq("userId", userId).gt("seq", since))
      .take(limit);

    // Yjs payloads are the only rows big enough to blow a response budget, so
    // they get a byte cap on top of the row cap. At least one always goes
    // through, otherwise an oversized update would wedge the cursor forever.
    const updateRows: typeof rawUpdateRows = [];
    let spent = 0;
    let updatesTruncated = false;
    for (const row of rawUpdateRows) {
      if (updateRows.length > 0 && spent + row.size > PULL_BYTE_BUDGET) {
        updatesTruncated = true;
        break;
      }
      updateRows.push(row);
      spent += row.size;
    }

    const pages: { rows: { seq: number }[]; full: boolean }[] = [
      { rows: folderRows, full: folderRows.length >= limit },
      { rows: noteRows, full: noteRows.length >= limit },
      { rows: updateRows, full: updatesTruncated || rawUpdateRows.length >= limit },
      { rows: snapshotRows, full: snapshotRows.length >= limit },
      { rows: attachmentRows, full: attachmentRows.length >= limit },
    ];

    let cursor = Number.POSITIVE_INFINITY;
    let maxSeen = since;
    for (const page of pages) {
      for (const row of page.rows) if (row.seq > maxSeen) maxSeen = row.seq;
      if (page.full && page.rows.length > 0) {
        cursor = Math.min(cursor, page.rows[page.rows.length - 1]!.seq);
      }
    }
    if (!Number.isFinite(cursor)) cursor = Math.max(maxSeen, since);

    const upTo = <T extends { seq: number }>(rows: T[]) => rows.filter((r) => r.seq <= cursor);

    return {
      headSeq,
      cursor,
      complete: cursor >= headSeq,
      serverTime: Date.now(),
      folders: upTo(folderRows).map(publicFolder),
      notes: upTo(noteRows).map(publicNote),
      updates: upTo(updateRows).map((r) => ({
        noteId: r.noteId,
        opId: r.opId,
        deviceId: r.deviceId,
        keyEpoch: r.keyEpoch,
        payload: r.payload,
        iv: r.iv,
        seq: r.seq,
      })),
      // Headers only. The payload is fetched through notes.getBodies, and only
      // by devices whose local copy is actually behind the snapshot.
      snapshots: upTo(snapshotRows).map((r) => ({
        noteId: r.noteId,
        keyEpoch: r.keyEpoch,
        coversThroughSeq: r.coversThroughSeq,
        size: r.size,
        seq: r.seq,
      })),
      attachments: upTo(attachmentRows).map(publicAttachment),
    };
  },
});

export function publicFolder(f: Doc<"folders">) {
  return {
    folderId: f.folderId,
    parentId: f.parentId,
    name: f.name,
    nameSealed: f.nameSealed,
    icon: f.icon,
    sortKey: f.sortKey,
    locked: f.locked,
    system: f.system,
    deletedAt: f.deletedAt,
    purged: f.purged,
    ts: f.ts,
    seq: f.seq,
  };
}

export function publicNote(n: Doc<"notes">) {
  return {
    noteId: n.noteId,
    folderId: n.folderId,
    kind: n.kind,
    title: n.title,
    titleSealed: n.titleSealed,
    preview: n.preview,
    pinned: n.pinned,
    sortKey: n.sortKey,
    locked: n.locked,
    keyEpoch: n.keyEpoch,
    wrappedKey: n.wrappedKey,
    deletedAt: n.deletedAt,
    purged: n.purged,
    lastUpdateSeq: n.lastUpdateSeq,
    snapshotSeq: n.snapshotSeq,
    ts: n.ts,
    seq: n.seq,
    updatedAt: n.updatedAt,
  };
}

export function publicAttachment(a: Doc<"attachments">) {
  return {
    attachmentId: a.attachmentId,
    noteId: a.noteId,
    status: a.status,
    bytes: a.bytes,
    mime: a.mime,
    name: a.name,
    metaSealed: a.metaSealed,
    locked: a.locked,
    wrappedKey: a.wrappedKey,
    contentIv: a.contentIv,
    width: a.width,
    height: a.height,
    deletedAt: a.deletedAt,
    seq: a.seq,
  };
}

/* -------------------------------------------------------------------------- */
/*  Push                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Tracks quota movement so the user row is patched once per mutation instead of
 * once per operation.
 */
type Session = {
  user: Doc<"users">;
  usedDelta: number;
  reservedDelta: number;
};

const ok = (opId: string): OpResult => ({ opId, status: "ok" });
const reject = (opId: string, reason: string): OpResult => ({
  opId,
  status: "rejected",
  reason,
});

export const push = mutation({
  args: { deviceId: v.string(), ops: v.array(opV) },
  handler: async (ctx, { deviceId, ops }) => {
    const user = await requireUser(ctx);
    const seq = await openSeq(ctx, user._id);
    const now = Date.now();
    const session: Session = { user, usedDelta: 0, reservedDelta: 0 };
    const results: OpResult[] = [];
    const shouldCompact = new Set<string>();

    for (const op of ops) {
      results.push(await applyOp(ctx, session, seq, deviceId, now, op, shouldCompact));
    }

    if (session.usedDelta !== 0 || session.reservedDelta !== 0) {
      await ctx.db.patch(user._id, {
        usedBytes: Math.max(0, user.usedBytes + session.usedDelta),
        reservedBytes: Math.max(0, user.reservedBytes + session.reservedDelta),
      });
    }
    await seq.commit(deviceId);

    // Another device pushing recently is the cue for this one to poll fast;
    // it costs nothing extra because the head document is already loaded.
    const peers = seq.otherDevices(deviceId).filter(([, at]) => now - at < 3 * 60_000).length;

    return {
      results,
      headSeq: seq.peek(),
      shouldCompact: [...shouldCompact],
      activePeers: peers,
      serverTime: now,
    };
  },
});

async function applyOp(
  ctx: MutationCtx,
  session: Session,
  seq: SeqWriter,
  deviceId: string,
  now: number,
  op: Op,
  shouldCompact: Set<string>,
): Promise<OpResult> {
  switch (op.kind) {
    case "folder":
      return applyFolderOp(ctx, session, seq, deviceId, now, op);
    case "note":
      return applyNoteOp(ctx, session, seq, deviceId, now, op);
    case "update":
      return applyUpdateOp(ctx, session, seq, deviceId, now, op, shouldCompact);
    case "attachment.commit":
      return applyAttachmentCommit(ctx, session, seq, op);
    case "attachment.sweep":
      return applyAttachmentSweep(ctx, session, seq, now, op);
  }
}

const getFolder = (ctx: MutationCtx, userId: Id<"users">, folderId: string) =>
  ctx.db
    .query("folders")
    .withIndex("by_user_folder", (q) => q.eq("userId", userId).eq("folderId", folderId))
    .unique();

const getNote = (ctx: MutationCtx, userId: Id<"users">, noteId: string) =>
  ctx.db
    .query("notes")
    .withIndex("by_user_note", (q) => q.eq("userId", userId).eq("noteId", noteId))
    .unique();

function futureStamp(now: number, ...stamps: (Stamp | undefined)[]): boolean {
  return stamps.some((s) => s && isFromTheFuture(s, now));
}

async function applyFolderOp(
  ctx: MutationCtx,
  session: Session,
  seq: SeqWriter,
  deviceId: string,
  now: number,
  op: Extract<Op, { kind: "folder" }>,
): Promise<OpResult> {
  if (futureStamp(now, op.name?.ts, op.place?.ts, op.trash?.ts)) {
    return reject(op.opId, "clockSkew");
  }
  const existing = await getFolder(ctx, session.user._id, op.folderId);

  if (!existing) {
    if (!op.create) return reject(op.opId, "unknownFolder");
    const base: Stamp = { t: 0, d: deviceId };
    await ctx.db.insert("folders", {
      userId: session.user._id,
      folderId: op.folderId,
      parentId: op.place?.parentId ?? op.create.parentId,
      name: op.name?.sealed ? null : (op.name?.value ?? ""),
      nameSealed: op.name?.sealed,
      icon: op.name?.icon ?? null,
      sortKey: op.place?.sortKey ?? op.create.sortKey,
      locked: false,
      system: op.create.system,
      deletedAt: op.trash?.deletedAt ?? null,
      purged: false,
      ts: {
        name: op.name?.ts ?? base,
        place: op.place?.ts ?? base,
        trash: op.trash?.ts ?? base,
        lock: base,
      },
      deviceId,
      seq: seq.next(),
    });
    return ok(op.opId);
  }

  if (existing.purged) return reject(op.opId, "purged");

  const ts = { ...existing.ts };
  const patch: Partial<Doc<"folders">> = {};
  let changed = false;
  let moved = false;

  if (op.name && isNewer(op.name.ts, ts.name)) {
    patch.name = op.name.sealed ? null : op.name.value;
    patch.nameSealed = op.name.sealed;
    patch.icon = op.name.icon;
    ts.name = op.name.ts;
    changed = true;
  }
  if (op.place && isNewer(op.place.ts, ts.place)) {
    if (op.place.parentId === op.folderId) return reject(op.opId, "selfParent");
    patch.parentId = op.place.parentId;
    patch.sortKey = op.place.sortKey;
    ts.place = op.place.ts;
    changed = true;
    moved = true;
  }
  if (op.trash && isNewer(op.trash.ts, ts.trash)) {
    if (existing.system === "inbox" && op.trash.deletedAt !== null) {
      return reject(op.opId, "systemFolder");
    }
    patch.deletedAt = op.trash.deletedAt;
    ts.trash = op.trash.ts;
    changed = true;
  }

  if (!changed) return ok(op.opId);

  await ctx.db.patch(existing._id, { ...patch, ts, deviceId, seq: seq.next() });

  if (moved) {
    const repaired = await repairCycle(ctx, session.user._id, op.folderId, seq, deviceId);
    if (repaired) return { opId: op.opId, status: "ok", reason: "repaired" };
  }
  return ok(op.opId);
}

/**
 * Two devices can each move a folder under the other while offline. Whichever
 * write lands second sees the first (the sequence head serialises them), so the
 * cycle is detectable here; we break it by reparenting to the root rather than
 * leaving an orphaned island the UI could never render.
 */
async function repairCycle(
  ctx: MutationCtx,
  userId: Id<"users">,
  folderId: string,
  seq: SeqWriter,
  deviceId: string,
): Promise<boolean> {
  const seen = new Set<string>([folderId]);
  let current = await getFolder(ctx, userId, folderId);
  let depth = 0;
  while (current?.parentId) {
    if (seen.has(current.parentId) || ++depth > MAX_FOLDER_DEPTH) {
      const self = await getFolder(ctx, userId, folderId);
      if (self) await ctx.db.patch(self._id, { parentId: null, deviceId, seq: seq.next() });
      return true;
    }
    seen.add(current.parentId);
    current = await getFolder(ctx, userId, current.parentId);
  }
  return false;
}

async function applyNoteOp(
  ctx: MutationCtx,
  session: Session,
  seq: SeqWriter,
  deviceId: string,
  now: number,
  op: Extract<Op, { kind: "note" }>,
): Promise<OpResult> {
  if (
    futureStamp(now, op.title?.ts, op.preview?.ts, op.place?.ts, op.pin?.ts, op.trash?.ts)
  ) {
    return reject(op.opId, "clockSkew");
  }
  const existing = await getNote(ctx, session.user._id, op.noteId);

  if (!existing) {
    if (!op.create) return reject(op.opId, "unknownNote");
    const base: Stamp = { t: 0, d: deviceId };
    await ctx.db.insert("notes", {
      userId: session.user._id,
      noteId: op.noteId,
      folderId: op.place?.folderId ?? op.create.folderId,
      kind: op.create.noteKind,
      title: op.title?.sealed ? null : (op.title?.value ?? ""),
      titleSealed: op.title?.sealed,
      preview: op.title?.preview ?? null,
      pinned: op.pin?.pinned ?? false,
      sortKey: op.place?.sortKey ?? op.create.sortKey,
      locked: false,
      keyEpoch: 0,
      deletedAt: op.trash?.deletedAt ?? null,
      purged: false,
      lastUpdateSeq: 0,
      snapshotSeq: 0,
      sinceSnapshot: { count: 0, bytes: 0 },
      bodyBytes: 0,
      ts: {
        title: op.title?.ts ?? base,
        preview: op.preview?.ts ?? base,
        place: op.place?.ts ?? base,
        pin: op.pin?.ts ?? base,
        trash: op.trash?.ts ?? base,
        lock: base,
      },
      deviceId,
      seq: seq.next(),
      updatedAt: now,
    });
    return ok(op.opId);
  }

  if (existing.purged) return reject(op.opId, "purged");

  const ts = { ...existing.ts };
  const patch: Partial<Doc<"notes">> = {};
  let changed = false;
  // Only a change to the note's words counts as an edit. Moving, pinning or
  // trashing it leaves "last updated" alone, so filing a note away does not
  // shoot it to the top of every list as if it had just been written.
  let edited = false;

  if (op.title && isNewer(op.title.ts, ts.title)) {
    if (existing.locked && !op.title.sealed) return reject(op.opId, "plaintextIntoLockedNote");
    patch.title = op.title.sealed ? null : op.title.value;
    patch.titleSealed = op.title.sealed;
    patch.preview = op.title.preview;
    ts.title = op.title.ts;
    ts.preview = op.title.ts;
    changed = true;
    edited = true;
  }
  if (op.preview && isNewer(op.preview.ts, ts.preview ?? ZERO_STAMP)) {
    // Never touches the title: that is the whole point of the separate group.
    patch.preview = existing.locked ? null : op.preview.value;
    ts.preview = op.preview.ts;
    changed = true;
    edited = true;
  }
  if (op.place && isNewer(op.place.ts, ts.place)) {
    patch.folderId = op.place.folderId;
    patch.sortKey = op.place.sortKey;
    ts.place = op.place.ts;
    changed = true;
  }
  if (op.pin && isNewer(op.pin.ts, ts.pin)) {
    patch.pinned = op.pin.pinned;
    ts.pin = op.pin.ts;
    changed = true;
  }
  if (op.trash && isNewer(op.trash.ts, ts.trash)) {
    patch.deletedAt = op.trash.deletedAt;
    ts.trash = op.trash.ts;
    changed = true;
  }

  if (!changed) return ok(op.opId);

  await ctx.db.patch(existing._id, {
    ...patch,
    ts,
    deviceId,
    seq: seq.next(),
    ...(edited ? { updatedAt: now } : {}),
  });
  return ok(op.opId);
}

async function applyUpdateOp(
  ctx: MutationCtx,
  session: Session,
  seq: SeqWriter,
  deviceId: string,
  now: number,
  op: Extract<Op, { kind: "update" }>,
  shouldCompact: Set<string>,
): Promise<OpResult> {
  const replay = await ctx.db
    .query("noteUpdates")
    .withIndex("by_user_op", (q) => q.eq("userId", session.user._id).eq("opId", op.opId))
    .unique();
  if (replay) return ok(op.opId);

  const note = await getNote(ctx, session.user._id, op.noteId);
  if (!note) return reject(op.opId, "unknownNote");
  if (note.purged) return reject(op.opId, "purged");
  // The epoch is the fence that stops a device which has not noticed a lock
  // from writing readable content to the server.
  if (note.keyEpoch !== op.keyEpoch) return reject(op.opId, "epochMismatch");
  if (note.locked && !op.iv) return reject(op.opId, "plaintextIntoLockedNote");
  if (!note.locked && op.iv) return reject(op.opId, "ciphertextIntoPlainNote");

  const size = op.payload.byteLength;
  const { user, usedDelta, reservedDelta } = session;
  if (user.usedBytes + usedDelta + user.reservedBytes + reservedDelta + size > user.quotaBytes) {
    return reject(op.opId, "quotaExceeded");
  }

  const updateSeq = seq.next();
  await ctx.db.insert("noteUpdates", {
    userId: user._id,
    noteId: op.noteId,
    opId: op.opId,
    deviceId,
    keyEpoch: op.keyEpoch,
    payload: op.payload,
    iv: op.iv,
    size,
    seq: updateSeq,
  });

  const sinceSnapshot = {
    count: note.sinceSnapshot.count + 1,
    bytes: note.sinceSnapshot.bytes + size,
  };
  // The note row is deliberately not given a new sequence: peers learn about
  // the change from the update row itself, so bumping it would double the
  // feed for no new information.
  await ctx.db.patch(note._id, {
    lastUpdateSeq: updateSeq,
    sinceSnapshot,
    bodyBytes: note.bodyBytes + size,
    updatedAt: now,
  });
  session.usedDelta += size;

  if (
    sinceSnapshot.count >= COMPACT_UPDATE_COUNT ||
    sinceSnapshot.bytes >= COMPACT_UPDATE_BYTES
  ) {
    shouldCompact.add(op.noteId);
  }
  return ok(op.opId);
}

async function applyAttachmentCommit(
  ctx: MutationCtx,
  session: Session,
  seq: SeqWriter,
  op: Extract<Op, { kind: "attachment.commit" }>,
): Promise<OpResult> {
  const row = await ctx.db
    .query("attachments")
    .withIndex("by_user_attachment", (q) =>
      q.eq("userId", session.user._id).eq("attachmentId", op.attachmentId),
    )
    .unique();
  if (!row) return reject(op.opId, "unknownAttachment");
  if (row.status === "committed") return ok(op.opId);
  if (row.status === "orphan") return reject(op.opId, "reservationExpired");

  // Trust the file, not the client: the declared size was only a reservation.
  const meta = await ctx.db.system.get(op.storageId);
  if (!meta) return reject(op.opId, "missingUpload");
  const actual = meta.size;

  if (actual > row.reservedBytes) {
    await ctx.storage.delete(op.storageId);
    await ctx.db.patch(row._id, { status: "orphan", expiresAt: null, seq: seq.next() });
    session.reservedDelta -= row.reservedBytes;
    return reject(op.opId, "largerThanReserved");
  }

  await ctx.db.patch(row._id, {
    status: "committed",
    storageId: op.storageId,
    bytes: actual,
    expiresAt: null,
    seq: seq.next(),
  });
  session.usedDelta += actual;
  session.reservedDelta -= row.reservedBytes;
  return ok(op.opId);
}

/**
 * After a compaction the client knows exactly which attachments the document
 * still references. Anything else is marked and swept 30 days later, so an
 * image removed by mistake can still come back with an undo.
 */
async function applyAttachmentSweep(
  ctx: MutationCtx,
  session: Session,
  seq: SeqWriter,
  now: number,
  op: Extract<Op, { kind: "attachment.sweep" }>,
): Promise<OpResult> {
  const referenced = new Set(op.referenced);
  const rows = await ctx.db
    .query("attachments")
    .withIndex("by_user_note", (q) =>
      q.eq("userId", session.user._id).eq("noteId", op.noteId),
    )
    .collect();

  for (const row of rows) {
    if (row.status !== "committed" || row.deletedAt !== null) continue;
    const stillUsed = referenced.has(row.attachmentId);
    if (stillUsed && row.unreferencedAt !== null) {
      await ctx.db.patch(row._id, { unreferencedAt: null, seq: seq.next() });
    } else if (!stillUsed && row.unreferencedAt === null) {
      await ctx.db.patch(row._id, { unreferencedAt: now, seq: seq.next() });
    }
  }
  return ok(op.opId);
}

/** Lets a client correct its clock before its stamps get rejected. */
export const serverTime = query({
  args: {},
  handler: async () => Date.now(),
});
