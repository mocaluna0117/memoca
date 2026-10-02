import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { db, getMeta, resetLocalData } from "@/lib/db";
import { META } from "@/lib/db/meta";
import { type PullBatch, applyBatch } from "@/lib/sync/apply";
import type { Attachment, Note } from "@/lib/types";
import { zero } from "./helpers/seed";

const note = (noteId: string, over: Partial<Note> = {}): Note => ({
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
  ...over,
});

const file = (attachmentId: string, over: Partial<Attachment> = {}): Attachment => ({
  attachmentId,
  noteId: "n1",
  status: "committed",
  bytes: 10,
  mime: "image/webp",
  name: "a.webp",
  locked: false,
  width: 1,
  height: 1,
  deletedAt: null,
  seq: 1,
  ...over,
});

const batch = (over: Partial<PullBatch>): PullBatch =>
  ({
    folders: [],
    notes: [],
    updates: [],
    snapshots: [],
    attachments: [],
    cursor: 2,
    complete: true,
    ...over,
  }) as unknown as PullBatch;

beforeEach(() => resetLocalData());

describe("a pull that removes things", () => {
  // Both used to abort the whole batch, touching tables the transaction did
  // not include; the cursor then never moved past them, so this device heard
  // nothing more from the server.
  test("a note purged from the trash goes, with its snapshot and body, and the cursor moves on", async () => {
    await db().notes.put(note("n1", { deletedAt: 1 }));
    await db().snapshots.put({ noteId: "n1", data: new Uint8Array([1]), keyEpoch: 0, throughSeq: 1 });
    await db().bodies.put({ noteId: "n1", throughSeq: 1, keyEpoch: 0, text: "本文", updatedAt: 0 });

    await applyBatch(batch({ notes: [{ ...note("n1"), purged: true, seq: 2 }] as never }));

    expect(await db().notes.get("n1")).toBeUndefined();
    expect(await db().snapshots.get("n1")).toBeUndefined();
    expect(await db().bodies.get("n1")).toBeUndefined();
    expect(await getMeta<number>(META.cursor, 0)).toBe(2);
  });

  test("a deleted file goes, with its cached copy, and the cursor moves on", async () => {
    await db().attachments.put(file("a1"));
    await db().blobs.put({ attachmentId: "a1", blob: new Blob(["x"]), bytes: 1, lastUsed: 0 });

    await applyBatch(batch({ attachments: [{ ...file("a1"), deletedAt: 5, seq: 2 }] as never }));

    expect(await db().attachments.get("a1")).toBeUndefined();
    expect(await db().blobs.get("a1")).toBeUndefined();
    expect(await getMeta<number>(META.cursor, 0)).toBe(2);
  });
});

describe("a file locked on another device", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("empties the service worker's copies, which may hold it in plaintext", async () => {
    const remove = vi.fn(async () => true);
    vi.stubGlobal("caches", { delete: remove });
    await db().attachments.put(file("a1"));

    await applyBatch(batch({ attachments: [{ ...file("a1"), locked: true, mime: null, seq: 2 }] as never }));
    expect(remove).toHaveBeenCalledWith("memoca-media");
  });

  test("leaves them alone for anything else", async () => {
    const remove = vi.fn(async () => true);
    vi.stubGlobal("caches", { delete: remove });
    await db().attachments.put(file("a1", { locked: true }));

    // Already locked here, or new to this device, or plain.
    await applyBatch(
      batch({
        attachments: [
          { ...file("a1"), locked: true, seq: 2 },
          { ...file("a2"), locked: true, seq: 3 },
          { ...file("a3"), seq: 4 },
        ] as never,
      }),
    );
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("a pin from another device", () => {
  /** Notes as a pull brings them. */
  const pulled = (...notes: Note[]) => notes as unknown as PullBatch["notes"];
  const later = (t: number) => ({ t, d: "other" });

  test("its place among the pinned comes on its own stamp, apart from the pin", async () => {
    await db().notes.put(note("n1"));
    const base = note("n1").ts;
    await applyBatch(
      batch({
        notes: pulled(
          note("n1", {
            pinned: true,
            pinKey: "m",
            ts: { ...base, pin: later(5), pinPlace: later(5) },
            seq: 2,
          }),
        ),
      }),
    );
    expect(await db().notes.get("n1")).toMatchObject({ pinned: true, pinKey: "m" });
    // Unpinned there, its place as it was.
    await applyBatch(
      batch({
        notes: pulled(
          note("n1", { pinned: false, pinKey: "m", ts: { ...base, pin: later(6), pinPlace: later(5) }, seq: 3 }),
        ),
        cursor: 3,
      }),
    );
    expect(await db().notes.get("n1")).toMatchObject({ pinned: false, pinKey: "m" });
    // A place written here later than the one that comes: kept.
    const local = (await db().notes.get("n1"))!;
    await db().notes.put({ ...local, pinKey: "g", ts: { ...local.ts, pinPlace: later(9) } });
    await applyBatch(
      batch({
        notes: pulled(
          note("n1", { pinKey: "z", ts: { ...base, pin: later(6), pinPlace: later(7) }, seq: 4 }),
        ),
        cursor: 4,
      }),
    );
    expect((await db().notes.get("n1"))?.pinKey).toBe("g");
  });
});
