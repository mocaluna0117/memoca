import "fake-indexeddb/auto";
import type { ConvexReactClient } from "convex/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { db, resetLocalData, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import "@/lib/media/attachments";
import "@/lib/media/report-refs";
import "@/lib/sync/mutations";
import { SyncEngine } from "@/lib/sync/engine";
import type { Note } from "@/lib/types";
import { fakeConvex } from "./helpers/fake-convex";
import { zero } from "./helpers/seed";

let engine: SyncEngine | null = null;

beforeEach(async () => {
  await resetLocalData();
  await setMeta(META.pinPlacesPulled, true);
});

afterEach(() => {
  engine?.stop();
  engine = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A note whose every edit the server has, its body here as far as the server's. */
async function longNote(chars: number) {
  const doc = new Y.Doc();
  doc.getText("t").insert(0, "a".repeat(chars));
  const update = Y.encodeStateAsUpdate(doc);
  await db().notes.put({
    noteId: "n1",
    folderId: null,
    kind: "note",
    title: "長い",
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
  } as Note);
  await db().updates.add({ noteId: "n1", seq: 1, opId: "u1", keyEpoch: 0, data: update, pushed: 1, createdAt: 0 });
  await db().bodies.put({ noteId: "n1", throughSeq: 1, keyEpoch: 0, text: "", updatedAt: 0 });
}

function start() {
  const fake = fakeConvex({
    "notes:compact": () => ({ status: "ok" }),
    "notes:snapshotUploadUrl": () => "https://upload.test/snapshot",
  });
  const client = {
    ...fake.client,
    watchQuery: () => ({ localQueryResult: () => null, onUpdate: () => () => {} }),
  };
  engine = new SyncEngine(client as unknown as ConvexReactClient);
  return fake;
}

test("a note past what one row holds is compacted by a file uploaded, not refused for its size", async () => {
  await longNote(1_000_000);
  const fake = start();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ storageId: "snap-1" }))));
  expect(await engine!.compact("n1")).toBe(true);
  const [call] = fake.callsTo("notes:compact");
  expect(call!.args.storageId).toBe("snap-1");
  expect(call!.args.payload).toBeUndefined();
  expect(call!.args.size).toBeGreaterThan(900_000);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("a short one goes inline, as before", async () => {
  await longNote(100);
  const fake = start();
  expect(await engine!.compact("n1")).toBe(true);
  const [call] = fake.callsTo("notes:compact");
  expect(call!.args.storageId).toBeUndefined();
  expect(call!.args.payload).toBeInstanceOf(ArrayBuffer);
});

test("asked twice at once, a note is compacted once; refused, not again for a while", async () => {
  await longNote(100);
  const fake = start();
  fake.handlers["notes:compact"] = () => ({ status: "rejected", reason: "behind" });
  const [first, second] = await Promise.all([engine!.compact("n1"), engine!.compact("n1")]);
  expect([first, second]).toEqual([false, false]);
  expect(fake.callsTo("notes:compact")).toHaveLength(1);
  expect(await engine!.compact("n1")).toBe(false);
  expect(fake.callsTo("notes:compact")).toHaveLength(1);
});
