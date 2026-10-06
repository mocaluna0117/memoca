import "fake-indexeddb/auto";
import type { ConvexReactClient } from "convex/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { toArrayBuffer } from "@/lib/bytes";
import { db, resetLocalData, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import "@/lib/media/attachments";
import "@/lib/media/report-refs";
import "@/lib/search/yomi";
import { acquireDoc, flushDoc, releaseDoc } from "@/lib/sync/docs";
import { SyncEngine } from "@/lib/sync/engine";
import "@/lib/sync/mutations";
import { enqueue } from "@/lib/sync/outbox";
import type { PeerMessage } from "@/lib/sync/peers";
import type { Note } from "@/lib/types";
import { fakeConvex } from "./helpers/fake-convex";
import { zero } from "./helpers/seed";

const note = (noteId: string, locked = false): Note => ({
  noteId,
  folderId: null,
  kind: "note",
  title: noteId,
  preview: null,
  pinned: false,
  sortKey: "a",
  locked,
  keyEpoch: 0,
  deletedAt: null,
  purged: false,
  lastUpdateSeq: 0,
  snapshotSeq: 0,
  ts: { title: zero, preview: zero, place: zero, pin: zero, trash: zero, lock: zero },
  seq: 1,
  updatedAt: 0,
});

/** Another window of the app on this device: what it is told, and what it tells. */
let other: BroadcastChannel;
let heard: PeerMessage[];
const until = async (check: () => boolean) => {
  for (let tries = 0; tries < 100 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(check()).toBe(true);
};

beforeEach(async () => {
  await resetLocalData();
  await setMeta(META.pinPlacesPulled, true);
  await db().notes.put(note("n1"));
  heard = [];
  other = new BroadcastChannel("memoca-sync");
  other.onmessage = (event: MessageEvent<PeerMessage>) => heard.push(event.data);
});

afterEach(() => {
  other.close();
});

describe("this device's other windows", () => {
  test("a change made in another window shows at once in a note open here, and is not sent again from here", async () => {
    const doc = await acquireDoc("n1");
    try {
      const theirs = new Y.Doc();
      theirs.getText("t").insert(0, "向こうの窓で");
      other.postMessage({ kind: "update", noteId: "n1", update: Y.encodeStateAsUpdate(theirs) });
      await until(() => doc.getText("t").toString() === "向こうの窓で");
      await flushDoc("n1");
      expect(await db().outbox.count()).toBe(0);
    } finally {
      await releaseDoc("n1");
    }
  });

  test("are told what is typed here once it is stored, and that it waits to be sent", async () => {
    const doc = await acquireDoc("n1");
    try {
      doc.getText("t").insert(0, "ここで");
      await flushDoc("n1");
      await until(() => heard.some((message) => message.kind === "update"));
      const told = heard.find((message) => message.kind === "update")!;
      const mirror = new Y.Doc();
      Y.applyUpdate(mirror, (told as { update: Uint8Array }).update);
      expect(mirror.getText("t").toString()).toBe("ここで");
      expect(heard.some((message) => message.kind === "outbox")).toBe(true);
    } finally {
      await releaseDoc("n1");
    }
  });

  test("a locked note's text is not passed to them: they read it again with their own vault", async () => {
    await db().notes.put({ ...note("n2", true), wrappedKey: undefined });
    const { reloadDoc } = await import("@/lib/sync/docs");
    await reloadDoc("n2");
    await until(() => heard.length > 0);
    expect(heard).toEqual([{ kind: "reload", noteId: "n2" }]);
  });
});

describe("the subscription to what other devices change", () => {
  test("starts again from where this device has got to, not from where it first started", async () => {
    const asked: number[] = [];
    let deliver: (() => void) | null = null;
    let answer: unknown = null;
    const server = fakeConvex({});
    const client = {
      ...server.client,
      watchQuery: (_query: unknown, args: { since: number }) => {
        asked.push(args.since);
        return {
          localQueryResult: () => (args.since === 0 ? answer : emptyFrom(args.since)),
          onUpdate: (callback: () => void) => {
            if (args.since === 0) deliver = callback;
            return () => {};
          },
        };
      },
    };
    const engine = new SyncEngine(client as unknown as ConvexReactClient);
    await engine.start("me");
    try {
      await until(() => asked.length === 1);
      const typed = new Y.Doc();
      typed.getText("t").insert(0, "別の端末で");
      answer = {
        ...emptyFrom(0),
        cursor: 7,
        headSeq: 7,
        updates: [
          {
            noteId: "n1",
            opId: "u7",
            deviceId: "elsewhere",
            keyEpoch: 0,
            payload: toArrayBuffer(Y.encodeStateAsUpdate(typed)),
            seq: 7,
          },
        ],
      };
      deliver!();
      await until(() => asked.includes(7));
    } finally {
      engine.stop();
    }
  });
});

/** A pull with nothing new, from `since`. */
function emptyFrom(since: number) {
  return {
    headSeq: since,
    cursor: since,
    complete: true,
    serverTime: Date.now(),
    folders: [],
    notes: [],
    updates: [],
    snapshots: [],
    attachments: [],
  };
}

describe("what is typed while a push is under way", () => {
  test("goes in another push straight after it, not at the next round", async () => {
    let release!: () => void;
    let first = true;
    const server = fakeConvex({
      "sync:push": async (args) => {
        // The first push takes a while, as one over a slow network does.
        if (first) {
          first = false;
          await new Promise<void>((resolve) => (release = resolve));
        }
        return {
          serverTime: Date.now(),
          activePeers: 0,
          shouldCompact: [],
          results: (args.ops as { opId: string }[]).map((op) => ({ opId: op.opId, status: "ok" })),
        };
      },
    });
    const client = {
      ...server.client,
      watchQuery: () => ({ localQueryResult: () => null, onUpdate: () => () => {} }),
    };
    const engine = new SyncEngine(client as unknown as ConvexReactClient);
    const op = (opId: string) =>
      enqueue({
        opId,
        kind: "update",
        entityId: "n1",
        payload: { kind: "update", noteId: "n1", keyEpoch: 0, payload: new ArrayBuffer(3) },
      });
    await op("a");
    await engine.start("me");
    try {
      await vi.waitFor(() => expect(server.callsTo("sync:push")).toHaveLength(1), {
        timeout: 5_000,
      });
      await op("b");
      release();
      // Well before the five seconds between rounds while nobody else is editing.
      await vi.waitFor(() => expect(server.callsTo("sync:push")).toHaveLength(2), {
        timeout: 1_500,
      });
      expect(await db().outbox.count()).toBe(0);
    } finally {
      engine.stop();
    }
  });
});
