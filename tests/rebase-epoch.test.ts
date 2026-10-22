import "fake-indexeddb/auto";
import type { ConvexReactClient } from "convex/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { toArrayBuffer } from "@/lib/bytes";
import { ctx } from "@/lib/crypto/context";
import { open, seal } from "@/lib/crypto/primitives";
import { type VaultRecord, prepareVault, unlockWithPassword, vault } from "@/lib/crypto/vault";
import { db, resetLocalData, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
// Loaded by the sync engine only when it gets round to them, which can be
// after a test is over: loaded here, before any test, instead.
import "@/lib/media/attachments";
import "@/lib/media/report-refs";
import "@/lib/search/yomi";
import "@/lib/sync/mutations";
import "@/lib/sync/versions";
import { acquireDoc, flushDoc, openDoc, releaseDoc, withDetachedDoc } from "@/lib/sync/docs";
import { SyncEngine } from "@/lib/sync/engine";
import type { Note, Sealed } from "@/lib/types";
import { fakeConvex } from "./helpers/fake-convex";
import { FAST_ARGON, zero } from "./helpers/seed";

const NOTE = "n1";
const PASSWORD = "パスワード";
/** What both devices had before either went on. */
const BEFORE = "元の文";
/** What device B typed while offline, after it, in two goes. */
const TYPED_FIRST = "、オフラインで";
const TYPED_THEN = "書き足した文";
const TYPED = TYPED_FIRST + TYPED_THEN;

const textOf = (doc: Y.Doc) => doc.getText("t").toString();

const note = (): Note => ({
  noteId: NOTE,
  folderId: null,
  kind: "note",
  title: "メモ",
  preview: null,
  pinned: false,
  sortKey: "a",
  locked: false,
  keyEpoch: 0,
  deletedAt: null,
  purged: false,
  lastUpdateSeq: 1,
  snapshotSeq: 0,
  ts: { title: zero, preview: zero, place: zero, pin: zero, trash: zero, lock: zero },
  seq: 1,
  updatedAt: 0,
});

type UpdateOp = {
  kind: "update";
  opId: string;
  noteId: string;
  keyEpoch: number;
  payload: ArrayBuffer;
  iv?: ArrayBuffer;
};

/** The engine works in the background, which a busy machine slows. */
const WAIT = { timeout: 10_000 };

let record: VaultRecord;
/** The note as it was on both devices, and as device A then locked it. */
let before: Uint8Array;
const engines: SyncEngine[] = [];
const opened: string[] = [];

beforeEach(async () => {
  await resetLocalData();
  await setMeta(META.pinPlacesPulled, true);
  const prepared = await prepareVault(PASSWORD, FAST_ARGON);
  record = { ...prepared.record, passkeys: [], version: 1 };
  prepared.adopt();

  const doc = new Y.Doc();
  doc.getText("t").insert(0, BEFORE);
  before = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  // Device B has all of it, sent and come back.
  await db().notes.put(note());
  await db().updates.add({
    noteId: NOTE,
    seq: 1,
    opId: "u1",
    keyEpoch: 0,
    data: before,
    pushed: 1,
    createdAt: 0,
  });
  await db().bodies.put({ noteId: NOTE, throughSeq: 1, keyEpoch: 0, text: "", updatedAt: 0 });
});

afterEach(async () => {
  for (const engine of engines.splice(0)) engine.stop();
  for (const noteId of opened.splice(0)) await releaseDoc(noteId);
  vault.lock();
});

/**
 * Device B, offline, types into the note twice over: two edits stored and
 * queued, under the key epoch it knows.
 */
async function typeOffline({ keepOpen }: { keepOpen: boolean }): Promise<void> {
  const doc = await acquireDoc(NOTE);
  doc.getText("t").insert(BEFORE.length, TYPED_FIRST);
  await flushDoc(NOTE);
  doc.getText("t").insert(BEFORE.length + TYPED_FIRST.length, TYPED_THEN);
  if (keepOpen) {
    opened.push(NOTE);
    await flushDoc(NOTE);
  } else {
    await releaseDoc(NOTE);
  }
  expect(
    await db()
      .outbox.filter((op) => op.kind === "update")
      .count(),
  ).toBe(2);
}

/** The note row as a pull brings it once the note is locked: sealed under epoch 1. */
async function hearOfLock(wrappedKey: Sealed): Promise<void> {
  await db().notes.update(NOTE, {
    locked: true,
    keyEpoch: 1,
    wrappedKey,
    lockOrigin: "note",
    title: null,
    preview: null,
  });
}

/**
 * Device A locks the note meanwhile: the server holds it as A had it, sealed
 * under key epoch 1, and refuses anything sent under epoch 0. Unless `heard`
 * is false, B learns of the lock (the note row as a pull brings it) before
 * its edits are sent.
 */
async function lockElsewhere({ heard = true }: { heard?: boolean } = {}) {
  const { key, wrapped } = await vault.createNoteKey(NOTE, 1);
  const snapshot = await seal(key, before, ctx.yjsSnapshot(NOTE, 1));
  if (heard) await hearOfLock(wrapped);

  const accepted: UpdateOp[] = [];
  const refused: UpdateOp[] = [];
  const server = fakeConvex({
    "sync:push": (args) => ({
      serverTime: Date.now(),
      activePeers: 0,
      shouldCompact: [],
      results: (args.ops as UpdateOp[]).map((op) => {
        if (op.kind !== "update") return { opId: op.opId, status: "ok" };
        // As convex/sync.ts checks them: the epoch first, then the sealing.
        if (op.keyEpoch !== 1) {
          refused.push(op);
          return { opId: op.opId, status: "rejected", reason: "epochMismatch" };
        }
        if (!op.iv) return { opId: op.opId, status: "rejected", reason: "plaintextIntoLockedNote" };
        accepted.push(op);
        return { opId: op.opId, status: "ok" };
      }),
    }),
    "notes:getBodies": (args) => ({
      bodies: (args.items as { noteId: string; haveThroughSeq: number }[]).map((item) => ({
        noteId: item.noteId,
        keyEpoch: 1,
        lastUpdateSeq: 1,
        snapshot:
          item.haveThroughSeq < 1
            ? {
                coversThroughSeq: 1,
                size: snapshot.ct.byteLength,
                payload: toArrayBuffer(snapshot.ct),
                iv: toArrayBuffer(snapshot.iv),
              }
            : null,
        updates: [],
      })),
      truncated: false,
    }),
  });

  /** The note as the server now has it, opened with the note's new key. */
  const onServer = async () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, before);
    for (const op of accepted) {
      Y.applyUpdate(
        doc,
        await open(key, new Uint8Array(op.payload), new Uint8Array(op.iv!), ctx.yjsUpdate(NOTE, 1)),
      );
    }
    const text = textOf(doc);
    doc.destroy();
    return text;
  };

  return { client: server.client, wrapped, accepted, refused, onServer };
}

type Server = Awaited<ReturnType<typeof lockElsewhere>>;

async function startEngine(client: ConvexReactClient): Promise<SyncEngine> {
  const engine = new SyncEngine({
    ...client,
    watchQuery: () => ({ localQueryResult: () => null, onUpdate: () => () => {} }),
  } as unknown as ConvexReactClient);
  engines.push(engine);
  await engine.start("me");
  return engine;
}

/** Edits stored here under the old key epoch and not sent under the new one. */
const keptUnderOldKey = () =>
  db()
    .updates.filter((update) => update.pushed === 0 && update.keyEpoch === 0)
    .count();

/** Until the edits have been refused, and the engine has nothing it can send. */
async function refused(engine: SyncEngine, server: Server): Promise<void> {
  await vi.waitFor(async () => {
    expect(server.refused.length).toBeGreaterThan(0);
    expect(await db().outbox.count()).toBe(0);
    expect(engine.current.pending).toBe(0);
  }, WAIT);
}

/** Until the edits have been refused and sent again, with nothing left to send. */
async function resent(engine: SyncEngine, server: Server): Promise<void> {
  await vi.waitFor(async () => {
    expect(server.refused.length).toBeGreaterThan(0);
    expect(await keptUnderOldKey()).toBe(0);
    expect(await db().outbox.count()).toBe(0);
    expect(engine.current.pending).toBe(0);
  }, WAIT);
}

/** Sent once, sealed, under the epoch the server now expects: no plaintext. */
function sentOnceSealed(server: Server) {
  expect(server.accepted).toHaveLength(1);
  expect(server.accepted[0]!.keyEpoch).toBe(1);
  expect(server.accepted[0]!.iv).toBeDefined();
}

/** Nothing of it kept here in plaintext, nor under the old key. */
async function storedSealed() {
  const rows = await db().updates.where("noteId").equals(NOTE).toArray();
  expect(rows.every((row) => row.iv !== undefined && row.keyEpoch === 1)).toBe(true);
}

describe("edits refused because the note was locked on another device", () => {
  test("in a note not open here: sent again, sealed under the new key, and kept here", async () => {
    await typeOffline({ keepOpen: false });
    const server = await lockElsewhere();
    const engine = await startEngine(server.client);
    await resent(engine, server);

    expect(await server.onServer()).toBe(BEFORE + TYPED);
    sentOnceSealed(server);
    expect(await withDetachedDoc(NOTE, textOf)).toBe(BEFORE + TYPED);
    await storedSealed();
  });

  test("in a note open here: likewise, and stored, not only in the open document", async () => {
    await typeOffline({ keepOpen: true });
    const server = await lockElsewhere();
    const engine = await startEngine(server.client);
    await resent(engine, server);

    expect(await server.onServer()).toBe(BEFORE + TYPED);
    sentOnceSealed(server);
    expect(textOf(openDoc(NOTE)!)).toBe(BEFORE + TYPED);
    // And there once the note is closed.
    await releaseDoc(NOTE);
    opened.splice(0);
    expect(await withDetachedDoc(NOTE, textOf)).toBe(BEFORE + TYPED);
    await storedSealed();
  });

  test("with the vault closed: kept here, and sent sealed once it opens", async () => {
    await typeOffline({ keepOpen: false });
    const server = await lockElsewhere();
    vault.lock();
    const engine = await startEngine(server.client);
    await refused(engine, server);
    // Nothing could be sealed: nothing went, in plaintext or otherwise.
    expect(server.accepted).toHaveLength(0);
    expect(await keptUnderOldKey()).toBe(2);

    // Opening the vault is enough: the engine sends them without being asked.
    await unlockWithPassword(record, PASSWORD);
    expect(await withDetachedDoc(NOTE, textOf)).toBe(BEFORE + TYPED);
    await resent(engine, server);

    expect(await server.onServer()).toBe(BEFORE + TYPED);
    sentOnceSealed(server);
    expect(await withDetachedDoc(NOTE, textOf)).toBe(BEFORE + TYPED);
    await storedSealed();
  });

  test("before this device has heard of the lock: kept, and sent sealed once it has", async () => {
    await typeOffline({ keepOpen: false });
    const server = await lockElsewhere({ heard: false });
    const engine = await startEngine(server.client);
    await refused(engine, server);
    // Not sent again under the epoch the server has just refused.
    expect(server.refused).toHaveLength(2);
    expect(server.accepted).toHaveLength(0);
    expect(await keptUnderOldKey()).toBe(2);

    await hearOfLock(server.wrapped);
    // The next push, here at once rather than at the next round.
    engine.kick(0);
    await resent(engine, server);

    expect(await server.onServer()).toBe(BEFORE + TYPED);
    sentOnceSealed(server);
    expect(await withDetachedDoc(NOTE, textOf)).toBe(BEFORE + TYPED);
    await storedSealed();
  });
});
