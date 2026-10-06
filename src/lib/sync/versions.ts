"use client";

import type { ConvexReactClient } from "convex/react";
import * as Y from "yjs";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { toArrayBuffer } from "@/lib/bytes";
import { ctx } from "@/lib/crypto/context";
import { open, seal } from "@/lib/crypto/primitives";
import { vault } from "@/lib/crypto/vault";
import { db, getMeta, setMeta } from "@/lib/db";
import { acquireDoc, releaseDoc, withSentDoc, withStoredDoc } from "./docs";
import { bodyFragment } from "./ydoc";

/** How often, at most, a version is kept while a note is edited: the server's own (VERSION_GAP_MS). */
const GAP_MS = 10 * 60 * 1000;
const SAVED_AT = "versionsSavedAt";

/** When this device last kept a version of each note, to ask the server no more often than it takes one. */
async function savedAt(): Promise<Record<string, number>> {
  return getMeta<Record<string, number>>(SAVED_AT, {});
}

/** Whether a version of this note is due: none kept here for ten minutes. */
export async function versionDue(noteId: string, now = Date.now()): Promise<boolean> {
  return now - ((await savedAt())[noteId] ?? 0) >= GAP_MS;
}

/**
 * Keeps a version of a note on the server: `state`, sealed as the note's
 * updates are when it is locked, uploaded to file storage. Nothing for an
 * empty note, nor a locked one with the vault closed. Whether one was kept.
 */
async function keep(
  client: ConvexReactClient,
  noteId: string,
  state: Uint8Array | null,
  beforeRestore = false,
): Promise<boolean> {
  const note = await db().notes.get(noteId);
  if (!note || note.purged || !state) return false;
  let body = state;
  let iv: Uint8Array | undefined;
  if (note.locked) {
    if (!note.wrappedKey || !vault.isUnlocked) return false;
    const key = await vault.noteKey(noteId, note.keyEpoch, note.wrappedKey);
    const sealed = await seal(key, state, ctx.noteVersion(noteId, note.keyEpoch));
    body = sealed.ct;
    iv = sealed.iv;
  }
  const uploadUrl = await client.mutation(api.notes.snapshotUploadUrl, {});
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: toArrayBuffer(body),
  });
  if (!response.ok) return false;
  const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
  const result = await client.mutation(api.versions.save, {
    noteId,
    keyEpoch: note.keyEpoch,
    storageId,
    ...(iv ? { iv: toArrayBuffer(iv) } : {}),
    ...(beforeRestore ? { beforeRestore } : {}),
  });
  // Kept, or another device kept one a moment ago: none due for a while either way.
  if (result.status === "ok" || result.reason === "tooSoon") {
    await setMeta(SAVED_AT, { ...(await savedAt()), [noteId]: Date.now() });
  }
  return result.status === "ok";
}

/** A document's state, or null when it holds nothing. */
const stateOf = (doc: Y.Doc) => (bodyFragment(doc).length > 0 ? Y.encodeStateAsUpdate(doc) : null);

/**
 * A note as it was before the edits this device is about to send, if a
 * version of it is due: what the server has of it (withSentDoc). Read
 * before they are sent, and kept after ({@link keepVersion}), so the edits
 * do not wait for it.
 */
export async function stateBeforeEdits(noteId: string): Promise<Uint8Array | null> {
  if (!(await versionDue(noteId))) return null;
  return withSentDoc(noteId, stateOf).catch(() => null);
}

/** Keeps a state {@link stateBeforeEdits} read; a failure is let go, a version being a convenience. */
export function keepVersion(
  client: ConvexReactClient,
  noteId: string,
  state: Uint8Array,
): Promise<boolean> {
  return keep(client, noteId, state).catch(() => false);
}

/** A version's place in a note's history: when it was kept. */
export type VersionRow = {
  versionId: Id<"noteVersions">;
  createdAt: number;
  size: number;
  keyEpoch: number;
};

/** A note's versions, newest first. */
export function listVersions(client: ConvexReactClient, noteId: string): Promise<VersionRow[]> {
  return client.query(api.versions.list, { noteId });
}

/** Why a version could not be read. */
export class VersionUnavailableError extends Error {
  constructor(readonly reason: "missing" | "vaultClosed" | "otherKey") {
    super(`version unavailable: ${reason}`);
    this.name = "VersionUnavailableError";
  }
}

/** A version of a note, as a document: downloaded, and opened with the vault for a locked note. */
export async function openVersion(
  client: ConvexReactClient,
  versionId: Id<"noteVersions">,
): Promise<Y.Doc> {
  const got = await client.query(api.versions.get, { versionId });
  if (!got?.url) throw new VersionUnavailableError("missing");
  const response = await fetch(got.url);
  if (!response.ok) throw new VersionUnavailableError("missing");
  let state: Uint8Array = new Uint8Array(await response.arrayBuffer());
  if (got.iv) {
    const note = await db().notes.get(got.noteId);
    if (!note?.wrappedKey) throw new VersionUnavailableError("missing");
    if (!vault.isUnlocked) throw new VersionUnavailableError("vaultClosed");
    if (note.keyEpoch !== got.keyEpoch) throw new VersionUnavailableError("otherKey");
    const key = await vault.noteKey(got.noteId, note.keyEpoch, note.wrappedKey);
    state = await open(
      key,
      state,
      new Uint8Array(got.iv),
      ctx.noteVersion(got.noteId, got.keyEpoch),
    );
  }
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
}

/**
 * Puts a note back as it was in a version: its body made what the version
 * holds, as an edit like any other, which every device then gets. The note
 * as it is now is kept as a version first, so this can be undone the same
 * way. The title is left as it is.
 */
export async function restoreVersion(
  client: ConvexReactClient,
  noteId: string,
  version: Y.Doc,
): Promise<void> {
  await keep(client, noteId, await withStoredDoc(noteId, stateOf), true).catch(() => false);
  const doc = await acquireDoc(noteId);
  try {
    const body = bodyFragment(doc);
    const blocks = bodyFragment(version)
      .toArray()
      .map((node) => (node as Y.XmlElement | Y.XmlText).clone());
    doc.transact(() => {
      body.delete(0, body.length);
      body.insert(0, blocks);
    });
  } finally {
    await releaseDoc(noteId);
  }
}
