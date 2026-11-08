import "fake-indexeddb/auto";
import type { ConvexReactClient } from "convex/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { db, resetLocalData, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import "@/lib/media/attachments";
import "@/lib/media/report-refs";
import "@/lib/sync/mutations";
import { SyncEngine } from "@/lib/sync/engine";
import { fakeConvex } from "./helpers/fake-convex";

/** The engine works in the background, which a busy machine slows. */
const WAIT = { timeout: 10_000 };
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

/** A server that cannot take the op `bad` at all: the whole push fails, as an argument it refuses does. */
function server() {
  const fake = fakeConvex({
    "sync:push": (args) => {
      const ops = args.ops as { opId: string }[];
      if (ops.some((op) => op.opId === "bad")) {
        throw new Error("ArgumentValidationError: Value does not match validator.");
      }
      return {
        serverTime: Date.now(),
        activePeers: 0,
        shouldCompact: [],
        results: ops.map((op) => ({ opId: op.opId, status: "ok" })),
      };
    },
  });
  const client = {
    ...fake.client,
    watchQuery: () => ({ localQueryResult: () => null, onUpdate: () => () => {} }),
  };
  return { fake, client: client as unknown as ConvexReactClient };
}

const queue = (opId: string, createdAt: number) =>
  db().outbox.put({
    opId,
    kind: "note",
    entityId: `n-${opId}`,
    payload: { kind: "note", opId, noteId: `n-${opId}` },
    createdAt,
    attempts: 0,
  });

/** Each push's ops, in order. */
const pushes = (fake: ReturnType<typeof server>["fake"]) =>
  fake.callsTo("sync:push").map((call) => (call.args.ops as { opId: string }[]).map((op) => op.opId));

test("one edit the server cannot take does not hold the others back, and is set aside after three tries", async () => {
  await queue("bad", 0);
  await queue("good", 1);
  const { fake, client } = server();
  engine = new SyncEngine(client);
  await engine.start("me");

  // The good one goes in a push of its own, in the same round.
  await vi.waitFor(async () => expect(await db().outbox.get("good")).toBeUndefined(), WAIT);
  expect(pushes(fake)).toContainEqual(["good"]);
  await vi.waitFor(async () => expect((await db().outbox.get("bad"))?.attempts).toBe(1), WAIT);

  // Tried alone with each round: then set aside, and said so.
  for (let round = 0; round < 2; round += 1) {
    engine.kick(0);
    await vi.waitFor(
      async () => expect((await db().outbox.get("bad"))?.attempts).toBe(round + 2),
      WAIT,
    );
  }
  const bad = await db().outbox.get("bad");
  expect(bad?.stuck).toBeTypeOf("number");
  await vi.waitFor(() => expect(engine!.current.stuck).toBe(1), WAIT);
  expect(engine.current.pending).toBe(0);
  expect(engine.current.state).toBe("idle");

  // Set aside, it is not tried with the next round.
  const tried = fake.callsTo("sync:push").length;
  engine.kick(0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(fake.callsTo("sync:push").length).toBe(tried);

  // Asked to, it is tried again from the start.
  await engine.retryStuck();
  await vi.waitFor(async () => {
    const row = await db().outbox.get("bad");
    expect(row?.stuck).toBeUndefined();
    expect(row?.attempts).toBe(1);
  }, WAIT);
  expect(fake.callsTo("sync:push").length).toBeGreaterThan(tried);
});

test("one too big to send does not stop the one after it", async () => {
  // Over what the server stores in one row: the push throws for it alone.
  const fake = fakeConvex({
    "sync:push": (args) => {
      const ops = args.ops as { opId: string; payload?: ArrayBuffer }[];
      if (ops.some((op) => (op.payload?.byteLength ?? 0) > 1_000_000)) {
        throw new Error("Value is too large");
      }
      return {
        serverTime: Date.now(),
        activePeers: 0,
        shouldCompact: [],
        results: ops.map((op) => ({ opId: op.opId, status: "ok" })),
      };
    },
  });
  const client = {
    ...fake.client,
    watchQuery: () => ({ localQueryResult: () => null, onUpdate: () => () => {} }),
  };
  await db().outbox.put({
    opId: "huge",
    kind: "update",
    entityId: "n1",
    payload: { kind: "update", opId: "huge", noteId: "n1", keyEpoch: 0, payload: new ArrayBuffer(1_100_000) },
    createdAt: 0,
    attempts: 0,
  });
  await queue("after", 1);
  engine = new SyncEngine(client as unknown as ConvexReactClient);
  await engine.start("me");
  await vi.waitFor(async () => expect(await db().outbox.get("after")).toBeUndefined(), WAIT);
  expect(await db().outbox.get("huge")).toBeDefined();
});
