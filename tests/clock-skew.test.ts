import "fake-indexeddb/auto";
import type { ConvexReactClient } from "convex/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { db, resetLocalData, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import "@/lib/media/attachments";
import "@/lib/media/report-refs";
import "@/lib/sync/mutations";
import { loadClock, stamp, syncClock } from "@/lib/sync/clock";
import { SyncEngine } from "@/lib/sync/engine";
import { enqueue } from "@/lib/sync/outbox";
import type { Note, Stamp } from "@/lib/types";
import { fakeConvex } from "./helpers/fake-convex";
import { zero } from "./helpers/seed";

const WAIT = { timeout: 15_000 };
/** How far ahead this device's clock has been running. */
const AHEAD_MS = 10 * 60_000;
let engine: SyncEngine | null = null;

beforeEach(async () => {
  await resetLocalData();
  await setMeta(META.pinPlacesPulled, true);
});

afterEach(() => {
  engine?.stop();
  engine = null;
  vi.restoreAllMocks();
});

const note = (ts: Stamp): Note => ({
  noteId: "n1",
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
  lastUpdateSeq: 0,
  snapshotSeq: 0,
  ts: { title: ts, preview: zero, place: ts, pin: zero, trash: zero, lock: zero },
  seq: 0,
  updatedAt: 0,
});

/**
 * A server whose clock is right, which this device's is well ahead of: a
 * stamp from more than a minute ahead of it is refused, as the real one
 * refuses it, and an edit to a note it has not been given is too.
 */
function server() {
  const created = new Set<string>();
  const accepted: Record<string, { title: Stamp; place: Stamp }> = {};
  const fake = fakeConvex({
    "sync:push": (args) => {
      const serverTime = Date.now() - AHEAD_MS;
      const ops = args.ops as Record<string, { ts?: Stamp } | string | undefined>[];
      return {
        serverTime,
        activePeers: 0,
        shouldCompact: [],
        results: ops.map((op) => {
          const opId = op.opId as string;
          const stamps = ["title", "preview", "place", "pin", "pinPlace", "trash"]
            .map((group) => (op[group] as { ts?: Stamp } | undefined)?.ts)
            .filter((ts): ts is Stamp => ts !== undefined);
          if (stamps.some((ts) => ts.t > serverTime + 60_000)) {
            return { opId, status: "rejected", reason: "clockSkew" };
          }
          if (op.kind === "note" && op.create) {
            created.add(op.noteId as string);
            accepted[opId] = {
              title: (op.title as { ts: Stamp }).ts,
              place: (op.place as { ts: Stamp }).ts,
            };
          }
          if (op.kind === "update" && !created.has(op.noteId as string)) {
            return { opId, status: "rejected", reason: "unknownNote" };
          }
          return { opId, status: "ok" };
        }),
      };
    },
  });
  const client = {
    ...fake.client,
    watchQuery: () => ({ localQueryResult: () => null, onUpdate: () => () => {} }),
  };
  return { fake, client: client as unknown as ConvexReactClient, created, accepted };
}

test("a device whose clock ran ahead has its new note taken all the same, with its text", { timeout: 30_000 }, async () => {
  // Stamped while the clock was ahead: the note made, and an edit to it.
  await setMeta(META.lastHlc, Date.now() + AHEAD_MS);
  await setMeta(META.clockOffset, 0);
  const ts: Stamp = { t: Date.now() + AHEAD_MS, d: "dev" };
  await db().notes.put(note(ts));
  await enqueue({
    opId: "make",
    kind: "note",
    entityId: "n1",
    payload: {
      kind: "note",
      noteId: "n1",
      create: { noteKind: "note", folderId: null, sortKey: "a" },
      title: { value: "メモ", preview: null, ts },
      place: { folderId: null, sortKey: "a", ts },
    },
  });
  await db().updates.add({
    noteId: "n1",
    seq: null,
    opId: "typed",
    keyEpoch: 0,
    data: new Uint8Array([1, 2, 3]),
    pushed: 0,
    createdAt: Date.now(),
  });
  await enqueue({
    opId: "typed",
    kind: "update",
    entityId: "n1",
    payload: { kind: "update", noteId: "n1", keyEpoch: 0, payload: new ArrayBuffer(3) },
  });

  const { client, created, accepted } = server();
  engine = new SyncEngine(client);
  await engine.start("me");

  // Both go through: the note stamped again by the corrected clock, then its text.
  await vi.waitFor(async () => expect(await db().outbox.count()).toBe(0), WAIT);
  expect(created.has("n1")).toBe(true);
  const row = (await db().notes.get("n1"))!;
  expect(row.ts.title.t).toBeLessThan(Date.now() - AHEAD_MS + 60_000);
  expect(row.ts.title).toEqual(accepted.make!.title);
  expect(row.ts.place).toEqual(accepted.make!.place);
  // The text is still here, and was sent.
  expect(await db().updates.where("opId").equals("typed").count()).toBe(1);
  expect(engine.current.stuck).toBe(0);
});

test("the corrected clock stamps from now on, not from where the fast one left off", async () => {
  await setMeta(META.lastHlc, Date.now() + AHEAD_MS);
  await setMeta(META.clockOffset, 0);
  await loadClock();
  syncClock(Date.now() - AHEAD_MS);
  const next = stamp("dev");
  // Within what the server allows of the corrected time.
  expect(next.t).toBeLessThan(Date.now() - AHEAD_MS + 60_000);
  expect(next.t).toBeGreaterThan(Date.now() - AHEAD_MS - 1_000);
  // And still never backwards.
  expect(stamp("dev").t).toBeGreaterThan(next.t);
});
