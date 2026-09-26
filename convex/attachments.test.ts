import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { UNREFERENCED_GRACE_MS } from "./lib/constants";
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

async function storeFile(t: T, userId: Id<"users">, noteId: string, attachmentId: string, bytes = 100) {
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

    expect(await file(t, "own")).toBeNull();
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
