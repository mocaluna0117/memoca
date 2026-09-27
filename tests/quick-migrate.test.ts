import "fake-indexeddb/auto";
import { blocksToYDoc, yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import type { ConvexReactClient } from "convex/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { toArrayBuffer } from "@/lib/bytes";
import { ctx } from "@/lib/crypto/context";
import { seal } from "@/lib/crypto/primitives";
import { prepareVault, vault } from "@/lib/crypto/vault";
import { db, resetLocalData } from "@/lib/db";
// Loaded by the sync engine only when it gets round to them, which can be
// after a test is over: loaded here, before any test, instead.
import "@/lib/media/attachments";
import { migrateOldQuickBody } from "@/lib/quick/body";
import "@/lib/search/yomi";
import type { PullBatch } from "@/lib/sync/apply";
import { acquireDoc, flushAll, releaseDoc, reloadDoc } from "@/lib/sync/docs";
import { SyncEngine } from "@/lib/sync/engine";
import "@/lib/sync/mutations";
import { FRAGMENT, bodyFragment } from "@/lib/sync/ydoc";
import type { Note } from "@/lib/types";
import { editor, shape, valid } from "./helpers/blocknote";
import { fakeConvex } from "./helpers/fake-convex";
import { FAST_ARGON, zero } from "./helpers/seed";

const LINES = ["一行目", "", "三行目"];

const note = (): Note => ({
  noteId: "q1",
  folderId: null,
  kind: "quick",
  title: "一行目",
  preview: "一行目",
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

/** A body as quick notes wrote it before d92c5e1: a bare paragraph per line, straight in the body. */
function oldBody(lines: string[]): Y.Doc {
  const doc = new Y.Doc();
  const fragment = bodyFragment(doc);
  doc.transact(() => {
    for (const line of lines) {
      const paragraph = new Y.XmlElement("paragraph");
      const content = new Y.XmlText();
      if (line.length > 0) content.insert(0, line);
      paragraph.insert(0, [content]);
      fragment.push([paragraph]);
    }
  });
  return doc;
}

/** The same lines as BlockNote itself writes them. */
const blockNoteBody = (lines: string[]) =>
  blocksToYDoc(
    editor,
    lines.map((line) => ({ type: "paragraph" as const, content: line })),
    FRAGMENT,
  );

type Kept = { patch?: Partial<Note>; iv?: Uint8Array; keyEpoch?: number };

/**
 * Keeps the note as a device does once it has synced it: its body as one
 * update the server has, and nothing newer known of unless `patch` says so.
 */
async function keep(data: Uint8Array, { patch = {}, iv, keyEpoch = 0 }: Kept = {}): Promise<void> {
  await db().notes.put({ ...note(), keyEpoch, ...patch });
  await db().updates.add({
    noteId: "q1",
    seq: 1,
    opId: "q1-1",
    keyEpoch,
    data,
    iv,
    pushed: 1,
    createdAt: 0,
  });
  await db().bodies.put({ noteId: "q1", throughSeq: 1, keyEpoch, text: null, updatedAt: 0 });
}

/** How often the test has the note open: let go after it, however far it got. */
let opened = 0;

/** Opens the note as the editor does. */
function open(): Promise<Y.Doc> {
  opened += 1;
  return acquireDoc("q1");
}

async function close(): Promise<void> {
  opened -= 1;
  await releaseDoc("q1");
}

const rows = () => db().updates.where("noteId").equals("q1").toArray();

/** The text of each block, in order. */
const texts = (doc: Y.Doc) =>
  yXmlFragmentToBlocks(editor, bodyFragment(doc)).map((block) =>
    (block.content as { text: string }[]).map((run) => run.text).join(""),
  );

/** Another device's copy of the old body, and its rewrite of it as an update of its own. */
function rewrittenElsewhere() {
  const theirs = oldBody(LINES);
  const body = Y.encodeStateAsUpdate(theirs);
  const before = Y.encodeStateVector(theirs);
  migrateOldQuickBody(theirs);
  return { body, rewrite: Y.encodeStateAsUpdate(theirs, before) };
}

/** An update of the note as the server sends it. */
const remote = (
  seq: number,
  data: Uint8Array,
  { keyEpoch = 0, iv }: { keyEpoch?: number; iv?: Uint8Array } = {},
) => ({
  noteId: "q1",
  opId: `q1-${seq}`,
  deviceId: "elsewhere",
  keyEpoch,
  payload: toArrayBuffer(data),
  iv: iv ? toArrayBuffer(iv) : undefined,
  seq,
});

/** The note's body as the server hands it to a device that asks for it. */
const fetched = (updates: ReturnType<typeof remote>[], lastUpdateSeq = 1) => ({
  noteId: "q1",
  keyEpoch: 0,
  lastUpdateSeq,
  snapshot: null,
  updates,
});

/** Sync engines a test started, stopped after it. */
const engines: SyncEngine[] = [];

/**
 * Syncs against a stand-in for the server: `pull` are the updates its
 * subscription delivers, once, and `bodies` what fetching bodies gets.
 */
async function sync({
  pull,
  bodies = [],
}: {
  pull?: ReturnType<typeof remote>[];
  bodies?: ReturnType<typeof fetched>[];
}): Promise<SyncEngine> {
  const server = fakeConvex({ "notes:getBodies": () => ({ bodies, truncated: false }) });
  let batch: PullBatch | null = pull
    ? {
        headSeq: pull.length,
        cursor: pull.length,
        complete: true,
        serverTime: Date.now(),
        folders: [],
        notes: [],
        updates: pull,
        snapshots: [],
        attachments: [],
      }
    : null;
  const client = {
    ...server.client,
    watchQuery: () => ({
      localQueryResult: () => {
        const once = batch;
        batch = null;
        return once;
      },
      onUpdate: () => () => {},
    }),
  };
  const engine = new SyncEngine(client as unknown as ConvexReactClient);
  engines.push(engine);
  await engine.start("me");
  return engine;
}

/** Waits for the engine to have taken in what its subscription delivered. */
const received = (engine: SyncEngine) =>
  vi.waitFor(() => expect(engine.current.lastSyncAt).not.toBeNull());

beforeEach(async () => {
  await resetLocalData();
});

afterEach(async () => {
  for (const engine of engines.splice(0)) engine.stop();
  while (opened > 0) await close();
  vault.lock();
});

describe("opening a quick note written before its body was shaped as BlockNote's", () => {
  test("rewrites it before the editor has it, exactly as BlockNote writes those lines, ids apart", async () => {
    await keep(Y.encodeStateAsUpdate(oldBody(LINES)));
    const doc = await open();

    expect(shape(bodyFragment(doc))).toBe(shape(bodyFragment(blockNoteBody(LINES))));
    expect(valid(doc)).toBe(true);
    expect(texts(doc)).toEqual(LINES);
  });

  test("saves the rewrite as an edit, to be sent like one", async () => {
    await keep(Y.encodeStateAsUpdate(oldBody(LINES)));
    await open();
    await flushAll();

    const edit = (await rows()).find((row) => row.pushed === 0);
    expect(edit).toMatchObject({ seq: null });
    const sending = await db().outbox.where("kind").equals("update").toArray();
    expect(sending).toEqual([expect.objectContaining({ entityId: "q1", opId: edit!.opId })]);
    await close();
    // Built again from storage alone, it is in the new shape.
    const again = await open();
    expect(texts(again)).toEqual(LINES);
    expect(valid(again)).toBe(true);
  });

  test("does it once: read back, or opened again, the note is left as it is", async () => {
    await keep(Y.encodeStateAsUpdate(oldBody(LINES)));
    const doc = await open();
    // Read back from storage before the rewrite is saved: still one body.
    await reloadDoc("q1");
    expect(shape(bodyFragment(doc))).toBe(shape(bodyFragment(blockNoteBody(LINES))));
    await close();
    expect(await rows()).toHaveLength(2);

    await open();
    await flushAll();
    expect(await rows()).toHaveLength(2);
  });

  test("rewrites a locked note the same way, and saves the rewrite encrypted", async () => {
    (await prepareVault("パスワード", FAST_ARGON)).adopt();
    const { key, wrapped } = await vault.createNoteKey("q1", 1);
    const sealed = await seal(key, Y.encodeStateAsUpdate(oldBody(LINES)), ctx.yjsUpdate("q1", 1));
    await keep(sealed.ct, {
      iv: sealed.iv,
      keyEpoch: 1,
      patch: { locked: true, wrappedKey: wrapped, title: null, preview: null },
    });
    const doc = await open();

    expect(shape(bodyFragment(doc))).toBe(shape(bodyFragment(blockNoteBody(LINES))));
    await flushAll();
    const edit = (await rows()).find((row) => row.pushed === 0);
    expect(edit?.iv, "a locked note's edits are only ever stored encrypted").toBeDefined();
  });

  test.each([
    ["an update the server has", async () => ({ lastUpdateSeq: 2 })],
    [
      "the body a lock elsewhere replaced it with",
      async () => {
        (await prepareVault("パスワード", FAST_ARGON)).adopt();
        const { wrapped } = await vault.createNoteKey("q1", 1);
        return { locked: true, keyEpoch: 1, wrappedKey: wrapped };
      },
    ],
  ])(
    "leaves it alone while this device knows it lacks %s, which may hold the same rewrite",
    async (_, lacking) => {
      await keep(Y.encodeStateAsUpdate(oldBody(LINES)), { patch: await lacking() });
      const doc = await open();
      await flushAll();

      expect(shape(bodyFragment(doc))).toBe(shape(bodyFragment(oldBody(LINES))));
      expect(await rows()).toHaveLength(1);
    },
  );
});

describe("an old quick note's body that reaches this device after the note was opened", () => {
  // The note is here, and open, before its body: a device new to the
  // account, or one still fetching bodies.
  const openFirst = async (patch: Partial<Note> = {}) => {
    await db().notes.put({ ...note(), ...patch });
    const doc = await open();
    expect(bodyFragment(doc).length).toBe(0);
    return doc;
  };

  test("coming in with the updates, is rewritten once they are all in, and saved", async () => {
    const doc = await openFirst();
    const engine = await sync({ pull: [remote(1, Y.encodeStateAsUpdate(oldBody(LINES)))] });
    await received(engine);

    expect(shape(bodyFragment(doc))).toBe(shape(bodyFragment(blockNoteBody(LINES))));
    expect(valid(doc)).toBe(true);
    await flushAll();
    expect((await rows()).filter((row) => row.pushed === 0)).toHaveLength(1);
  });

  test("fetched, is rewritten once it is counted as up to date", async () => {
    const doc = await openFirst();
    const engine = await sync({
      bodies: [fetched([remote(1, Y.encodeStateAsUpdate(oldBody(LINES)))])],
    });
    await engine.fetchBodies(["q1"]);

    expect(shape(bodyFragment(doc))).toBe(shape(bodyFragment(blockNoteBody(LINES))));
    expect(texts(doc)).toEqual(LINES);
  });

  test("is left alone while this device knows more of it is still to come", async () => {
    const doc = await openFirst({ lastUpdateSeq: 2 });
    const engine = await sync({
      bodies: [fetched([remote(1, Y.encodeStateAsUpdate(oldBody(LINES)))], 2)],
    });
    await engine.fetchBodies(["q1"]);

    expect(shape(bodyFragment(doc))).toBe(shape(bodyFragment(oldBody(LINES))));
  });

  test("coming in with another device's rewrite of it, is not rewritten a second time", async () => {
    const { body, rewrite } = rewrittenElsewhere();
    const doc = await openFirst({ lastUpdateSeq: 2 });
    const engine = await sync({ pull: [remote(1, body), remote(2, rewrite)] });
    await received(engine);

    // One body, that device's: nothing of this one's to save.
    expect(shape(bodyFragment(doc))).toBe(shape(bodyFragment(blockNoteBody(LINES))));
    await flushAll();
    expect((await rows()).filter((row) => row.pushed === 0)).toHaveLength(0);
  });

  test("fetched again before this device's rewrite of it is saved, is not rewritten again", async () => {
    const body = Y.encodeStateAsUpdate(oldBody(LINES));
    await keep(body);
    // Rewritten as it opens; read back from storage below before that is saved.
    const doc = await open();
    const engine = await sync({ bodies: [fetched([remote(1, body)])] });
    await engine.fetchBodies(["q1"]);

    expect(shape(bodyFragment(doc))).toBe(shape(bodyFragment(blockNoteBody(LINES))));
    await close();
    expect(await rows()).toHaveLength(2);
  });

  test("is left alone in a locked note while the vault is closed: what came could not be read", async () => {
    (await prepareVault("パスワード", FAST_ARGON)).adopt();
    const { key, wrapped } = await vault.createNoteKey("q1", 1);
    const { body, rewrite } = rewrittenElsewhere();
    const first = await seal(key, body, ctx.yjsUpdate("q1", 1));
    const second = await seal(key, rewrite, ctx.yjsUpdate("q1", 1));
    await keep(first.ct, {
      iv: first.iv,
      keyEpoch: 1,
      patch: { locked: true, wrappedKey: wrapped, title: null, preview: null, lastUpdateSeq: 2 },
    });
    // Read with the vault open, and left alone: this device knows it lacks an update.
    const doc = await open();
    vault.lock();
    // That update, another device's rewrite, arrives while nothing here can read it.
    const engine = await sync({ pull: [remote(2, second.ct, { keyEpoch: 1, iv: second.iv })] });
    await received(engine);

    expect(shape(bodyFragment(doc))).toBe(shape(bodyFragment(oldBody(LINES))));
  });
});

describe("opening any other note", () => {
  test.each([
    ["in BlockNote's shape", () => blockNoteBody(LINES)],
    ["that is empty", () => new Y.Doc()],
  ])("leaves a body %s as it is, with nothing to save", async (_, body) => {
    const before = body();
    await keep(Y.encodeStateAsUpdate(before));
    const doc = await open();
    await flushAll();

    expect(shape(bodyFragment(doc))).toBe(shape(bodyFragment(before)));
    expect(await rows()).toHaveLength(1);
    expect(await db().outbox.count()).toBe(0);
  });
});
