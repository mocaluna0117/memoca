import "fake-indexeddb/auto";
import type { ConvexReactClient } from "convex/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { db, resetLocalData, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import "@/lib/media/attachments";
import "@/lib/media/report-refs";
import "@/lib/sync/mutations";
import { SyncEngine } from "@/lib/sync/engine";
import { enqueue } from "@/lib/sync/outbox";
import type { Note } from "@/lib/types";
import { fakeConvex } from "./helpers/fake-convex";
import { zero } from "./helpers/seed";

const WAIT = { timeout: 10_000 };
let engine: SyncEngine | null = null;

// jsdom's Blob does not survive fake-indexeddb: a labelled stand-in, as in attachments.test.ts.
const image = (size: number) => ({ size, type: "image/webp", label: "image" }) as unknown as Blob;
URL.createObjectURL = () => "blob:test/0";
URL.revokeObjectURL = () => {};

beforeEach(async () => {
  await resetLocalData();
  await setMeta(META.pinPlacesPulled, true);
  await db().notes.put({
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
    ts: { title: zero, preview: zero, place: zero, pin: zero, trash: zero, lock: zero },
    seq: 1,
    updatedAt: 0,
  } as Note);
});

afterEach(() => {
  engine?.stop();
  engine = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A file sent up a moment ago, its commit queued, as flushUploads leaves them. */
async function uploaded(storageId: string) {
  await db().pendingUploads.put({
    attachmentId: "a1",
    noteId: "n1",
    blob: image(10),
    mime: "image/webp",
    name: "a.webp",
    width: 1,
    height: 1,
    category: "image",
    locked: false,
    reserved: true,
    storageId,
    uploadedAt: Date.now(),
    commitOpId: "c1",
    createdAt: Date.now(),
  });
  await enqueue({
    opId: "c1",
    kind: "attachment.commit",
    entityId: "a1",
    payload: { kind: "attachment.commit", attachmentId: "a1", storageId },
  });
}

function start(answer: (opId: string) => { status: string; reason?: string }) {
  const fake = fakeConvex({
    "sync:push": (args) => ({
      serverTime: Date.now(),
      activePeers: 0,
      shouldCompact: [],
      results: (args.ops as { opId: string }[]).map((op) => ({ opId: op.opId, ...answer(op.opId) })),
    }),
    "attachments:reserve": () => ({ status: "ok", uploadUrl: "https://upload.test" }),
  });
  const client = {
    ...fake.client,
    watchQuery: () => ({ localQueryResult: () => null, onUpdate: () => () => {} }),
  };
  engine = new SyncEngine(client as unknown as ConvexReactClient);
  return { fake, engine };
}

test("the commit taken, the file's waiting row goes, and a plain file's copy is kept to show", async () => {
  await uploaded("stored-1");
  const { engine } = start(() => ({ status: "ok" }));
  await engine.start("me");
  await vi.waitFor(async () => expect(await db().pendingUploads.count()).toBe(0), WAIT);
  expect(await db().outbox.count()).toBe(0);
  expect(await db().blobs.count()).toBe(1);
});

test("the commit refused as run out, the file goes up again from the copy kept", async () => {
  await uploaded("stored-1");
  let commits = 0;
  const { fake, engine } = start((opId) => {
    if (opId !== "c1" && !opId.startsWith("c")) return { status: "ok" };
    commits += 1;
    return commits === 1 ? { status: "rejected", reason: "reservationExpired" } : { status: "ok" };
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ storageId: "stored-2" }))),
  );
  await engine.start("me");
  // Reserved and sent up again, committed under the new id, and done.
  await vi.waitFor(async () => expect(await db().pendingUploads.count()).toBe(0), WAIT);
  expect(fake.callsTo("attachments:reserve")).toHaveLength(1);
  const sent = fake
    .callsTo("sync:push")
    .flatMap((call) => call.args.ops as { kind: string; storageId?: string }[])
    .filter((op) => op.kind === "attachment.commit")
    .map((op) => op.storageId);
  expect(sent).toEqual(["stored-1", "stored-2"]);
  expect(await db().blobs.count()).toBe(1);
});

test("a file the server does not know at all is given up, not sent again", async () => {
  await uploaded("stored-1");
  const { fake, engine } = start(() => ({ status: "rejected", reason: "unknownAttachment" }));
  await engine.start("me");
  await vi.waitFor(async () => expect(await db().pendingUploads.count()).toBe(0), WAIT);
  expect(fake.callsTo("attachments:reserve")).toHaveLength(0);
  expect(await db().blobs.count()).toBe(0);
});
