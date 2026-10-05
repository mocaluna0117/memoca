import "fake-indexeddb/auto";
import type { ConvexReactClient } from "convex/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as Y from "yjs";
import { toArrayBuffer } from "@/lib/bytes";
import { db, resetLocalData, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
// Loaded by the sync engine only when it gets round to them, which can be
// after a test is over: loaded here, before any test, instead.
import "@/lib/media/attachments";
import "@/lib/media/report-refs";
import "@/lib/search/yomi";
import { SyncEngine } from "@/lib/sync/engine";
import "@/lib/sync/mutations";
import type { Note } from "@/lib/types";
import { fakeConvex } from "./helpers/fake-convex";
import { zero } from "./helpers/seed";

const note = (): Note => ({
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
  lastUpdateSeq: 1,
  snapshotSeq: 0,
  ts: { title: zero, preview: zero, place: zero, pin: zero, trash: zero, lock: zero },
  seq: 1,
  updatedAt: 0,
});

const engines: SyncEngine[] = [];

beforeEach(async () => {
  await resetLocalData();
  await setMeta(META.pinPlacesPulled, true);
  await db().notes.put(note());
});

afterEach(() => {
  for (const engine of engines.splice(0)) engine.stop();
});

test("bodies that arrive after the engine stopped are not written, to what may be another account's data", async () => {
  let answer!: (value: unknown) => void;
  const server = fakeConvex({
    "notes:getBodies": () => new Promise((resolve) => (answer = resolve)),
  });
  const client = {
    ...server.client,
    watchQuery: () => ({ localQueryResult: () => null, onUpdate: () => () => {} }),
  };
  const engine = new SyncEngine(client as unknown as ConvexReactClient);
  engines.push(engine);
  await engine.start("me");

  const fetching = engine.fetchBodies(["n1"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Signing out, or another account signing in: the engine stops and the
  // local data is wiped while the server is still answering.
  engine.stop();
  await resetLocalData();

  const doc = new Y.Doc();
  doc.getText("t").insert(0, "前の人のメモ");
  answer({
    bodies: [
      {
        noteId: "n1",
        keyEpoch: 0,
        lastUpdateSeq: 1,
        snapshot: null,
        updates: [
          {
            noteId: "n1",
            opId: "u1",
            deviceId: "elsewhere",
            keyEpoch: 0,
            payload: toArrayBuffer(Y.encodeStateAsUpdate(doc)),
            seq: 1,
          },
        ],
      },
    ],
    truncated: false,
  });
  await fetching;

  expect(await db().updates.count()).toBe(0);
  expect(await db().bodies.count()).toBe(0);
});
