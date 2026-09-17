"use client";

import { uuidv7 } from "uuidv7";
import { db } from "@/lib/db";
import { deviceId } from "@/lib/db/meta";
import { between } from "@/lib/sortkey";
import type { Folder, Note, Stamp } from "@/lib/types";
import { stamp } from "./clock";
import { enqueue } from "./outbox";

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
 * IndexedDB cannot index null, so top-level rows are found with a scan rather
 * than through the parent index. At a personal note-taking scale that is a
 * handful of rows, and it avoids inventing a magic "root" parent id that every
 * other query would then have to know about.
 */
async function siblingKeyAfterLast(
  kind: "folders" | "notes",
  parent: string | null,
): Promise<string> {
  const database = db();
  const rows =
    kind === "folders"
      ? parent === null
        ? await database.folders.filter((f) => f.parentId === null).toArray()
        : await database.folders.where("parentId").equals(parent).toArray()
      : parent === null
        ? await database.notes.filter((n) => n.folderId === null).toArray()
        : await database.notes.where("folderId").equals(parent).toArray();
  const keys = rows
    .filter((r) => r.deletedAt === null && !r.purged)
    .map((r) => r.sortKey)
    .sort();
  return between(keys.at(-1) ?? null, null);
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

export async function renameFolder(folderId: string, name: string): Promise<void> {
  const database = db();
  const folder = await database.folders.get(folderId);
  if (!folder) return;
  const { ts } = await now();

  // A locked folder's name is stored as ciphertext, so the rename has to be
  // sealed before it leaves the device.
  let sealed: Folder["nameSealed"];
  if (folder.locked) {
    const { vault } = await import("@/lib/crypto/vault");
    sealed = await vault.sealFolderName(folderId, name);
  }

  await database.folders.update(folderId, {
    name: folder.locked ? null : name,
    nameSealed: sealed,
    ts: { ...folder.ts, name: ts },
  });
  await enqueue({
    kind: "folder",
    entityId: folderId,
    payload: {
      kind: "folder",
      folderId,
      name: {
        value: folder.locked ? null : name,
        ...(sealed ? { sealed } : {}),
        icon: folder.icon,
        ts,
      },
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
  if (!folder || folder.system === "inbox") return;
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
  if (!folder || folder.system === "inbox") return;
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

/* ---------------------------------------------------------------- notes */

export async function createNote(opts: {
  folderId: string | null;
  title?: string;
  kind?: "note" | "quick";
}): Promise<string> {
  const { ts, device } = await now();
  const noteId = uuidv7();
  const sortKey = await siblingKeyAfterLast("notes", opts.folderId);
  const kind = opts.kind ?? "note";
  const title = opts.title ?? "";

  const note: Note = {
    noteId,
    folderId: opts.folderId,
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
      create: { noteKind: kind, folderId: opts.folderId, sortKey },
      title: { value: title, preview: null, ts },
      place: { folderId: opts.folderId, sortKey, ts },
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
  const { ts } = await now();
  const key = sortKey ?? (await siblingKeyAfterLast("notes", folderId));

  await database.notes.update(noteId, {
    folderId,
    sortKey: key,
    ts: { ...note.ts, place: ts },
  });
  await enqueue({
    kind: "note",
    entityId: noteId,
    payload: { kind: "note", noteId, place: { folderId, sortKey: key, ts } },
  });
}

export async function setNotePinned(noteId: string, pinned: boolean): Promise<void> {
  const database = db();
  const note = await database.notes.get(noteId);
  if (!note) return;
  const { ts } = await now();
  await database.notes.update(noteId, { pinned, ts: { ...note.ts, pin: ts } });
  await enqueue({
    kind: "note",
    entityId: noteId,
    payload: { kind: "note", noteId, pin: { pinned, ts } },
  });
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

  if (!trashed && note.folderId && (await isAncestorTrashed(note.folderId))) {
    await moveNote(noteId, null);
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
