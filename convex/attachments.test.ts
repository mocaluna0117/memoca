import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { TOMBSTONE_MS, UNREFERENCED_GRACE_MS } from "./lib/constants";
import schema from "./schema";

/**
 * convex-test needs to find every function module itself, which its bundler
 * does through import.meta.glob under Vite.
 */
const modules = import.meta.glob("./**/*.ts");

const AUTH_A = "authuser_a";
const AUTH_B = "authuser_b";

// getUser only accepts tokens minted by this deployment, identified by its own
// site URL. Set once for the whole file, as in sync.test.ts.
process.env.CONVEX_SITE_URL = "https://convex.test";

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  return convexTest(schema, modules);
}
type T = ReturnType<typeof setup>;
type Caller = ReturnType<T["withIdentity"]>;

async function seedUser(t: T, authId: string, usedBytes = 0): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      authId,
      email: `${authId}@example.com`,
      role: "user",
      quotaBytes: 10_000_000,
      usedBytes,
      reservedBytes: 0,
      settings: {
        theme: "system",
        trashRetentionDays: 30,
        autoLockMinutes: 5,
        prefetchBodies: true,
      },
      createdAt: Date.now(),
    }),
  );
}

async function pushNote(as: Caller, noteId: string) {
  await as.mutation(api.sync.push, {
    deviceId: "device-1",
    ops: [
      {
        kind: "note",
        opId: `op-${noteId}-${Math.random()}`,
        noteId,
        create: { noteKind: "note", folderId: null, sortKey: "m" },
      },
    ],
  });
}

/** Stands in for an edit reaching the server: the note moves on. */
const edit = (t: T, noteId: string, lastUpdateSeq: number) =>
  t.run(async (ctx) => {
    const note = await ctx.db
      .query("notes")
      .filter((q) => q.eq(q.field("noteId"), noteId))
      .unique();
    await ctx.db.patch(note!._id, { lastUpdateSeq });
  });

async function storeFile(
  t: T,
  userId: Id<"users">,
  noteId: string,
  attachmentId: string,
  bytes = 100,
  over: Partial<Doc<"attachments">> = {},
) {
  await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([new Uint8Array(bytes)]));
    await ctx.db.insert("attachments", {
      userId,
      attachmentId,
      noteId,
      status: "committed",
      storageId,
      reservedBytes: 0,
      bytes,
      mime: "image/webp",
      name: `${attachmentId}.webp`,
      locked: false,
      width: 10,
      height: 10,
      unreferencedAt: null,
      deletedAt: null,
      expiresAt: null,
      seq: 1,
      createdAt: 0,
      ...over,
    });
  });
}

const file = (t: T, attachmentId: string) =>
  t.run(async (ctx) =>
    ctx.db
      .query("attachments")
      .filter((q) => q.eq(q.field("attachmentId"), attachmentId))
      .unique(),
  );

const noteRow = (t: T, noteId: string) =>
  t.run(async (ctx) =>
    ctx.db
      .query("notes")
      .filter((q) => q.eq(q.field("noteId"), noteId))
      .unique(),
  );

const report = (as: Caller, noteId: string, throughSeq: number, refs: string[]) =>
  as.mutation(api.attachments.reportRefs, { noteId, throughSeq, refs });

const sweep = (t: T, now: number) => t.mutation(internal.attachments.sweepUnreferenced, { now });

describe("reporting which files a note uses", () => {
  test("a new note starts out reported, and the report travels with the note", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "n1");
    expect((await noteRow(t, "n1"))?.refsThroughSeq).toBe(0);

    await edit(t, "n1", 5);
    expect(await report(as, "n1", 5, [])).toEqual({ status: "ok" });
    const row = await noteRow(t, "n1");
    expect(row?.refsThroughSeq).toBe(5);
    const pulled = await as.query(api.sync.pull, { since: 0 });
    expect(pulled?.notes.find((n: { noteId: string }) => n.noteId === "n1")).toMatchObject({
      refsThroughSeq: 5,
    });
  });

  test("a report from a copy that is not the latest is refused", async () => {
    const t = setup();
    const userId = await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "n1");
    await storeFile(t, userId, "n1", "img");
    await edit(t, "n1", 7);
    expect(await report(as, "n1", 6, [])).toEqual({ status: "stale" });
    // Nothing was judged from it.
    expect((await file(t, "img"))?.unreferencedAt).toBeNull();
    expect((await noteRow(t, "n1"))?.refsThroughSeq).toBe(0);
  });

  test("a file the note stops using is marked unused, and unmarked when it is used again", async () => {
    const t = setup();
    const userId = await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "n1");
    await storeFile(t, userId, "n1", "img");
    await edit(t, "n1", 2);
    await report(as, "n1", 2, ["img"]);
    expect((await file(t, "img"))?.unreferencedAt).toBeNull();

    await edit(t, "n1", 3);
    await report(as, "n1", 3, []);
    expect((await file(t, "img"))?.unreferencedAt).toEqual(expect.any(Number));

    // Undone, or pasted back: in use again.
    await edit(t, "n1", 4);
    await report(as, "n1", 4, ["img"]);
    expect((await file(t, "img"))?.unreferencedAt).toBeNull();
  });

  test("a file the note stopped using before reports existed is caught by its first report", async () => {
    const t = setup();
    const userId = await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "n1");
    await storeFile(t, userId, "n1", "kept");
    await storeFile(t, userId, "n1", "trimmed-original");
    await edit(t, "n1", 9);
    await report(as, "n1", 9, ["kept"]);
    expect((await file(t, "kept"))?.unreferencedAt).toBeNull();
    expect((await file(t, "trimmed-original"))?.unreferencedAt).toEqual(expect.any(Number));
  });

  test("a file copied into another note stays in use while that note uses it", async () => {
    const t = setup();
    const userId = await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "a");
    await pushNote(as, "b");
    await storeFile(t, userId, "a", "shared");
    await edit(t, "b", 2);
    await report(as, "b", 2, ["shared"]);

    // Removed from the note it was uploaded to: still shown in b.
    await edit(t, "a", 3);
    await report(as, "a", 3, []);
    expect((await file(t, "shared"))?.unreferencedAt).toBeNull();

    // Removed from b too: now nothing uses it.
    await edit(t, "b", 4);
    await report(as, "b", 4, []);
    expect((await file(t, "shared"))?.unreferencedAt).toEqual(expect.any(Number));
  });

  test("another person's notes and files are out of reach", async () => {
    const t = setup();
    const userA = await seedUser(t, AUTH_A);
    await seedUser(t, AUTH_B);
    const asA = t.withIdentity({ subject: AUTH_A });
    const asB = t.withIdentity({ subject: AUTH_B });
    await pushNote(asA, "a1");
    await storeFile(t, userA, "a1", "img");
    await edit(t, "a1", 2);
    await report(asA, "a1", 2, ["img"]);

    expect(await report(asB, "a1", 2, [])).toEqual({ status: "rejected", reason: "unknownNote" });
    // B naming A's file in B's own note changes nothing for A.
    await pushNote(asB, "b1");
    await edit(t, "b1", 3);
    await report(asB, "b1", 3, ["img"]);
    await edit(t, "a1", 4);
    await report(asA, "a1", 4, []);
    expect((await file(t, "img"))?.unreferencedAt).toEqual(expect.any(Number));
  });

  test("too many files in one report is refused", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "n1");
    const refs = Array.from({ length: 501 }, (_, i) => `f${i}`);
    expect(await report(as, "n1", 0, refs)).toEqual({ status: "rejected", reason: "tooMany" });
  });
});

describe("the daily sweep", () => {
  async function unusedFile(t: T, bytes = 100) {
    const userId = await seedUser(t, AUTH_A, 1_000);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "n1");
    await storeFile(t, userId, "n1", "img", bytes);
    await edit(t, "n1", 2);
    await report(as, "n1", 2, []);
    const markedAt = (await file(t, "img"))!.unreferencedAt!;
    return { userId, as, markedAt };
  }

  test("keeps an unused file for 30 days, then deletes it and gives its bytes back", async () => {
    const t = setup();
    const { userId, markedAt } = await unusedFile(t, 100);

    expect((await sweep(t, markedAt + UNREFERENCED_GRACE_MS - DAY)).deleted).toBe(0);
    expect((await file(t, "img"))?.deletedAt).toBeNull();

    const result = await sweep(t, markedAt + UNREFERENCED_GRACE_MS + DAY);
    expect(result.deleted).toBe(1);
    const row = await file(t, "img");
    // A tombstone with a new seq, so devices drop their copies.
    expect(row).toMatchObject({ storageId: null, deletedAt: expect.any(Number), unreferencedAt: null });
    expect(row!.seq).toBeGreaterThan(1);
    // Nothing about the file is kept, its name included.
    expect(row).toMatchObject({ name: null, mime: null, width: null, height: null });
    const user = await t.run((ctx) => ctx.db.get(userId));
    expect(user?.usedBytes).toBe(900);
    const stored = await t.run((ctx) => ctx.db.system.query("_storage").collect());
    expect(stored).toHaveLength(0);
  });

  test("keeps it if it is used again within the 30 days", async () => {
    const t = setup();
    const { as, markedAt } = await unusedFile(t);
    await edit(t, "n1", 3);
    await report(as, "n1", 3, ["img"]);
    expect((await sweep(t, markedAt + UNREFERENCED_GRACE_MS + DAY)).deleted).toBe(0);
    expect((await file(t, "img"))?.deletedAt).toBeNull();
  });

  test("deletes nothing while any note of the user has an edit not yet reported", async () => {
    const t = setup();
    const { as, markedAt } = await unusedFile(t);
    // Another note changed and nobody has reported it: it might name the file.
    await pushNote(as, "other");
    await edit(t, "other", 5);
    const later = markedAt + UNREFERENCED_GRACE_MS + DAY;
    expect(await sweep(t, later)).toMatchObject({ deleted: 0, waiting: 1 });
    expect((await file(t, "img"))?.deletedAt).toBeNull();

    await report(as, "other", 5, []);
    expect((await sweep(t, later)).deleted).toBe(1);
  });

  test("a note in the trash still counts, and must be reported too", async () => {
    const t = setup();
    const { as, markedAt } = await unusedFile(t);
    await pushNote(as, "trashed");
    await t.run(async (ctx) => {
      const note = await ctx.db
        .query("notes")
        .filter((q) => q.eq(q.field("noteId"), "trashed"))
        .unique();
      await ctx.db.patch(note!._id, { deletedAt: Date.now(), lastUpdateSeq: 4 });
    });
    expect((await sweep(t, markedAt + UNREFERENCED_GRACE_MS + DAY)).deleted).toBe(0);
  });

  test("removes uploads that never completed", async () => {
    const t = setup();
    const userId = await seedUser(t, AUTH_A);
    await t.run(async (ctx) => {
      await ctx.db.insert("attachments", {
        userId,
        attachmentId: "abandoned",
        noteId: "n1",
        status: "orphan",
        storageId: null,
        reservedBytes: 0,
        bytes: 0,
        mime: "image/webp",
        name: null,
        locked: false,
        width: null,
        height: null,
        unreferencedAt: null,
        deletedAt: null,
        expiresAt: null,
        seq: 1,
        createdAt: 0,
      });
    });
    expect((await sweep(t, Date.now())).orphans).toBe(1);
    expect(await file(t, "abandoned")).toBeNull();
  });
});

describe("purging a note from the trash", () => {
  async function trash(t: T, noteId: string) {
    await t.run(async (ctx) => {
      const note = await ctx.db
        .query("notes")
        .filter((q) => q.eq(q.field("noteId"), noteId))
        .unique();
      await ctx.db.patch(note!._id, { deletedAt: Date.now() });
    });
  }

  test("keeps a file another note still shows, and frees only what it deletes", async () => {
    const t = setup();
    const userId = await seedUser(t, AUTH_A, 300);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "a");
    await pushNote(as, "b");
    await storeFile(t, userId, "a", "own", 100);
    await storeFile(t, userId, "a", "copied", 200);
    await edit(t, "a", 2);
    await report(as, "a", 2, ["own", "copied"]);
    await edit(t, "b", 3);
    await report(as, "b", 3, ["copied"]);

    await trash(t, "a");
    await as.mutation(api.trash.purge, { folderIds: [], noteIds: ["a"] });

    expect(await file(t, "own")).toMatchObject({ deletedAt: expect.any(Number), storageId: null });
    expect(await file(t, "copied")).toMatchObject({ deletedAt: null, storageId: expect.anything() });
    const user = await t.run((ctx) => ctx.db.get(userId));
    expect(user?.usedBytes).toBe(200);

    // b stops using it later: now it is unused, like any other file.
    await edit(t, "b", 4);
    await report(as, "b", 4, []);
    expect((await file(t, "copied"))?.unreferencedAt).toEqual(expect.any(Number));
  });

  test("a file of another note used only by the purged one becomes unused", async () => {
    const t = setup();
    const userId = await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "a");
    await pushNote(as, "b");
    await storeFile(t, userId, "a", "from-a");
    await edit(t, "a", 2);
    await report(as, "a", 2, []);
    await edit(t, "b", 3);
    await report(as, "b", 3, ["from-a"]);
    await edit(t, "a", 4);
    await report(as, "a", 4, []);
    expect((await file(t, "from-a"))?.unreferencedAt).toBeNull();

    await trash(t, "b");
    await as.mutation(api.trash.purge, { folderIds: [], noteIds: ["b"] });
    expect((await file(t, "from-a"))?.unreferencedAt).toEqual(expect.any(Number));
  });
});

describe("a file purged with its note", () => {
  async function trash(t: T, noteId: string) {
    await t.run(async (ctx) => {
      const note = await ctx.db
        .query("notes")
        .filter((q) => q.eq(q.field("noteId"), noteId))
        .unique();
      await ctx.db.patch(note!._id, { deletedAt: Date.now() });
    });
  }

  test("stays as a tombstone that syncs, so devices let go of their copy", async () => {
    const t = setup();
    const userId = await seedUser(t, AUTH_A, 100);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "a");
    await storeFile(t, userId, "a", "own", 100);
    const before = await file(t, "own");

    await trash(t, "a");
    await as.mutation(api.trash.purge, { folderIds: [], noteIds: ["a"] });

    const after = await file(t, "own");
    expect(after).toMatchObject({ deletedAt: expect.any(Number), storageId: null, unreferencedAt: null });
    expect(after).toMatchObject({ name: null, mime: null, width: null, height: null });
    expect(after!.seq).toBeGreaterThan(before!.seq);
    expect(await t.run((ctx) => ctx.storage.get(before!.storageId!))).toBeNull();
    expect((await t.run((ctx) => ctx.db.get(userId)))?.usedBytes).toBe(0);
    // And it reaches devices, which drop their copy on seeing it.
    const batch = await as.query(api.sync.pull, { since: 0 });
    expect(batch!.attachments.find((row) => row.attachmentId === "own")).toMatchObject({
      deletedAt: expect.any(Number),
      name: null,
    });
  });

  test("a locked file's sealed name and key go with it", async () => {
    const t = setup();
    const userId = await seedUser(t, AUTH_A, 100);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "a");
    const sealed = { ct: new ArrayBuffer(8), iv: new ArrayBuffer(12) };
    await storeFile(t, userId, "a", "secret", 100, {
      locked: true,
      name: null,
      mime: null,
      metaSealed: sealed,
      wrappedKey: sealed,
      contentIv: new ArrayBuffer(12),
    });
    await trash(t, "a");
    await as.mutation(api.trash.purge, { folderIds: [], noteIds: ["a"] });
    const after = await file(t, "secret");
    expect(after?.metaSealed).toBeUndefined();
    expect(after?.wrappedKey).toBeUndefined();
    expect(after?.contentIv).toBeUndefined();
  });

  test("one arriving after its note was purged is not kept, and the room it held goes back", async () => {
    const t = setup();
    const userId = await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "a");
    await as.mutation(api.attachments.reserve, {
      attachmentId: "late",
      noteId: "a",
      bytes: 100,
      mime: "image/webp",
      name: "late.webp",
      width: 1,
      height: 1,
      locked: false,
      category: "image",
    });
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(100)])));
    await trash(t, "a");
    await as.mutation(api.trash.purge, { folderIds: [], noteIds: ["a"] });

    const pushed = await as.mutation(api.sync.push, {
      deviceId: "device-1",
      ops: [{ kind: "attachment.commit", opId: "commit-late", attachmentId: "late", storageId }],
    });
    expect(pushed.results[0]).toMatchObject({ status: "rejected" });
    const user = await t.run((ctx) => ctx.db.get(userId));
    expect(user).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
    expect(await t.run((ctx) => ctx.storage.get(storageId))).toBeNull();
    expect(await file(t, "late")).toMatchObject({ status: "orphan", deletedAt: expect.any(Number) });
    // The reaper does not give the same room back a second time.
    await t.mutation(internal.attachments.reapReservations, {});
    expect((await t.run((ctx) => ctx.db.get(userId)))?.reservedBytes).toBe(0);
  });

  test("waits for the sweep when another note may show it without having said so yet", async () => {
    const t = setup();
    const userId = await seedUser(t, AUTH_A, 100);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "old");
    await pushNote(as, "new");
    await storeFile(t, userId, "old", "photo", 100);
    // Pasted into "new": the edit arrived, what it shows has not been reported.
    await edit(t, "new", 3);

    await trash(t, "old");
    await as.mutation(api.trash.purge, { folderIds: [], noteIds: ["old"] });
    const kept = await file(t, "photo");
    expect(kept).toMatchObject({ deletedAt: null, storageId: expect.anything() });
    expect(kept!.unreferencedAt).toBeLessThanOrEqual(Date.now() - UNREFERENCED_GRACE_MS);
    expect((await t.run((ctx) => ctx.db.get(userId)))?.usedBytes).toBe(100);

    // Then "new" reports it: it stays, for that note.
    await report(as, "new", 3, ["photo"]);
    await sweep(t, Date.now() + DAY);
    expect(await file(t, "photo")).toMatchObject({ deletedAt: null, unreferencedAt: null });
  });

  test("and is deleted by the sweep, its bytes given back, once every note has reported without it", async () => {
    const t = setup();
    const userId = await seedUser(t, AUTH_A, 100);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "old");
    await pushNote(as, "new");
    await storeFile(t, userId, "old", "photo", 100);
    await edit(t, "new", 3);
    await trash(t, "old");
    await as.mutation(api.trash.purge, { folderIds: [], noteIds: ["old"] });

    await report(as, "new", 3, []);
    await sweep(t, Date.now() + DAY);
    expect(await file(t, "photo")).toMatchObject({ deletedAt: expect.any(Number), storageId: null });
    expect((await t.run((ctx) => ctx.db.get(userId)))?.usedBytes).toBe(0);
  });

  test("still under way, is released by the reaper as before", async () => {
    const t = setup();
    const userId = await seedUser(t, AUTH_A);
    await t.run((ctx) => ctx.db.patch(userId, { reservedBytes: 50 }));
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "a");
    await storeFile(t, userId, "a", "uploading", 0, {
      status: "reserved",
      storageId: null,
      reservedBytes: 50,
      expiresAt: Date.now() - 1,
    });

    await trash(t, "a");
    await as.mutation(api.trash.purge, { folderIds: [], noteIds: ["a"] });
    await t.mutation(internal.attachments.reapReservations, {});
    expect((await t.run((ctx) => ctx.db.get(userId)))?.reservedBytes).toBe(0);
  });

  test("is let go for good once tombstones are old enough, however many there are", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const userId = await seedUser(t, AUTH_A);
      const old = Date.now() - TOMBSTONE_MS - DAY;
      await t.run(async (ctx) => {
        // More than one batch of them.
        for (let i = 0; i < 305; i += 1) {
          await ctx.db.insert("attachments", {
            userId,
            attachmentId: `old-${i}`,
            noteId: "a",
            status: "committed",
            storageId: null,
            reservedBytes: 0,
            bytes: 1,
            mime: null,
            name: null,
            locked: false,
            width: null,
            height: null,
            unreferencedAt: null,
            deletedAt: old,
            expiresAt: null,
            seq: i,
            createdAt: 0,
          });
        }
      });
      await storeFile(t, userId, "a", "just-gone", 100, { storageId: null, deletedAt: Date.now() - DAY });
      await storeFile(t, userId, "a", "live", 100);
      await t.mutation(internal.trash.dropOldTombstones, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const left = await t.run((ctx) => ctx.db.query("attachments").collect());
      expect(left.map((row) => row.attachmentId).sort()).toEqual(["just-gone", "live"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the account's storage", () => {
  test("a recount leaves out files deleted since", async () => {
    const t = setup();
    const userId = await seedUser(t, AUTH_A, 999);
    await storeFile(t, userId, "a", "live", 100);
    await storeFile(t, userId, "a", "swept", 300, { storageId: null, deletedAt: Date.now() });
    expect(await t.mutation(internal.admin.recomputeUsage, { email: `${AUTH_A}@example.com` })).toBe(100);
  });

  test("a recount that could not read everything writes nothing", async () => {
    const t = setup();
    const userId = await seedUser(t, AUTH_A, 999);
    await t.run(async (ctx) => {
      for (let i = 0; i < 5000; i += 1) {
        await ctx.db.insert("attachments", {
          userId,
          attachmentId: `f${i}`,
          noteId: "a",
          status: "committed",
          storageId: null,
          reservedBytes: 0,
          bytes: 1,
          mime: "image/webp",
          name: null,
          locked: false,
          width: null,
          height: null,
          unreferencedAt: null,
          deletedAt: null,
          expiresAt: null,
          seq: i,
          createdAt: 0,
        });
      }
    });
    expect(await t.mutation(internal.admin.recomputeUsage, { email: `${AUTH_A}@example.com` })).toBeNull();
    expect((await t.run((ctx) => ctx.db.get(userId)))?.usedBytes).toBe(999);
  });

  test("an upload tried again after the reaper let it go does not give its room back twice", async () => {
    const t = setup();
    const userId = await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "a");
    const reserve = (bytes: number) =>
      as.mutation(api.attachments.reserve, {
        attachmentId: "retry",
        noteId: "a",
        bytes,
        mime: "image/webp",
        name: "retry.webp",
        width: 1,
        height: 1,
        locked: false,
        category: "image",
      });
    await reserve(100);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("attachments")
        .filter((q) => q.eq(q.field("attachmentId"), "retry"))
        .unique();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });
    await t.mutation(internal.attachments.reapReservations, {});
    // Someone else's upload holds room meanwhile.
    await t.run((ctx) => ctx.db.patch(userId, { reservedBytes: 300 }));
    await reserve(100);
    expect((await t.run((ctx) => ctx.db.get(userId)))?.reservedBytes).toBe(400);
  });

  test("a file's kind is kept from its reservation, locked files included", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "a");
    await as.mutation(api.attachments.reserve, {
      attachmentId: "clip",
      noteId: "a",
      bytes: 100,
      mime: null,
      name: null,
      width: null,
      height: null,
      locked: true,
      category: "video",
    });
    expect(await file(t, "clip")).toMatchObject({ category: "video" });
  });

  test("is broken down: text, files by kind, the trash, what will be deleted, what is on its way, and the largest", async () => {
    const t = setup();
    const userId = await seedUser(t, AUTH_A, 1_000);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "live");
    await pushNote(as, "binned");
    await t.run(async (ctx) => {
      for (const note of await ctx.db.query("notes").collect()) {
        await ctx.db.patch(note._id, {
          bodyBytes: note.noteId === "live" ? 40 : 7,
          deletedAt: note.noteId === "binned" ? Date.now() : null,
        });
      }
    });
    const now = Date.now();
    await storeFile(t, userId, "live", "photo", 500);
    await storeFile(t, userId, "live", "clip", 300, { mime: "video/mp4" });
    await storeFile(t, userId, "live", "secret", 200, { locked: true, mime: null, name: null, category: "image" });
    await storeFile(t, userId, "live", "old-crop", 60, { unreferencedAt: now - DAY });
    await storeFile(t, userId, "binned", "in-bin", 90);
    await storeFile(t, userId, "live", "uploading", 0, { status: "reserved", storageId: null, reservedBytes: 25 });
    await storeFile(t, userId, "live", "gone", 999, { storageId: null, deletedAt: now });
    await t.run((ctx) =>
      ctx.db.insert("attachmentRefs", { userId, noteId: "live", attachmentId: "photo" }),
    );

    const usage = await as.query(api.usage.breakdown, {});
    expect(usage).toMatchObject({
      usedBytes: 1_000,
      bodies: { live: 40, trashed: 7 },
      files: { image: 700, video: 300, other: 0, locked: 0 },
      trashedFiles: 90,
      unused: { bytes: 60, count: 1, nextDeleteAt: now - DAY + UNREFERENCED_GRACE_MS },
      uploading: 25,
      recomputedBytes: 40 + 7 + 500 + 300 + 200 + 60 + 90,
      truncated: false,
    });
    expect(usage.largest.map((row) => row.attachmentId)).toEqual(["photo", "clip", "secret", "in-bin", "old-crop"]);
    expect(usage.largest[0]).toMatchObject({ name: "photo.webp", mime: "image/webp", usedBy: ["live"] });
    // A locked file's name and type stay for the device to read.
    expect(usage.largest[2]).toMatchObject({ locked: true, name: null, mime: null, kind: "image" });
    expect(usage.largest[3]).toMatchObject({ trashed: true });
    expect(usage.largest[4]).toMatchObject({ unused: true });
  });

  test("counts a locked file from before kinds were kept apart, not as some other kind of file", async () => {
    const t = setup();
    const userId = await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "a");
    await storeFile(t, userId, "a", "old-locked", 300, { locked: true, mime: null, name: null });
    await storeFile(t, userId, "a", "new-locked", 200, { locked: true, mime: null, name: null, category: "video" });
    const usage = await as.query(api.usage.breakdown, {});
    expect(usage.files).toEqual({ image: 0, video: 200, other: 0, locked: 300 });
    expect(usage.largest[0]).toMatchObject({ attachmentId: "old-locked", kind: "locked" });
  });

  test("counts a note in a folder put in the trash as in the trash, and a file another note shows as not", async () => {
    const t = setup();
    const userId = await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "filed");
    await pushNote(as, "binned");
    await pushNote(as, "live");
    await t.run(async (ctx) => {
      const at = { t: 0, d: "d" };
      await ctx.db.insert("folders", {
        userId,
        folderId: "work",
        parentId: null,
        name: "仕事",
        icon: null,
        sortKey: "a",
        locked: false,
        system: null,
        deletedAt: Date.now(),
        purged: false,
        ts: { name: at, place: at, trash: at, lock: at },
        deviceId: "d",
        seq: 1,
      });
      for (const note of await ctx.db.query("notes").collect()) {
        await ctx.db.patch(note._id, {
          bodyBytes: 10,
          folderId: note.noteId === "filed" ? "work" : note.folderId,
          deletedAt: note.noteId === "binned" ? Date.now() : null,
        });
      }
    });
    await storeFile(t, userId, "filed", "in-folder", 100);
    await storeFile(t, userId, "binned", "shared", 200);
    await t.run(async (ctx) => {
      await ctx.db.insert("attachmentRefs", { userId, noteId: "binned", attachmentId: "shared" });
      await ctx.db.insert("attachmentRefs", { userId, noteId: "live", attachmentId: "shared" });
    });

    const usage = await as.query(api.usage.breakdown, {});
    expect(usage.bodies).toEqual({ live: 10, trashed: 20 });
    expect(usage.files.locked).toBe(0);
    // Emptying the trash frees the folder's file, not the one "live" shows.
    expect(usage.trashedFiles).toBe(100);
    expect(usage.files.image).toBe(200);
    expect(usage.largest.find((row) => row.attachmentId === "shared")).toMatchObject({ trashed: false });
  });
});
