"use client";

import { uuidv7 } from "uuidv7";
import * as Y from "yjs";
import { toArrayBuffer, toBytes } from "@/lib/bytes";
import { db } from "@/lib/db";
import { vault } from "@/lib/crypto/vault";
import type { Note } from "@/lib/types";
import { enqueue } from "./outbox";
import { ORIGIN, extractText, firstLine } from "./ydoc";

/** Local edits are batched for this long before becoming one update row. */
const FLUSH_MS = 500;

type Handle = {
  noteId: string;
  doc: Y.Doc;
  keyEpoch: number;
  refs: number;
  buffer: Uint8Array[];
  timer: ReturnType<typeof setTimeout> | null;
  detach: () => void;
};

const handles = new Map<string, Handle>();
const bodyListeners = new Set<(noteId: string) => void>();

export function onBodyChanged(listener: (noteId: string) => void): () => void {
  bodyListeners.add(listener);
  return () => bodyListeners.delete(listener);
}

function announce(noteId: string) {
  for (const listener of bodyListeners) listener(noteId);
}

/**
 * Rebuilds a note's CRDT document from what this device has stored: the merged
 * snapshot first, then every update on top, decrypting as needed.
 */
async function hydrate(noteId: string, note: Note | undefined, doc: Y.Doc): Promise<void> {
  const database = db();
  const snapshot = await database.snapshots.get(noteId);
  const updates = await database.updates.where("noteId").equals(noteId).toArray();
  updates.sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER));

  const locked = note?.locked === true;
  const key =
    locked && note?.wrappedKey && vault.isUnlocked
      ? await vault.noteKey(noteId, note.keyEpoch, note.wrappedKey)
      : null;

  const applyOne = async (data: Uint8Array, iv: Uint8Array | undefined, epoch: number) => {
    if (!iv) {
      Y.applyUpdate(doc, data, ORIGIN.load);
      return;
    }
    if (!key) return; // Locked and no key: the document stays empty on purpose.
    const { open } = await import("@/lib/crypto/primitives");
    const { ctx } = await import("@/lib/crypto/context");
    const plain = await open(key, data, iv, ctx.yjsUpdate(noteId, epoch));
    Y.applyUpdate(doc, plain, ORIGIN.load);
  };

  if (snapshot) {
    await applyOne(snapshot.data, snapshot.iv, snapshot.keyEpoch);
  }
  for (const update of updates) {
    await applyOne(update.data, update.iv, update.keyEpoch);
  }
}

async function flush(handle: Handle): Promise<void> {
  handle.timer = null;
  if (handle.buffer.length === 0) return;
  const merged =
    handle.buffer.length === 1 ? handle.buffer[0]! : Y.mergeUpdates(handle.buffer);
  handle.buffer = [];

  const database = db();
  const note = await database.notes.get(handle.noteId);
  if (!note) return;

  const opId = uuidv7();
  let data = merged;
  let iv: Uint8Array | undefined;

  if (note.locked) {
    if (!note.wrappedKey || !vault.isUnlocked) {
      // Cannot encrypt right now; keep the edit buffered rather than writing
      // readable bytes anywhere.
      handle.buffer.unshift(merged);
      return;
    }
    const key = await vault.noteKey(handle.noteId, note.keyEpoch, note.wrappedKey);
    const { seal } = await import("@/lib/crypto/primitives");
    const { ctx } = await import("@/lib/crypto/context");
    const sealed = await seal(key, merged, ctx.yjsUpdate(handle.noteId, note.keyEpoch));
    data = sealed.ct;
    iv = sealed.iv;
  }

  await database.updates.add({
    noteId: handle.noteId,
    seq: null,
    opId,
    keyEpoch: note.keyEpoch,
    data,
    iv,
    pushed: 0,
    createdAt: Date.now(),
  });

  await enqueue({
    opId,
    kind: "update",
    entityId: handle.noteId,
    payload: {
      kind: "update",
      noteId: handle.noteId,
      keyEpoch: note.keyEpoch,
      payload: toArrayBuffer(data),
      ...(iv ? { iv: toArrayBuffer(iv) } : {}),
    },
  });

  // The searchable text and the list preview both come from the document, and
  // are kept in plaintext only when the note itself is not locked.
  const text = extractText(handle.doc);
  await database.bodies.put({
    noteId: handle.noteId,
    throughSeq: (await database.bodies.get(handle.noteId))?.throughSeq ?? 0,
    keyEpoch: note.keyEpoch,
    text: note.locked ? null : text,
    updatedAt: Date.now(),
  });

  if (!note.locked) {
    const preview = firstLine(text, 160);
    if (preview !== note.preview) {
      await database.notes.update(handle.noteId, { preview, updatedAt: Date.now() });
    }
  }
  announce(handle.noteId);
}

export async function acquireDoc(noteId: string): Promise<Y.Doc> {
  const existing = handles.get(noteId);
  if (existing) {
    existing.refs += 1;
    return existing.doc;
  }

  const doc = new Y.Doc();
  const note = await db().notes.get(noteId);
  await hydrate(noteId, note, doc);

  const handle: Handle = {
    noteId,
    doc,
    keyEpoch: note?.keyEpoch ?? 0,
    refs: 1,
    buffer: [],
    timer: null,
    detach: () => {},
  };

  const observer = (update: Uint8Array, origin: unknown) => {
    if (origin === ORIGIN.remote || origin === ORIGIN.load) return;
    handle.buffer.push(update);
    if (!handle.timer) handle.timer = setTimeout(() => void flush(handle), FLUSH_MS);
  };
  doc.on("update", observer);
  handle.detach = () => doc.off("update", observer);

  handles.set(noteId, handle);
  return doc;
}

export async function releaseDoc(noteId: string): Promise<void> {
  const handle = handles.get(noteId);
  if (!handle) return;
  handle.refs -= 1;
  if (handle.refs > 0) return;
  if (handle.timer) clearTimeout(handle.timer);
  await flush(handle);
  handle.detach();
  handle.doc.destroy();
  handles.delete(noteId);
}

export function openDoc(noteId: string): Y.Doc | undefined {
  return handles.get(noteId)?.doc;
}

/** Applies an update that arrived from another device. */
export function applyRemote(noteId: string, update: Uint8Array): void {
  const handle = handles.get(noteId);
  if (!handle) return;
  Y.applyUpdate(handle.doc, update, ORIGIN.remote);
  announce(noteId);
}

/** Forces a reload after a lock, an unlock, or a snapshot replacement. */
export async function reloadDoc(noteId: string): Promise<void> {
  const handle = handles.get(noteId);
  if (!handle) return;
  if (handle.timer) {
    clearTimeout(handle.timer);
    handle.timer = null;
  }
  handle.detach();
  const fresh = new Y.Doc();
  const note = await db().notes.get(noteId);
  await hydrate(noteId, note, fresh);
  // Replace contents in place so open editors keep their binding.
  Y.applyUpdate(handle.doc, Y.encodeStateAsUpdate(fresh), ORIGIN.remote);
  fresh.destroy();
  const observer = (update: Uint8Array, origin: unknown) => {
    if (origin === ORIGIN.remote || origin === ORIGIN.load) return;
    handle.buffer.push(update);
    if (!handle.timer) handle.timer = setTimeout(() => void flush(handle), FLUSH_MS);
  };
  handle.doc.on("update", observer);
  handle.detach = () => handle.doc.off("update", observer);
  handle.keyEpoch = note?.keyEpoch ?? handle.keyEpoch;
  announce(noteId);
}

/** Flushes every open document, for example before the tab goes away. */
export async function flushAll(): Promise<void> {
  await Promise.all([...handles.values()].map((handle) => flush(handle)));
}

/**
 * Builds a document from storage without keeping it open. Used by locking,
 * compaction and search indexing.
 */
export async function withDetachedDoc<T>(
  noteId: string,
  fn: (doc: Y.Doc) => Promise<T> | T,
): Promise<T> {
  const live = handles.get(noteId);
  if (live) return fn(live.doc);
  const doc = new Y.Doc();
  try {
    const note = await db().notes.get(noteId);
    await hydrate(noteId, note, doc);
    return await fn(doc);
  } finally {
    doc.destroy();
  }
}

export { toBytes };
