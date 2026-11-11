import "fake-indexeddb/auto";
import type { ConvexReactClient } from "convex/react";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { db, resetLocalData, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import "@/lib/media/attachments";
import "@/lib/media/report-refs";
import "@/lib/sync/mutations";
import { SIGN_IN_LOST, SyncEngine } from "@/lib/sync/engine";
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

/** A server that takes every op while this device is signed in, and refuses every push, as Convex does, while it is not. */
function server() {
  const state = { signedIn: false };
  const fake = fakeConvex({
    "sync:push": (args) => {
      if (!state.signedIn) throw new ConvexError({ code: "UNAUTHENTICATED", message: "サインインが必要です。" });
      const ops = args.ops as { opId: string }[];
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
  return { fake, state, client: client as unknown as ConvexReactClient };
}

const queue = (opId: string, createdAt: number, more: Record<string, unknown> = {}) =>
  db().outbox.put({
    opId,
    kind: "note",
    entityId: `n-${opId}`,
    payload: { kind: "note", opId, noteId: `n-${opId}` },
    createdAt,
    attempts: 0,
    ...more,
  });

test("edits refused for want of sign-in are not counted against, nor set aside: they wait, and go once signed in again", async () => {
  await queue("a", 0);
  await queue("b", 1);
  const { fake, state, client } = server();
  const asked = vi.fn();
  window.addEventListener(SIGN_IN_LOST, asked);
  try {
    engine = new SyncEngine(client);
    await engine.start("me");
    await vi.waitFor(() => expect(fake.callsTo("sync:push").length).toBeGreaterThan(0), WAIT);
    await vi.waitFor(() => expect(engine!.current.signInWait).toBe(true), WAIT);
    // The sign-in asked for again, by this window too (a hidden one does not by itself).
    expect(asked).toHaveBeenCalled();
    // Kicked again and again, as edits come: still waiting, none set aside.
    for (let i = 0; i < 4; i += 1) {
      engine.kick(0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const rows = await db().outbox.toArray();
    expect(rows.map((row) => [row.opId, row.attempts, row.stuck])).toEqual([
      ["a", 0, undefined],
      ["b", 0, undefined],
    ]);
    // Not sent again and again while the sign-in is away: once a wait.
    expect(fake.callsTo("sync:push").length).toBeLessThanOrEqual(2);

    state.signedIn = true;
    engine.kick(0);
    await vi.waitFor(async () => expect(await db().outbox.count()).toBe(0), { timeout: 20_000 });
    await vi.waitFor(() => expect(engine!.current.signInWait).toBe(false), WAIT);
  } finally {
    window.removeEventListener(SIGN_IN_LOST, asked);
  }
}, 30_000);

test("edits set aside before for want of sign-in are sent again as the engine starts", async () => {
  await queue("old", 0, {
    attempts: 3,
    stuck: 1,
    lastError: '[CONVEX M(sync:push)] Uncaught ConvexError: {"code":"UNAUTHENTICATED","message":"サインインが必要です。"}',
  });
  await queue("refused", 1, { attempts: 3, stuck: 1, lastError: "ArgumentValidationError" });
  const { state, client } = server();
  state.signedIn = true;
  engine = new SyncEngine(client);
  await engine.start("me");
  await vi.waitFor(async () => expect(await db().outbox.get("old")).toBeUndefined(), WAIT);
  // One the server itself would not take stays aside, as before.
  expect((await db().outbox.get("refused"))?.stuck).toBe(1);
}, 20_000);
