"use client";

import { uuidv7 } from "uuidv7";
import { db, getMeta, setMeta } from "@/lib/db";
import { META, deviceId } from "@/lib/db/meta";
import { between } from "@/lib/sortkey";
import { byPinPlace, placeAt } from "@/lib/note-order";
import type { Folder, Note, Stamp } from "@/lib/types";
import { stamp } from "./clock";
import { enqueue } from "./outbox";
import { lockCoverage } from "@/lib/vault/model";

/**
 * Every user action writes to the local database first and queues the server
 * operation second. The interface therefore behaves identically online and
 * offline, and the queue is the only thing that has to wait for a network.
 */

async function now(): Promise<{ ts: Stamp; device: string }> {
  const device = await deviceId();
  return { ts: stamp(device), device };
}

const zero = (d: string): Stamp => ({ t: 0, d });

/**
 * A key after every sibling's: where a folder made in a folder, or moved
 * into one, goes. At the top level, folders and the notes kept there (in
 * the sidebar, in no folder) are one order, so after both.
 */
async function siblingKeyAfterLast(
  kind: "folders" | "notes",
  parent: string | null,
): Promise<string> {
  const keys = parent === null ? await topLevelKeys() : await siblingKeys(kind, parent);
  return between(keys.at(-1) ?? null, null);
}

/**
 * The sort keys of everything at the top level, in order: the folders (but
 * Inbox, which is shown first whatever its key) and the notes in no folder,
 * which the sidebar shows among them.
 */
export async function topLevelKeys(): Promise<string[]> {
  const database = db();
  const folders = await database.folders
    .filter((f) => f.parentId === null && f.system === null && f.deletedAt === null && !f.purged)
    .toArray();
  return [...folders.map((f) => f.sortKey), ...(await siblingKeys("notes", null))].sort();
}

/**
 * A key before every sibling's: where a note made in a folder, or moved into
 * one, goes when its notes are placed by hand, as the newest go first when
 * they are ordered by time.
 */
async function siblingKeyBeforeFirst(parent: string | null): Promise<string> {
  const first = (await siblingKeys("notes", parent))[0];
  return between(null, first ?? null);
}

/**
 * The sort keys of a folder's (or the top level's) live rows, in order.
 *
 * IndexedDB cannot index null, so top-level rows are found with a scan rather
 * than through the parent index. At a personal note-taking scale that is a
 * handful of rows, and it avoids inventing a magic "root" parent id that every
 * other query would then have to know about.
 */
async function siblingKeys(kind: "folders" | "notes", parent: string | null): Promise<string[]> {
  const database = db();
  const rows =
    kind === "folders"
      ? parent === null
        ? await database.folders.filter((f) => f.parentId === null).toArray()
        : await database.folders.where("parentId").equals(parent).toArray()
      : parent === null
        ? await database.notes.filter((n) => n.folderId === null).toArray()
        : await database.notes.where("folderId").equals(parent).toArray();
  return rows
    .filter((r) => r.deletedAt === null && !r.purged)
    .map((r) => r.sortKey)
    .sort();
}

/* -------------------------------------------------------------- folders */

export async function createFolder(opts: {
  parentId: string | null;
  name: string;
}): Promise<string> {
  const { ts, device } = await now();
  const folderId = uuidv7();
  const sortKey = await siblingKeyAfterLast("folders", opts.parentId);

  const folder: Folder = {
    folderId,
    parentId: opts.parentId,
    name: opts.name,
    icon: null,
    sortKey,
    locked: false,
    system: null,
    deletedAt: null,
    purged: false,
    ts: { name: ts, place: ts, trash: zero(device), lock: zero(device) },
    seq: 0,
  };
  await db().folders.put(folder);
  await enqueue({
    kind: "folder",
    entityId: folderId,
    payload: {
      kind: "folder",
      folderId,
      create: { parentId: opts.parentId, sortKey, system: null },
      name: { value: opts.name, icon: null, ts },
      place: { parentId: opts.parentId, sortKey, ts },
    },
  });
  return folderId;
}

/**
 * The folder of templates' id: the same on every device, so that two making
 * it before either has heard of the other's make one folder, not two.
 */
export const TEMPLATES_FOLDER_ID = "templates";

/**
 * The folder whose notes are templates, made if this device has none
 * (`made`). Kept at the top, below Inbox; like Inbox, never trashed,
 * moved or locked.
 */
export async function ensureTemplatesFolder(): Promise<{ folderId: string; made: boolean }> {
  const folderId = TEMPLATES_FOLDER_ID;
  const existing = await db().folders.get(folderId);
  if (existing && !existing.purged) return { folderId, made: false };
  const { ts, device } = await now();
  const name = "テンプレート";
  const sortKey = "a0";
  await db().folders.put({
    folderId,
    parentId: null,
    name,
    icon: null,
    sortKey,
    locked: false,
    system: "templates",
    deletedAt: null,
    purged: false,
    ts: { name: ts, place: ts, trash: zero(device), lock: zero(device) },
    seq: 0,
  });
  await enqueue({
    kind: "folder",
    entityId: folderId,
    payload: {
      kind: "folder",
      folderId,
      create: { parentId: null, sortKey, system: "templates" },
      name: { value: name, icon: null, ts },
      place: { parentId: null, sortKey, ts },
    },
  });
  return { folderId, made: true };
}

export async function renameFolder(folderId: string, name: string): Promise<void> {
  const database = db();
  const folder = await database.folders.get(folderId);
  if (!folder) return;
  const { ts } = await now();

  // Always in plaintext, locked folder or not: only the notes inside a locked
  // folder are encrypted, and the plaintext name also replaces a name that an
  // earlier version sealed.
  await database.folders.update(folderId, {
    name,
    nameSealed: undefined,
    ts: { ...folder.ts, name: ts },
  });
  await enqueue({
    kind: "folder",
    entityId: folderId,
    payload: {
      kind: "folder",
      folderId,
      name: { value: name, icon: folder.icon, ts },
    },
  });
}

export async function moveFolder(
  folderId: string,
  parentId: string | null,
  sortKey?: string,
): Promise<void> {
  const database = db();
  const folder = await database.folders.get(folderId);
  if (!folder || folder.system !== null) return;
  const { ts } = await now();
  const key = sortKey ?? (await siblingKeyAfterLast("folders", parentId));

  await database.folders.update(folderId, {
    parentId,
    sortKey: key,
    ts: { ...folder.ts, place: ts },
  });
  await enqueue({
    kind: "folder",
    entityId: folderId,
    payload: { kind: "folder", folderId, place: { parentId, sortKey: key, ts } },
  });
}

export async function setFolderTrashed(
  folderId: string,
  trashed: boolean,
): Promise<void> {
  const database = db();
  const folder = await database.folders.get(folderId);
  if (!folder || folder.system !== null) return;
  const { ts } = await now();
  const deletedAt = trashed ? Date.now() : null;

  await database.folders.update(folderId, {
    deletedAt,
    ts: { ...folder.ts, trash: ts },
  });
  await enqueue({
    kind: "folder",
    entityId: folderId,
    payload: { kind: "folder", folderId, trash: { deletedAt, ts } },
  });

  // Restoring into a folder that is itself in the trash would leave the item
  // invisible, so it comes back to the root instead.
  if (!trashed && folder.parentId) {
    const parent = await database.folders.get(folderId);
    const ancestorTrashed = await isAncestorTrashed(parent?.parentId ?? null);
    if (ancestorTrashed) await moveFolder(folderId, null);
  }
}

async function isAncestorTrashed(parentId: string | null): Promise<boolean> {
  const database = db();
  let current = parentId;
  for (let depth = 0; current && depth < 64; depth += 1) {
    const folder = await database.folders.get(current);
    if (!folder) return false;
    if (folder.deletedAt !== null) return true;
    current = folder.parentId;
  }
  return false;
}

/* ---------------------------------------------------------------- inbox */

/**
 * The Inbox's folder id, or null before it has reached this device.
 *
 * Inbox is the one place for notes that are not filed anywhere yet. A note is
 * never left with no folder at all: that used to be a second, unnamed kind of
 * "unfiled" that could only be seen under all notes.
 */
export async function inboxFolderId(): Promise<string | null> {
  const inbox = await db().folders.where("system").equals("inbox").first();
  return inbox && !inbox.purged ? inbox.folderId : null;
}

/**
 * Files into Inbox the notes made here for it before this device had it
 * (see createNote), now that it does: those still at the top level where
 * they were made. One moved since, by hand, stays where it was put.
 */
export async function fileAwaitingInbox(): Promise<number> {
  const waiting = await getMeta<string[]>(META.awaitingInbox, []);
  if (waiting.length === 0) return 0;
  const inbox = await inboxFolderId();
  if (!inbox) return 0;
  let filed = 0;
  for (const noteId of waiting) {
    const note = await db().notes.get(noteId);
    if (!note || note.folderId !== null || note.purged) continue;
    await moveNote(noteId, inbox);
    filed += 1;
  }
  await setMeta(META.awaitingInbox, []);
  return filed;
}

/* ---------------------------------------------------------------- notes */

/**
 * Creates a note. Inside a locked folder it is locked from the start: its
 * key, title and every edit are encrypted before anything is stored or sent,
 * so nothing of it ever reaches the server in plaintext. That needs the
 * vault open; with it closed this throws VaultLockedError rather than
 * creating a plaintext note in a locked folder.
 */
export async function createNote(opts: {
  folderId: string | null;
  title?: string;
  kind?: "note" | "quick";
  /**
   * Kept at the top level, in no folder: shown in the sidebar among the
   * folders, after the last of them. Otherwise no folder chosen means Inbox
   * (or, on a device that has not received its Inbox yet, the top level).
   */
  topLevel?: boolean;
}): Promise<string> {
  const { ts, device } = await now();
  const noteId = uuidv7();
  const folderId = opts.topLevel ? null : (opts.folderId ?? (await inboxFolderId()));
  // For Inbox, which this device has not received yet: filed there once it
  // has (fileAwaitingInbox), not left in the sidebar.
  if (folderId === null && !opts.topLevel) {
    await setMeta(META.awaitingInbox, [...(await getMeta<string[]>(META.awaitingInbox, [])), noteId]);
  }
  const sortKey =
    folderId === null ? await siblingKeyAfterLast("notes", null) : await siblingKeyBeforeFirst(folderId);
  const kind = opts.kind ?? "note";
  const title = opts.title ?? "";

  const coverage = lockCoverage(await db().folders.toArray());
  if (folderId !== null && coverage.has(folderId)) {
    return createLockedNote({ noteId, folderId, sortKey, kind, title, ts, device });
  }

  const note: Note = {
    noteId,
    folderId,
    kind,
    title,
    preview: null,
    pinned: false,
    sortKey,
    locked: false,
    keyEpoch: 0,
    deletedAt: null,
    purged: false,
    lastUpdateSeq: 0,
    snapshotSeq: 0,
    ts: {
      title: ts,
      preview: zero(device),
      place: ts,
      pin: zero(device),
      trash: zero(device),
      lock: zero(device),
    },
    seq: 0,
    updatedAt: Date.now(),
  };
  await db().notes.put(note);
  await db().bodies.put({
    noteId,
    throughSeq: 0,
    keyEpoch: 0,
    text: "",
    updatedAt: Date.now(),
  });
  await enqueue({
    kind: "note",
    entityId: noteId,
    payload: {
      kind: "note",
      noteId,
      create: { noteKind: kind, folderId, sortKey },
      title: { value: title, preview: null, ts },
      place: { folderId, sortKey, ts },
    },
  });
  return noteId;
}

async function createLockedNote(args: {
  noteId: string;
  folderId: string;
  sortKey: string;
  kind: "note" | "quick";
  title: string;
  ts: Stamp;
  device: string;
}): Promise<string> {
  const { noteId, folderId, sortKey, kind, title, ts, device } = args;
  const { vault } = await import("@/lib/crypto/vault");
  const { seal } = await import("@/lib/crypto/primitives");
  const { ctx } = await import("@/lib/crypto/context");
  const { toArrayBuffer } = await import("@/lib/bytes");
  const epoch = 1;
  // Throws while the vault is closed: never a plaintext note here.
  const { key, wrapped } = await vault.createNoteKey(noteId, epoch);
  const out = await seal(key, new TextEncoder().encode(title), ctx.noteTitle(noteId, epoch));
  const titleSealed = { ct: toArrayBuffer(out.ct), iv: toArrayBuffer(out.iv) };

  const note: Note = {
    noteId,
    folderId,
    kind,
    title: null,
    titleSealed,
    preview: null,
    pinned: false,
    sortKey,
    locked: true,
    keyEpoch: epoch,
    wrappedKey: wrapped,
    lockOrigin: "folder",
    deletedAt: null,
    purged: false,
    lastUpdateSeq: 0,
    snapshotSeq: 0,
    ts: {
      title: ts,
      preview: zero(device),
      place: ts,
      pin: zero(device),
      trash: zero(device),
      lock: ts,
    },
    seq: 0,
    updatedAt: Date.now(),
  };
  await db().notes.put(note);
  await db().bodies.put({ noteId, throughSeq: 0, keyEpoch: epoch, text: null, updatedAt: Date.now() });
  await enqueue({
    kind: "note",
    entityId: noteId,
    payload: {
      kind: "note",
      noteId,
      create: { noteKind: kind, folderId, sortKey, lock: { keyEpoch: epoch, wrappedKey: wrapped, ts } },
      title: { value: null, sealed: titleSealed, preview: null, ts },
      place: { folderId, sortKey, ts },
    },
  });
  return noteId;
}

export async function renameNote(noteId: string, title: string): Promise<void> {
  const database = db();
  const note = await database.notes.get(noteId);
  if (!note) return;
  const { ts } = await now();

  if (note.locked) {
    const { vault } = await import("@/lib/crypto/vault");
    const { seal } = await import("@/lib/crypto/primitives");
    const { ctx } = await import("@/lib/crypto/context");
    const { toArrayBuffer } = await import("@/lib/bytes");
    if (!note.wrappedKey || !vault.isUnlocked) return;
    const key = await vault.noteKey(noteId, note.keyEpoch, note.wrappedKey);
    const out = await seal(
      key,
      new TextEncoder().encode(title),
      ctx.noteTitle(noteId, note.keyEpoch),
    );
    const sealed = { ct: toArrayBuffer(out.ct), iv: toArrayBuffer(out.iv) };
    await database.notes.update(noteId, {
      titleSealed: sealed,
      ts: { ...note.ts, title: ts },
    });
    await enqueue({
      kind: "note",
      entityId: noteId,
      payload: {
        kind: "note",
        noteId,
        title: { value: null, sealed, preview: null, ts },
      },
    });
    return;
  }

  await database.notes.update(noteId, { title, ts: { ...note.ts, title: ts } });
  // The stored reading covers the title too, so it is now stale. Clearing it
  // is enough: the background pass recomputes anything missing.
  await database.bodies.update(noteId, { reading: undefined });
  await enqueue({
    kind: "note",
    entityId: noteId,
    payload: {
      kind: "note",
      noteId,
      title: { value: title, preview: note.preview, ts },
    },
  });
}

export async function moveNote(
  noteId: string,
  folderId: string | null,
  sortKey?: string,
): Promise<void> {
  const database = db();
  const note = await database.notes.get(noteId);
  if (!note) return;
  // No folder: the top level, in the sidebar, after what is there.
  const target = folderId;
  if (note.folderId === target && sortKey === undefined) return;
  const { ts } = await now();
  const key =
    sortKey ?? (target === null ? await siblingKeyAfterLast("notes", null) : await siblingKeyBeforeFirst(target));

  await database.notes.update(noteId, {
    folderId: target,
    sortKey: key,
    ts: { ...note.ts, place: ts },
  });
  await enqueue({
    kind: "note",
    entityId: noteId,
    payload: { kind: "note", noteId, place: { folderId: target, sortKey: key, ts } },
  });
}

/**
 * Writes a note's pin, and (`key`) its place among the pinned: each on its
 * own stamp, so that a place written for it never decides it is pinned.
 */
async function writePin(
  noteId: string,
  change: { pinned?: boolean; key?: string },
): Promise<void> {
  const note = await db().notes.get(noteId);
  if (!note) return;
  const { ts } = await now();
  await db().notes.update(noteId, {
    ...(change.pinned === undefined ? {} : { pinned: change.pinned }),
    ...(change.key === undefined ? {} : { pinKey: change.key }),
    ts: {
      ...note.ts,
      ...(change.pinned === undefined ? {} : { pin: ts }),
      ...(change.key === undefined ? {} : { pinPlace: ts }),
    },
  });
  await enqueue({
    kind: "note",
    entityId: noteId,
    payload: {
      kind: "note",
      noteId,
      ...(change.pinned === undefined ? {} : { pin: { pinned: change.pinned, ts } }),
      ...(change.key === undefined ? {} : { pinPlace: { key: change.key, ts } }),
    },
  });
}

/**
 * The pinned notes shown (not in the trash), in their order among the
 * pinned, every one with a place: those pinned before there were places
 * (with none, first) given places in the order they are in, before the
 * first that has one. Those that have one are left as they are.
 */
async function placedPinned(): Promise<Note[]> {
  const pinned = (
    await db()
      .notes.filter((note) => note.pinned && note.deletedAt === null && !note.purged)
      .toArray()
  ).sort(byPinPlace);
  const unplaced = pinned.filter((note) => !note.pinKey);
  if (unplaced.length === 0) return pinned;
  let before = pinned.find((note) => note.pinKey)?.pinKey ?? null;
  const keys = new Map<string, string>();
  for (const note of [...unplaced].reverse()) {
    before = between(null, before);
    keys.set(note.noteId, before);
    await writePin(note.noteId, { key: before });
  }
  return pinned.map((note) => (keys.has(note.noteId) ? { ...note, pinKey: keys.get(note.noteId) } : note));
}

/** Pins a note, first among the pinned, or unpins it. */
export async function setNotePinned(noteId: string, pinned: boolean): Promise<void> {
  await setNotesPinned([noteId], pinned);
}

/**
 * Pins notes (those not pinned yet), first among the pinned, in the order
 * given, or unpins them.
 */
export async function setNotesPinned(noteIds: string[], pinned: boolean): Promise<void> {
  const notes = (await db().notes.bulkGet(noteIds)).filter(
    (note): note is Note => note !== undefined && note.pinned !== pinned,
  );
  if (notes.length === 0) return;
  if (!pinned) {
    for (const note of notes) await writePin(note.noteId, { pinned: false });
    return;
  }
  // Each before the one after it, the first given first of all.
  let after = (await placedPinned())[0]?.pinKey ?? null;
  for (const note of [...notes].reverse()) {
    after = between(null, after);
    await writePin(note.noteId, { pinned: true, key: after });
  }
}

/**
 * Puts a pinned note among the pinned notes `others` of a list (in their
 * order there, itself not one of them) at `index`: between the two it was
 * let go between, by their places as they are now (one may have been
 * placed, or unpinned, on another device meanwhile), as {@link placeAt}
 * does a note among a folder's.
 */
export async function placePinned(noteId: string, others: readonly string[], index: number) {
  const pinned = await placedPinned();
  if (!pinned.some((each) => each.noteId === noteId)) return;
  const still = pinned.filter((each) => each.noteId !== noteId && others.includes(each.noteId));
  const after = others[index];
  const before = others[index - 1];
  let at = after ? still.findIndex((each) => each.noteId === after) : -1;
  if (at < 0) {
    const previous = before ? still.findIndex((each) => each.noteId === before) : -1;
    at = previous >= 0 ? previous + 1 : before ? Math.min(index, still.length) : 0;
  }
  const { key, rekeyed } = placeAt(
    still.map((each) => ({ noteId: each.noteId, sortKey: each.pinKey! })),
    at,
  );
  for (const each of rekeyed) await writePin(each.noteId, { key: each.sortKey });
  await writePin(noteId, { key });
}

export async function setNoteTrashed(noteId: string, trashed: boolean): Promise<void> {
  const database = db();
  const note = await database.notes.get(noteId);
  if (!note) return;
  const { ts } = await now();
  const deletedAt = trashed ? Date.now() : null;

  await database.notes.update(noteId, { deletedAt, ts: { ...note.ts, trash: ts } });
  await enqueue({
    kind: "note",
    entityId: noteId,
    payload: { kind: "note", noteId, trash: { deletedAt, ts } },
  });

  // Restoring a note whose folder is still in the trash would leave it
  // invisible, so it comes back to Inbox, the home for anything unfiled.
  if (!trashed && note.folderId && (await isAncestorTrashed(note.folderId))) {
    await moveNote(noteId, await inboxFolderId());
  }
}

/** Reorders a note among its siblings after a drag. */
export async function reorderNote(
  noteId: string,
  folderId: string | null,
  before: string | null,
  after: string | null,
): Promise<void> {
  await moveNote(noteId, folderId, between(before, after));
}

export async function reorderFolder(
  folderId: string,
  parentId: string | null,
  before: string | null,
  after: string | null,
): Promise<void> {
  await moveFolder(folderId, parentId, between(before, after));
}
