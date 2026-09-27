"use client";

import { uuidv7 } from "uuidv7";
import * as Y from "yjs";
import { toArrayBuffer, toBytes } from "@/lib/bytes";
import { type BodyState, db } from "@/lib/db";
import { vault } from "@/lib/crypto/vault";
import { migrateOldQuickBody } from "@/lib/quick/body";
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
  /** The write under way, if one is: the next waits for it. */
  writing: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  detach: () => void;
};

const handles = new Map<string, Handle>();
const bodyListeners = new Set<(noteId: string) => void>();
/** Writes that have taken edits out of a buffer but not stored them yet. */
const writesInFlight = new Set<Promise<void>>();

/**
 * Whether any typed edit is not in local storage yet: still in a buffer, or
 * being written. The vault waits on this before closing, because a locked
 * note's edits can only be written while its key is available.
 */
export function hasUnsavedEdits(): boolean {
  if (writesInFlight.size > 0) return true;
  for (const handle of handles.values()) if (handle.buffer.length > 0) return true;
  return false;
}

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

  // Snapshots and incremental updates are sealed under different contexts, so
  // the right one has to be named here or authentication fails.
  const applyOne = async (
    kind: "snapshot" | "update",
    data: Uint8Array,
    iv: Uint8Array | undefined,
    epoch: number,
  ) => {
    if (!iv) {
      Y.applyUpdate(doc, data, ORIGIN.load);
      return;
    }
    if (!key) return; // Locked and no key: the document stays empty on purpose.
    const { open } = await import("@/lib/crypto/primitives");
    const { ctx } = await import("@/lib/crypto/context");
    const context =
      kind === "snapshot" ? ctx.yjsSnapshot(noteId, epoch) : ctx.yjsUpdate(noteId, epoch);
    const plain = await open(key, data, iv, context);
    Y.applyUpdate(doc, plain, ORIGIN.load);
  };

  if (snapshot) {
    await applyOne("snapshot", snapshot.data, snapshot.iv, snapshot.keyEpoch);
  }
  for (const update of updates) {
    await applyOne("update", update.data, update.iv, update.keyEpoch);
  }
}

async function flush(handle: Handle): Promise<void> {
  if (handle.timer) clearTimeout(handle.timer);
  handle.timer = null;
  // One write at a time, in the order the edits were made. A write that
  // fails puts its edits back, and the next takes them along with its own:
  // written while the first was still under way, those would be stored
  // before the edits they build on, and could not be read without them. It
  // also means a flush that returns has stored everything made before it,
  // rather than leaving some to a write that may yet fail.
  while (handle.writing) await handle.writing.catch(() => {});
  if (handle.buffer.length === 0) return;
  const merged =
    handle.buffer.length === 1 ? handle.buffer[0]! : Y.mergeUpdates(handle.buffer);
  handle.buffer = [];
  const writing = write(handle, merged).catch((error: unknown) => {
    // Not stored: put back ahead of anything typed since, to be written with
    // it by the next flush, whatever brings that on (the next edit, the note
    // closing, the page being hidden). Every later edit builds on this one.
    handle.buffer.unshift(merged);
    throw error;
  });
  handle.writing = writing;
  writesInFlight.add(writing);
  try {
    await writing;
  } finally {
    writesInFlight.delete(writing);
    handle.writing = null;
  }
}

async function write(handle: Handle, merged: Uint8Array): Promise<void> {
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

  // Stored and queued together, or neither: stored but never queued, an
  // update would never reach the server, where nothing built on it could be
  // read, and it would be stored a second time when written again.
  await database.transaction("rw", [database.updates, database.outbox], async () => {
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
      // Sent on its own, never bundled with the title: this runs on every
      // meaningful body edit, and `note` was read before the flush, so
      // resending a title from here would overwrite a rename made in between.
      const { stamp } = await import("./clock");
      const { deviceId } = await import("@/lib/db/meta");
      const ts = stamp(await deviceId());
      await database.notes.update(handle.noteId, {
        preview,
        updatedAt: Date.now(),
        ts: { ...note.ts, preview: ts },
      });
      await enqueue({
        kind: "note",
        entityId: handle.noteId,
        payload: {
          kind: "note",
          noteId: handle.noteId,
          preview: { value: preview, ts },
        },
      });
    } else {
      await database.notes.update(handle.noteId, { updatedAt: Date.now() });
    }
  }
  announce(handle.noteId);
}

/**
 * Puts the body of a quick note written before its body was shaped as
 * BlockNote shapes it into that shape, as an edit like any other: the
 * observer records it, and it is saved and sent, encrypted for a locked
 * note. Once stored, the note opens in the new shape and is left alone.
 *
 * Two devices that both rewrite the note before either has the other's
 * rewrite leave two copies of the body: the editor shows one, and drops the
 * other with anything typed into it meanwhile. That takes opening the note
 * on both while one is offline, since online a rewrite is sent within a
 * second or so. A copy known to be behind the server is not rewritten, as
 * what it lacks may be just such a rewrite. Nor is a locked note while the
 * vault is closed: what could not be read is not in the document.
 */
function migrateIfWhole(doc: Y.Doc, note: Note | undefined, body: BodyState | undefined): void {
  if (!note || !body || body.keyEpoch !== note.keyEpoch || body.throughSeq < note.lastUpdateSeq) {
    return;
  }
  if (note.locked && !vault.isUnlocked) return;
  try {
    migrateOldQuickBody(doc);
  } catch (error) {
    // The note opens as it is rather than not at all, and a body that came
    // in is still taken in. What could fail is done before the rewrite
    // writes anything, so the body is as it was.
    console.warn("Could not rewrite an old quick note's body", error);
  }
}

/** Documents being built from storage, shared by everyone who asks meanwhile. */
const opening = new Map<string, Promise<Handle>>();

async function openHandle(noteId: string): Promise<Handle> {
  const doc = new Y.Doc();
  const database = db();
  const [note, body] = await Promise.all([database.notes.get(noteId), database.bodies.get(noteId)]);
  try {
    await hydrate(noteId, note, doc);
  } catch (error) {
    doc.destroy();
    throw error;
  }

  const handle: Handle = {
    noteId,
    doc,
    keyEpoch: note?.keyEpoch ?? 0,
    refs: 0,
    buffer: [],
    writing: null,
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

  // Before any editor gets the document. A body that is not here yet is
  // rewritten once it is (migrateOpenDoc).
  migrateIfWhole(doc, note, body);

  handles.set(noteId, handle);
  return handle;
}

/**
 * The note's live document, shared by everyone who has it open. Two callers
 * asking while it is still being built get the same one: two documents for
 * one note would each save only their own edits.
 */
export async function acquireDoc(noteId: string): Promise<Y.Doc> {
  const existing = handles.get(noteId);
  if (existing) {
    existing.refs += 1;
    return existing.doc;
  }
  let pending = opening.get(noteId);
  if (!pending) {
    pending = openHandle(noteId).finally(() => opening.delete(noteId));
    opening.set(noteId, pending);
  }
  const handle = await pending;
  handle.refs += 1;
  return handle.doc;
}

export async function releaseDoc(noteId: string): Promise<void> {
  const handle = handles.get(noteId);
  if (!handle) return;
  handle.refs -= 1;
  if (handle.refs > 0) return;
  if (handle.timer) clearTimeout(handle.timer);
  handle.timer = null;
  // If this fails, the document stays as it is, held by nobody, with the
  // edits it could not store still in it: whoever opens the note next gets
  // it back, those edits included, and the next flush writes them first.
  await flush(handle);
  // Opened again while its last edits were being written: someone is using
  // it, so it stays.
  if (handle.refs > 0) return;
  handle.detach();
  handle.doc.destroy();
  if (handles.get(noteId) === handle) handles.delete(noteId);
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

/**
 * Forces a reload after a lock, an unlock, or a snapshot replacement. Edits
 * go on being recorded and saved throughout, those made while the stored
 * version is read included: they are written under whatever key the note has
 * by then, and what is read back only adds to the document.
 */
export async function reloadDoc(noteId: string): Promise<void> {
  const handle = handles.get(noteId);
  if (!handle) return;
  const fresh = new Y.Doc();
  try {
    const note = await db().notes.get(noteId);
    await hydrate(noteId, note, fresh);
    // Closed meanwhile: nobody is showing it any more.
    if (handles.get(noteId) !== handle) return;
    // Replace contents in place so open editors keep their binding.
    Y.applyUpdate(handle.doc, Y.encodeStateAsUpdate(fresh), ORIGIN.remote);
    handle.keyEpoch = note?.keyEpoch ?? handle.keyEpoch;
  } finally {
    fresh.destroy();
  }
  announce(noteId);
}

/**
 * Rewrites an open note's body as opening it would have (migrateIfWhole),
 * for a body that reached this device only after the note was opened: on a
 * device still fetching bodies, or one that was behind. The engine calls
 * this once what arrived is stored, in the open document, and counted in
 * how far this device's copy reaches.
 *
 * It is the open document that is looked at, not what storage holds: a
 * rewrite made here and not saved yet is in the one and not in the other,
 * and is not made again.
 */
export async function migrateOpenDoc(noteId: string): Promise<void> {
  const handle = handles.get(noteId);
  if (!handle) return;
  const database = db();
  const [note, body] = await Promise.all([database.notes.get(noteId), database.bodies.get(noteId)]);
  // Closed meanwhile: nobody is showing it any more.
  if (handles.get(noteId) !== handle) return;
  migrateIfWhole(handle.doc, note, body);
}

/**
 * Writes an open note's waiting edits now, rather than after the usual short
 * wait: for an edit something else is about to read back from storage.
 */
export async function flushDoc(noteId: string): Promise<void> {
  const handle = handles.get(noteId);
  if (handle) await flush(handle);
}

/** Flushes every open document, for example before the tab goes away. */
export async function flushAll(): Promise<void> {
  await Promise.all([...handles.values()].map((handle) => flush(handle)));
}

// Buffered edits to a locked note are written encrypted, so they have to be
// saved before the vault drops its key, not after. That includes writes some
// other flush already started: they still need the key to finish.
vault.onBeforeClose({
  save: async () => {
    await flushAll();
    await Promise.allSettled([...writesInFlight]);
  },
  pending: hasUnsavedEdits,
});

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

/**
 * The note as storage holds it, with what a document open here has on top.
 * Not the open document alone: one open in this tab is not given what
 * another tab of this device wrote (applyBatch takes that for this device's
 * own echo), so it can lack a change the server has, a file put in place of
 * another say. For telling the server what a note uses.
 */
export async function withStoredDoc<T>(
  noteId: string,
  fn: (doc: Y.Doc) => Promise<T> | T,
): Promise<T> {
  const doc = new Y.Doc();
  try {
    const note = await db().notes.get(noteId);
    await hydrate(noteId, note, doc);
    const live = handles.get(noteId);
    if (live) Y.applyUpdate(doc, Y.encodeStateAsUpdate(live.doc));
    return await fn(doc);
  } finally {
    doc.destroy();
  }
}

export { toBytes };
