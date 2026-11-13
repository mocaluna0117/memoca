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

test("a round with nothing to send goes back to the slow pace, after one sent while another device was at work", async () => {
  await db().outbox.put({
    opId: "a",
    kind: "note",
    entityId: "n-a",
    payload: { kind: "note", opId: "a", noteId: "n-a" },
    createdAt: 0,
    attempts: 0,
  });
  const fake = fakeConvex({
    "sync:push": (args) => ({
      serverTime: Date.now(),
      // Another device sent within the last minutes.
      activePeers: 1,
      shouldCompact: [],
      results: (args.ops as { opId: string }[]).map((op) => ({ opId: op.opId, status: "ok" })),
    }),
  });
  const client = {
    ...fake.client,
    watchQuery: () => ({ localQueryResult: () => null, onUpdate: () => () => {} }),
  } as unknown as ConvexReactClient;
  engine = new SyncEngine(client);
  await engine.start("me");
  await vi.waitFor(() => expect(fake.callsTo("sync:push")).toHaveLength(1), WAIT);
  await vi.waitFor(async () => expect(await db().outbox.count()).toBe(0), WAIT);

  // The rounds from here have nothing to send. They were run every second
  // for as long as the window was open (a round sends, it does not
  // receive): only the next thing sent set the pace again.
  const rounds = vi.spyOn(db().outbox, "orderBy");
  await new Promise((resolve) => setTimeout(resolve, 4_500));
  expect(rounds.mock.calls.length).toBeLessThanOrEqual(2);
}, 20_000);
