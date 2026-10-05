import "fake-indexeddb/auto";
import type { ConvexReactClient } from "convex/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { db, resetLocalData } from "@/lib/db";
// Loaded by the sync engine only when it gets round to them, which can be
// after a test is over: loaded here, before any test, instead.
import "@/lib/media/attachments";
import "@/lib/media/report-refs";
import "@/lib/sync/mutations";
import { SyncEngine } from "@/lib/sync/engine";
import { enqueue } from "@/lib/sync/outbox";
import type { Note } from "@/lib/types";
import { fakeConvex } from "./helpers/fake-convex";
import { zero } from "./helpers/seed";

const note = (): Note => ({
  noteId: "n1",
  folderId: null,
  kind: "note",
  title: "メモ",
  preview: "メモ",
  pinned: false,
  sortKey: "a",
  locked: false,
  keyEpoch: 0,
  deletedAt: null,
  purged: false,
  lastUpdateSeq: 0,
  snapshotSeq: 0,
  ts: { title: zero, preview: zero, place: zero, pin: zero, trash: zero, lock: zero },
  seq: 1,
  updatedAt: 0,
});

/** An edit to the note's text, written here and waiting to be sent. */
async function edit(opId: string): Promise<void> {
  await db().updates.add({
    noteId: "n1",
    seq: null,
    opId,
    keyEpoch: 0,
    data: new Uint8Array([1, 2, 3]),
    pushed: 0,
    createdAt: Date.now(),
  });
  await enqueue({
    opId,
    kind: "update",
    entityId: "n1",
    payload: { kind: "update", noteId: "n1", keyEpoch: 0, payload: new ArrayBuffer(3) },
  });
}

/** The engine works in the background, which a busy machine slows. */
const WAIT = { timeout: 10_000 };

const engines: SyncEngine[] = [];

/** A device syncing with a server that is full, until `room` says otherwise. */
async function sync(room: { full: boolean }) {
  const server = fakeConvex({
    "sync:push": (args) => ({
      serverTime: Date.now(),
      activePeers: 0,
      shouldCompact: [],
      results: (args.ops as { opId: string }[]).map((op) =>
        room.full
          ? { opId: op.opId, status: "rejected", reason: "quotaExceeded" }
          : { opId: op.opId, status: "ok" },
      ),
    }),
  });
  const client = {
    ...server.client,
    watchQuery: () => ({ localQueryResult: () => null, onUpdate: () => () => {} }),
  };
  const engine = new SyncEngine(client as unknown as ConvexReactClient);
  engines.push(engine);
  await engine.start("me");
  return { engine, pushes: () => server.callsTo("sync:push") };
}

beforeEach(async () => {
  await resetLocalData();
  await db().notes.put(note());
});

afterEach(() => {
  vi.useRealTimers();
  for (const engine of engines.splice(0)) engine.stop();
});

describe("an edit refused because the account is full", () => {
  test("is kept on this device, and the device says it is not saved", async () => {
    await edit("e1");
    const { engine, pushes } = await sync({ full: true });

    await vi.waitFor(() => expect(engine.current.quotaFull).toBe(true), WAIT);
    expect(pushes()).toHaveLength(1);
    expect(await db().updates.where("opId").equals("e1").count()).toBe(1);
    expect(await db().outbox.get("e1")).toBeDefined();
  });

  test("is not sent again at once, and does not hold up what comes after it", async () => {
    await edit("e1");
    const room = { full: true };
    const { engine, pushes } = await sync(room);
    await vi.waitFor(() => expect(engine.current.quotaFull).toBe(true), WAIT);

    await enqueue({
      opId: "t1",
      kind: "note",
      entityId: "n1",
      payload: { kind: "note", noteId: "n1", title: { value: "新しい題", ts: zero } },
    });
    room.full = false;
    engine.kick(0);
    await vi.waitFor(() => expect(pushes()).toHaveLength(2), WAIT);

    const sent = (pushes()[1]!.args.ops as { opId: string }[]).map((op) => op.opId);
    expect(sent).toEqual(["t1"]);
    expect(await db().outbox.get("e1")).toBeDefined();
  });

  test("is sent again later, and once there is room the device says all is saved", async () => {
    await edit("e1");
    const room = { full: true };
    const { engine } = await sync(room);
    await vi.waitFor(() => expect(engine.current.quotaFull).toBe(true), WAIT);

    room.full = false;
    await db().outbox.update("e1", { retryAt: Date.now() - 1 });
    engine.kick(0);

    await vi.waitFor(() => expect(engine.current.quotaFull).toBe(false), WAIT);
    expect(await db().outbox.count()).toBe(0);
  });
});
