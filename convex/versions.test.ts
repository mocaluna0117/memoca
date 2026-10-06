import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { VERSION_GAP_MS, VERSION_KEEP_MS, versionsToDrop } from "./lib/versions";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
process.env.CONVEX_SITE_URL = "https://convex.test";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function setup() {
  return convexTest(schema, modules);
}
type T = ReturnType<typeof setup>;

async function signedIn(t: T, authId = "authuser_a") {
  await t.run(async (ctx) =>
    ctx.db.insert("users", {
      authId,
      email: `${authId}@example.com`,
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
  const as = t.withIdentity({ subject: authId });
  await as.mutation(api.sync.push, {
    deviceId: "device-1",
    ops: [
      {
        kind: "note",
        opId: `op-${authId}`,
        noteId: "n1",
        create: { noteKind: "note", folderId: null, sortKey: "m" },
      },
    ],
  });
  return as;
}

/** A version's state, uploaded as a device uploads it. */
const upload = (t: T, text = "版") =>
  t.run(async (ctx) => ctx.storage.store(new Blob([new TextEncoder().encode(text)])));

const files = (t: T) =>
  t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length);

describe("a note's versions", () => {
  test("one is kept at most every ten minutes, unless it is the note as it was before a restore", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const as = await signedIn(t);
      const save = async (beforeRestore?: boolean) =>
        as.mutation(api.versions.save, {
          noteId: "n1",
          keyEpoch: 0,
          storageId: await upload(t),
          ...(beforeRestore ? { beforeRestore } : {}),
        });

      expect(await save()).toEqual({ status: "ok" });
      vi.advanceTimersByTime(VERSION_GAP_MS - MINUTE);
      expect(await save()).toEqual({ status: "rejected", reason: "tooSoon" });
      expect(await save(true)).toEqual({ status: "ok" });
      vi.advanceTimersByTime(VERSION_GAP_MS);
      expect(await save()).toEqual({ status: "ok" });

      const versions = await as.query(api.versions.list, { noteId: "n1" });
      expect(versions).toHaveLength(3);
      // The one turned away took nothing with it.
      expect(await files(t)).toBe(3);

      const got = await as.query(api.versions.get, { versionId: versions[0]!.versionId });
      expect(got).toMatchObject({ noteId: "n1", keyEpoch: 0, iv: null });
      expect(got!.url).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  test("are another account's to read only, and the note's own", async () => {
    const t = setup();
    const as = await signedIn(t);
    await as.mutation(api.versions.save, { noteId: "n1", keyEpoch: 0, storageId: await upload(t) });
    const [version] = await as.query(api.versions.list, { noteId: "n1" });
    const other = await signedIn(t, "authuser_b");
    expect(await other.query(api.versions.get, { versionId: version!.versionId })).toBeNull();
    expect(await other.query(api.versions.list, { noteId: "n1" })).toEqual([]);
  });

  test("go with the note when it is purged, and their files with them", async () => {
    const t = setup();
    const as = await signedIn(t);
    await as.mutation(api.versions.save, { noteId: "n1", keyEpoch: 0, storageId: await upload(t) });
    await t.run(async (ctx) => {
      const note = await ctx.db.query("notes").first();
      await ctx.db.patch(note!._id, { deletedAt: Date.now() });
    });
    await as.mutation(api.trash.purge, { folderIds: [], noteIds: ["n1"] });
    expect(await t.run(async (ctx) => ctx.db.query("noteVersions").collect())).toEqual([]);
    expect(await files(t)).toBe(0);
  });

  test("past 30 days go, in the daily pass", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const as = await signedIn(t);
      await as.mutation(api.versions.save, {
        noteId: "n1",
        keyEpoch: 0,
        storageId: await upload(t),
      });
      vi.advanceTimersByTime(VERSION_KEEP_MS + DAY);
      await t.mutation(internal.versions.expire, {});
      expect(await as.query(api.versions.list, { noteId: "n1" })).toEqual([]);
      expect(await files(t)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("their files are not taken for files nothing points at", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const as = await signedIn(t);
      await as.mutation(api.versions.save, {
        noteId: "n1",
        keyEpoch: 0,
        storageId: await upload(t),
      });
      vi.advanceTimersByTime(7 * DAY);
      await t.mutation(internal.attachments.reconcileStorage, {});
      expect(await files(t)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("of a locked note, are refused unless sealed", async () => {
    const t = setup();
    const as = await signedIn(t);
    await t.run(async (ctx) => {
      const note = await ctx.db.query("notes").first();
      await ctx.db.patch(note!._id, { locked: true });
    });
    const storageId = await upload(t);
    expect(await as.mutation(api.versions.save, { noteId: "n1", keyEpoch: 0, storageId })).toEqual({
      status: "rejected",
      reason: "plaintextIntoLockedNote",
    });
    expect(await files(t)).toBe(0);
  });
});

describe("which versions are let go of", () => {
  const at = (ago: number) =>
    ({ id: `${ago}`, createdAt: NOW - ago }) as { id: string; createdAt: number };
  const NOW = 100 * DAY;

  test("the six newest stay; then one an hour for a day, one a day for 30 days, none after", () => {
    const versions = [
      ...[0, 10, 20, 30, 40, 50].map((m) => at(m * MINUTE)), // the six newest
      at(65 * MINUTE),
      at(70 * MINUTE), // same hour as 65 minutes ago: goes
      at(5 * DAY + HOUR),
      at(5 * DAY + 2 * HOUR), // same day: goes
      at(31 * DAY), // too old: goes
    ];
    const ids = (list: { id: string }[]) => list.map((v) => v.id);
    const dropped = ids(versionsToDrop(versions, NOW));
    expect(dropped).toContain(`${31 * DAY}`);
    expect(dropped).not.toContain("0");
    expect(dropped).not.toContain(`${50 * MINUTE}`);
    expect(dropped.filter((id) => [`${65 * MINUTE}`, `${70 * MINUTE}`].includes(id))).toHaveLength(
      1,
    );
    expect(
      dropped.filter((id) => [`${5 * DAY + HOUR}`, `${5 * DAY + 2 * HOUR}`].includes(id)),
    ).toHaveLength(1);
  });
});

