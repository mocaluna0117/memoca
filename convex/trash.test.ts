import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const AUTH_A = "authuser_a";
const DAY = 24 * 60 * 60 * 1000;

// getUser only accepts tokens minted by this deployment (see sync.test.ts).
process.env.CONVEX_SITE_URL = "https://convex.test";

function setup() {
  return convexTest(schema, modules);
}

async function signedIn(t: ReturnType<typeof setup>) {
  await t.run(async (ctx) =>
    ctx.db.insert("users", {
      authId: AUTH_A,
      email: `${AUTH_A}@example.com`,
      role: "user",
      quotaBytes: 10_000_000,
      usedBytes: 0,
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
  return t.withIdentity({ subject: AUTH_A });
}

const stamp = (t: number, d = "device-1") => ({ t, d });

const noteOp = (opId: string, noteId: string) => ({
  kind: "note" as const,
  opId,
  noteId,
  create: { noteKind: "note" as const, folderId: null, sortKey: "m" },
});

const folderOp = (opId: string, folderId: string, parentId: string | null = null) => ({
  kind: "folder" as const,
  opId,
  folderId,
  create: { parentId, sortKey: "m", system: null },
});

const trashNote = (
  opId: string,
  noteId: string,
  deletedAt: number | null,
  ts: { t: number; d: string },
) => ({
  kind: "note" as const,
  opId,
  noteId,
  trash: { deletedAt, ts },
});

describe("purging from the trash", () => {
  test("leaves alone a note taken out of the trash on another device meanwhile", async () => {
    const t = setup();
    const as = await signedIn(t);
    await as.mutation(api.sync.push, { deviceId: "device-1", ops: [noteOp("c", "n1")] });
    await as.mutation(api.sync.push, {
      deviceId: "device-1",
      ops: [trashNote("tr", "n1", 3000, stamp(3000))],
    });
    await as.mutation(api.sync.push, {
      deviceId: "device-2",
      ops: [trashNote("re", "n1", null, stamp(4000, "device-2"))],
    });

    // This device has not heard of the restore, and empties its trash.
    await as.mutation(api.trash.purge, {
      folderIds: [],
      noteIds: ["n1"],
      trashedAt: { n1: stamp(3000) },
    });
    // Nor does an older client that sends no stamps purge it.
    await as.mutation(api.trash.purge, { folderIds: [], noteIds: ["n1"] });

    const note = await t.run(async (ctx) => ctx.db.query("notes").first());
    expect(note!.purged).toBe(false);
  });

  test("leaves alone a folder taken out of the trash, and what is in it", async () => {
    const t = setup();
    const as = await signedIn(t);
    await as.mutation(api.sync.push, {
      deviceId: "device-1",
      ops: [
        folderOp("a", "f1"),
        { ...noteOp("b", "n1"), create: { noteKind: "note", folderId: "f1", sortKey: "m" } },
      ],
    });
    await as.mutation(api.sync.push, {
      deviceId: "device-1",
      ops: [
        { kind: "folder", opId: "tr", folderId: "f1", trash: { deletedAt: 3000, ts: stamp(3000) } },
      ],
    });
    await as.mutation(api.sync.push, {
      deviceId: "device-2",
      ops: [
        {
          kind: "folder",
          opId: "re",
          folderId: "f1",
          trash: { deletedAt: null, ts: stamp(4000, "device-2") },
        },
      ],
    });

    await as.mutation(api.trash.purge, {
      folderIds: ["f1"],
      noteIds: [],
      trashedAt: { f1: stamp(3000) },
    });

    const folder = await t.run(async (ctx) => ctx.db.query("folders").first());
    const note = await t.run(async (ctx) => ctx.db.query("notes").first());
    expect(folder!.purged).toBe(false);
    expect(note!.purged).toBe(false);
  });

  test("still purges what this device has just put in the trash, before that has arrived", async () => {
    const t = setup();
    const as = await signedIn(t);
    await as.mutation(api.sync.push, { deviceId: "device-1", ops: [noteOp("c", "n1")] });

    await as.mutation(api.trash.purge, {
      folderIds: [],
      noteIds: ["n1"],
      trashedAt: { n1: stamp(5000) },
    });

    const note = await t.run(async (ctx) => ctx.db.query("notes").first());
    expect(note!.purged).toBe(true);
  });
});

describe("tombstones", () => {
  test("of a note are kept from its purge, however long before it was last edited", async () => {
    const t = setup();
    const as = await signedIn(t);
    await as.mutation(api.sync.push, { deviceId: "device-1", ops: [noteOp("c", "n1")] });
    await t.run(async (ctx) => {
      const note = await ctx.db.query("notes").first();
      await ctx.db.patch(note!._id, { updatedAt: Date.now() - 100 * DAY });
    });
    await as.mutation(api.sync.push, {
      deviceId: "device-1",
      ops: [trashNote("tr", "n1", 3000, stamp(3000))],
    });
    await as.mutation(api.trash.purge, { folderIds: [], noteIds: ["n1"] });

    await t.mutation(internal.trash.dropOldTombstones, {});
    expect(await t.run(async (ctx) => ctx.db.query("notes").collect())).toHaveLength(1);

    await t.run(async (ctx) => {
      const note = await ctx.db.query("notes").first();
      await ctx.db.patch(note!._id, { purgedAt: Date.now() - 91 * DAY });
    });
    await t.mutation(internal.trash.dropOldTombstones, {});
    expect(await t.run(async (ctx) => ctx.db.query("notes").collect())).toHaveLength(0);
  });

  test("of a folder purged with its parent are kept as long as the parent's", async () => {
    const t = setup();
    const as = await signedIn(t);
    await as.mutation(api.sync.push, {
      deviceId: "device-1",
      ops: [folderOp("a", "parent"), folderOp("b", "child", "parent")],
    });
    await as.mutation(api.sync.push, {
      deviceId: "device-1",
      ops: [
        {
          kind: "folder",
          opId: "tr",
          folderId: "parent",
          trash: { deletedAt: Date.now(), ts: stamp(3000) },
        },
      ],
    });
    await as.mutation(api.trash.purge, { folderIds: ["parent"], noteIds: [] });

    await t.mutation(internal.trash.dropOldTombstones, {});
    const left = await t.run(async (ctx) => ctx.db.query("folders").collect());
    expect(left.map((f) => [f.folderId, f.purged]).sort()).toEqual([
      ["child", true],
      ["parent", true],
    ]);
  });

  test("from before purges were dated are kept the whole time from when first seen", async () => {
    const t = setup();
    const as = await signedIn(t);
    await as.mutation(api.sync.push, { deviceId: "device-1", ops: [noteOp("c", "n1")] });
    await t.run(async (ctx) => {
      const note = await ctx.db.query("notes").first();
      await ctx.db.patch(note!._id, { purged: true, deletedAt: 1, updatedAt: 1 });
    });

    await t.mutation(internal.trash.dropOldTombstones, {});
    const note = await t.run(async (ctx) => ctx.db.query("notes").first());
    expect(note!.purgedAt).toBeGreaterThan(Date.now() - DAY);
  });
});

describe("trash past its time", () => {
  test("is purged for everyone, however much of someone else's longer-kept trash comes first", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const as = await signedIn(t);
      await as.mutation(api.sync.push, { deviceId: "device-1", ops: [noteOp("c", "model")] });
      await t.run(async (ctx) => {
        const model = (await ctx.db.query("notes").first())!;
        const { _id, _creationTime, ...fields } = model;
        void _id;
        void _creationTime;
        // Someone who keeps their trash 90 days: more than a page of it, the oldest of all.
        await ctx.db.patch(model.userId, {
          settings: { ...(await ctx.db.get(model.userId))!.settings, trashRetentionDays: 90 },
        });
        for (let i = 0; i < 250; i += 1) {
          await ctx.db.insert("notes", {
            ...fields,
            noteId: `kept-${i}`,
            deletedAt: Date.now() - 40 * DAY - i,
          });
        }
        // Someone who keeps it 7 days, with one note trashed 10 days ago.
        const other = await ctx.db.insert("users", {
          authId: "authuser_b",
          email: "b@example.com",
          role: "user",
          quotaBytes: 10_000_000,
          usedBytes: 0,
          reservedBytes: 0,
          settings: {
            theme: "system",
            trashRetentionDays: 7,
            autoLockMinutes: 5,
            prefetchBodies: true,
          },
          createdAt: Date.now(),
        });
        await ctx.db.insert("notes", {
          ...fields,
          userId: other,
          noteId: "due",
          deletedAt: Date.now() - 10 * DAY,
        });
      });

      await t.mutation(internal.trash.purgeExpired, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const notes = await t.run(async (ctx) => ctx.db.query("notes").collect());
      expect(notes.find((n) => n.noteId === "due")!.purged).toBe(true);
      expect(notes.filter((n) => n.noteId.startsWith("kept-") && n.purged)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
