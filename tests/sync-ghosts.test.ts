import "fake-indexeddb/auto";
import type { ConvexReactClient } from "convex/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { db, getMeta, resetLocalData, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
// Loaded by the sync engine only when it gets round to them, which can be
// after a test is over: loaded here, before any test, instead.
import "@/lib/media/attachments";
import "@/lib/media/report-refs";
import "@/lib/search/yomi";
import type { PullBatch } from "@/lib/sync/apply";
import { SyncEngine } from "@/lib/sync/engine";
import "@/lib/sync/mutations";
import { enqueue } from "@/lib/sync/outbox";
import type { Folder, Note } from "@/lib/types";
import { fakeConvex } from "./helpers/fake-convex";
import { zero } from "./helpers/seed";

const folder = (folderId: string, seq: number): Folder => ({
  folderId,
  parentId: null,
  name: folderId,
  icon: null,
  sortKey: "a",
  locked: false,
  system: null,
  deletedAt: 1,
  purged: false,
  ts: { name: zero, place: zero, trash: zero, lock: zero },
  seq,
});

const note = (noteId: string, seq: number): Note => ({
  noteId,
  folderId: null,
  kind: "note",
  title: noteId,
  preview: null,
  pinned: false,
  sortKey: "a",
  locked: false,
  keyEpoch: 0,
  deletedAt: 1,
  purged: false,
  lastUpdateSeq: 0,
  snapshotSeq: 0,
  ts: { title: zero, preview: zero, place: zero, pin: zero, trash: zero, lock: zero },
  seq,
  updatedAt: 0,
});

const everything: PullBatch = {
  headSeq: 10,
  cursor: 10,
  complete: true,
  serverTime: Date.now(),
  folders: [],
  notes: [],
  updates: [],
  snapshots: [],
  attachments: [],
};

/** The engine works in the background, which a busy machine slows. */
const WAIT = { timeout: 10_000 };

const engines: SyncEngine[] = [];

/** A device that pulls everything once, from a server that has let go of `gone`. */
async function sync(gone: Set<string>) {
  const server = fakeConvex({
    "sync:missing": (args) => ({
      folderIds: (args.folderIds as string[]).filter((id) => gone.has(id)),
      noteIds: (args.noteIds as string[]).filter((id) => gone.has(id)),
    }),
    "sync:push": (args) => ({
      serverTime: Date.now(),
      activePeers: 0,
      shouldCompact: [],
      results: (args.ops as { opId: string }[]).map((op) => ({ opId: op.opId, status: "ok" })),
    }),
  });
  let batch: PullBatch | null = everything;
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
  return { asked: () => server.callsTo("sync:missing") };
}

beforeEach(async () => {
  await resetLocalData();
  await setMeta(META.pinPlacesPulled, true);
  await db().folders.bulkPut([folder("f-gone", 3), folder("f-kept", 4)]);
  await db().notes.bulkPut([
    note("n-gone", 5),
    note("n-kept", 6),
    note("n-new", 0),
    note("n-edited", 7),
  ]);
  await db().bodies.put({ noteId: "n-gone", throughSeq: 5, keyEpoch: 0, text: "x", updatedAt: 0 });
});

afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
});

describe("folders and notes the server no longer has", () => {
  test("are let go of here, once everything is pulled, with the note's body", async () => {
    // Changed here and not yet sent: the server hears of it first.
    await enqueue({
      opId: "e1",
      kind: "note",
      entityId: "n-edited",
      payload: { kind: "note", noteId: "n-edited", title: { value: "題", ts: zero } },
    });
    const { asked } = await sync(new Set(["f-gone", "n-gone", "n-edited"]));

    await vi.waitFor(async () => expect(await getMeta(META.ghostsChecked, false)).toBe(true), WAIT);
    expect((await db().folders.toArray()).map((f) => f.folderId)).toEqual(["f-kept"]);
    expect((await db().notes.toArray()).map((n) => n.noteId).sort()).toEqual([
      "n-edited",
      "n-kept",
      "n-new",
    ]);
    expect(await db().bodies.get("n-gone")).toBeUndefined();
    expect(asked()[0]!.args.noteIds).not.toContain("n-new");
    expect(asked()[0]!.args.noteIds).not.toContain("n-edited");
  });

  test("are asked about once, not on every pull", async () => {
    await setMeta(META.ghostsChecked, true);
    const { asked } = await sync(new Set(["f-gone"]));
    await vi.waitFor(async () => expect(await getMeta(META.lastSyncAt, null)).not.toBeNull(), WAIT);
    expect(asked()).toHaveLength(0);
    expect(await db().folders.get("f-gone")).toBeDefined();
  });
});
