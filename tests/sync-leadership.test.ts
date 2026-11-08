import "fake-indexeddb/auto";
import type { ConvexReactClient } from "convex/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { db, resetLocalData, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import "@/lib/media/attachments";
import "@/lib/media/report-refs";
import "@/lib/search/yomi";
import { acquireDoc, releaseDoc } from "@/lib/sync/docs";
import { SyncEngine } from "@/lib/sync/engine";
import "@/lib/sync/mutations";
import { enqueue } from "@/lib/sync/outbox";
import type { Note } from "@/lib/types";
import { fakeConvex } from "./helpers/fake-convex";
import { zero } from "./helpers/seed";
import * as Y from "yjs";

const note = (noteId: string): Note => ({
  noteId,
  folderId: null,
  kind: "note",
  title: noteId,
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
});

/**
 * Web Locks for one name, as the windows of the app on one device share them:
 * granted in turn, an ask in line taken back by its signal, and one held
 * taken by an ask that steals it (its own ask then fails, as a browser's does).
 */
function fakeLocks() {
  type Ask = {
    callback: () => unknown;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  };
  let held: Ask | null = null;
  const line: Ask[] = [];
  let asked = 0;
  const grant = (ask: Ask) => {
    held = ask;
    void Promise.resolve(ask.callback()).then((value) => {
      if (held !== ask) return;
      held = null;
      ask.resolve(value);
      const next = line.shift();
      if (next) grant(next);
    });
  };
  return {
    /** Whether anyone holds the lock, and how many asks have been made. */
    state: () => ({ held: held !== null, waiting: line.length, asked }),
    request(_name: string, options: LockOptions, callback: () => unknown) {
      asked += 1;
      return new Promise((resolve, reject) => {
        const ask: Ask = { callback, resolve, reject };
        if (options.steal) {
          held?.reject(new DOMException("The lock was stolen.", "AbortError"));
          grant(ask);
          return;
        }
        if (!held && line.length === 0) {
          grant(ask);
          return;
        }
        line.push(ask);
        options.signal?.addEventListener("abort", () => {
          const at = line.indexOf(ask);
          if (at < 0) return;
          line.splice(at, 1);
          reject(new DOMException("Taken back.", "AbortError"));
        });
      });
    },
  };
}

let locks: ReturnType<typeof fakeLocks>;
let visibility: DocumentVisibilityState = "hidden";
const setVisibility = (state: DocumentVisibilityState) => {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
};

/** A window of the app: its engine, and what it asked the server. */
function window_() {
  let watches = 0;
  let unwatched = 0;
  const server = fakeConvex({
    "sync:push": (args) => ({
      serverTime: Date.now(),
      activePeers: 0,
      shouldCompact: [],
      results: (args.ops as { opId: string }[]).map((op) => ({ opId: op.opId, status: "ok" })),
    }),
  });
  const client = {
    ...server.client,
    watchQuery: () => {
      watches += 1;
      return {
        localQueryResult: () => null,
        onUpdate: () => () => {
          unwatched += 1;
        },
      };
    },
  };
  const engine = new SyncEngine(client as unknown as ConvexReactClient);
  return {
    engine,
    server,
    /** Whether it has the pull subscription open now. */
    watching: () => watches > unwatched,
  };
}

const op = (opId: string) =>
  enqueue({
    opId,
    kind: "update",
    entityId: "n1",
    payload: { kind: "update", noteId: "n1", keyEpoch: 0, payload: new ArrayBuffer(3) },
  });

beforeEach(async () => {
  await resetLocalData();
  await setMeta(META.pinPlacesPulled, true);
  await db().notes.put(note("n1"));
  visibility = "hidden";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  locks = fakeLocks();
  Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "locks");
});

describe("the window that syncs", () => {
  test("a window coming into view takes it from one out of sight, which stops", async () => {
    // The desktop app's quick note: made first, out of sight, it syncs.
    const quick = window_();
    const main = window_();
    await quick.engine.start("me");
    await vi.waitFor(() => expect(quick.watching()).toBe(true));
    await main.engine.start("me");
    try {
      expect(main.watching()).toBe(false);

      // Memoca's own window brought out: it syncs now, the other not.
      setVisibility("visible");
      await vi.waitFor(() => expect(main.watching()).toBe(true));
      expect(quick.watching()).toBe(false);

      // What is typed is sent by the one in view.
      await op("a");
      await vi.waitFor(() => expect(main.server.callsTo("sync:push")).toHaveLength(1));
      expect(quick.server.callsTo("sync:push")).toHaveLength(0);
      expect(await db().outbox.count()).toBe(0);
    } finally {
      main.engine.stop();
      quick.engine.stop();
    }
  });

  test("one opened in view syncs at once; the other takes it back once that one stops", async () => {
    const quick = window_();
    await quick.engine.start("me");
    await vi.waitFor(() => expect(quick.watching()).toBe(true));
    visibility = "visible";
    const main = window_();
    await main.engine.start("me");
    try {
      await vi.waitFor(() => expect(main.watching()).toBe(true));
      expect(quick.watching()).toBe(false);
    } finally {
      main.engine.stop();
    }
    try {
      // It waited in line, and syncs again.
      await vi.waitFor(() => expect(quick.watching()).toBe(true));
    } finally {
      quick.engine.stop();
    }
  });

  test("put away, what was just typed is written and sent at once", async () => {
    const phone = window_();
    visibility = "visible";
    await phone.engine.start("me");
    const doc = await acquireDoc("n1");
    /** The text the pushes so far have sent of the note. */
    const sent = () => {
      const mirror = new Y.Doc();
      for (const call of phone.server.callsTo("sync:push")) {
        for (const each of call.args.ops as { kind: string; payload?: ArrayBuffer }[]) {
          if (each.kind === "update") Y.applyUpdate(mirror, new Uint8Array(each.payload!));
        }
      }
      return mirror.getText("t").toString();
    };
    try {
      await vi.waitFor(() => expect(phone.watching()).toBe(true));
      // Whatever opening it wrote, sent first.
      await vi.waitFor(async () => expect(await db().outbox.count()).toBe(0));
      doc.getText("t").insert(0, "閉じる直前に");
      setVisibility("hidden");
      // Not after the half second an edit waits to be written, nor the
      // quarter after it a push waits.
      await vi.waitFor(() => expect(sent()).toBe("閉じる直前に"), { timeout: 400 });
    } finally {
      await releaseDoc("n1");
      phone.engine.stop();
    }
  });

  test("a page going away lets the lock go at once, asks for it no more, and still sends what was just typed", async () => {
    const page = window_();
    visibility = "visible";
    await page.engine.start("me");
    const doc = await acquireDoc("n1");
    try {
      await vi.waitFor(() => expect(page.watching()).toBe(true));
      await vi.waitFor(async () => expect(await db().outbox.count()).toBe(0));
      const asked = locks.state().asked;
      doc.getText("t").insert(0, "離れる直前に");
      // A reload, say: in WebKit, a lock held through it, or asked for
      // again as it went, hung the reload.
      window.dispatchEvent(new Event("pagehide"));
      expect(page.watching()).toBe(false);
      // Let go as soon as the browser takes the release in, before anything is sent.
      await vi.waitFor(() => expect(locks.state().held).toBe(false), { timeout: 100 });
      await vi.waitFor(() => expect(page.server.callsTo("sync:push").length).toBeGreaterThan(0));
      const sent = new Y.Doc();
      for (const call of page.server.callsTo("sync:push")) {
        for (const each of call.args.ops as { kind: string; payload?: ArrayBuffer }[]) {
          if (each.kind === "update") Y.applyUpdate(sent, new Uint8Array(each.payload!));
        }
      }
      expect(sent.getText("t").toString()).toBe("離れる直前に");
      // Seen again (a tab coming into view meanwhile, say): not asked for, the page going.
      setVisibility("visible");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(locks.state().asked).toBe(asked);
      expect(locks.state().held).toBe(false);
    } finally {
      await releaseDoc("n1");
      page.engine.stop();
    }
  });

  test("back from the back-forward cache, it syncs again", async () => {
    const page = window_();
    visibility = "visible";
    await page.engine.start("me");
    try {
      await vi.waitFor(() => expect(page.watching()).toBe(true));
      window.dispatchEvent(new Event("pagehide"));
      expect(page.watching()).toBe(false);
      const shown = new Event("pageshow");
      Object.defineProperty(shown, "persisted", { value: true });
      window.dispatchEvent(shown);
      await vi.waitFor(() => expect(page.watching()).toBe(true));
      expect(locks.state().held).toBe(true);
    } finally {
      page.engine.stop();
    }
  });
});
