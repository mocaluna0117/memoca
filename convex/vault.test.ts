import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * convex-test needs to find every function module itself, which its bundler
 * does through import.meta.glob under Vite.
 */
const modules = import.meta.glob("./**/*.ts");

const AUTH_A = "authuser_a";
const AUTH_B = "authuser_b";

/** The issuer convex-test stamps on an identity when none is given. */
const TEST_ISSUER = "https://convex.test";

// getUser only accepts tokens minted by this deployment, identified by its own
// site URL. Set once for the whole file, as in sync.test.ts.
process.env.CONVEX_SITE_URL = TEST_ISSUER;

function setup() {
  return convexTest(schema, modules);
}

async function seedUser(t: ReturnType<typeof setup>, authId: string): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
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
}

const bytes = (...values: number[]) => new Uint8Array(values).buffer as ArrayBuffer;

/** A vault record as the client sends it; the contents are opaque here. */
const record = (marker: number) => ({
  argon: { m: 1024, t: 1, p: 1 },
  saltPw: bytes(marker, 1),
  pwWrap: { ct: bytes(marker, 2), iv: bytes(marker, 3) },
  recWrap: { hkdfSalt: bytes(marker, 4), ct: bytes(marker, 5), iv: bytes(marker, 6) },
});

describe("vault setup", () => {
  test("a second setup never replaces the vault that is already there", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });

    expect(await as.mutation(api.vault.setup, record(1))).toEqual({ status: "ok" });
    // Another device, or a stale screen, tries to create one again.
    expect(await as.mutation(api.vault.setup, record(2))).toEqual({ status: "already" });

    const status = await as.query(api.vault.status, {});
    expect(status).not.toBeNull();
    // Still the first vault's wrapping, unchanged.
    expect(new Uint8Array(status!.pwWrap.ct)).toEqual(new Uint8Array([1, 2]));
    expect(status!.version).toBe(1);
  });
});

describe("vault record", () => {
  test("says signed out, none, or exists, and never shows another person's vault", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    await seedUser(t, AUTH_B);
    const asA = t.withIdentity({ subject: AUTH_A });
    const asB = t.withIdentity({ subject: AUTH_B });

    expect(await t.query(api.vault.record, {})).toEqual({ state: "signedOut" });
    expect(await asA.query(api.vault.record, {})).toEqual({ state: "none" });

    await asA.mutation(api.vault.setup, { ...record(1), recoveryFormat: 2 });
    const mine = await asA.query(api.vault.record, {});
    expect(mine.state).toBe("exists");
    if (mine.state === "exists") {
      expect(mine.record.recoveryFormat).toBe(2);
      expect(mine.record.recoveryCheckedAt).toBeNull();
      expect(mine.record.version).toBe(1);
    }
    expect(await asB.query(api.vault.record, {})).toEqual({ state: "none" });
  });

  test("a vault made before the recovery key fix reports no format", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await as.mutation(api.vault.setup, record(1));
    const read = await as.query(api.vault.record, {});
    expect(read.state === "exists" && read.record.recoveryFormat).toBeNull();
  });
});

describe("vault rewrap", () => {
  test("a change based on an old version is refused and writes nothing", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await as.mutation(api.vault.setup, record(1));

    const stale = await as.mutation(api.vault.rewrap, {
      pwWrap: { ct: bytes(9, 9), iv: bytes(9, 9) },
      expectedVersion: 7,
    });
    expect(stale).toEqual({ status: "stale", version: 1 });
    const unchanged = await as.query(api.vault.status, {});
    expect(new Uint8Array(unchanged!.pwWrap.ct)).toEqual(new Uint8Array([1, 2]));
    expect(unchanged!.version).toBe(1);
  });

  test("a new recovery key is stored with its format and is not yet confirmed", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await as.mutation(api.vault.setup, record(1));
    await as.mutation(api.vault.markRecoveryChecked, { recWrapIv: record(1).recWrap.iv });

    const done = await as.mutation(api.vault.rewrap, {
      recWrap: record(3).recWrap,
      recoveryFormat: 2,
      expectedVersion: 1,
    });
    expect(done).toEqual({ status: "ok", version: 2 });
    const read = await as.query(api.vault.record, {});
    expect(read.state).toBe("exists");
    if (read.state === "exists") {
      expect(read.record.recoveryFormat).toBe(2);
      expect(read.record.recoveryCheckedAt).toBeNull();
      expect(new Uint8Array(read.record.recWrap!.ct)).toEqual(new Uint8Array([3, 5]));
    }
  });

  test("confirming the recovery key records when", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await as.mutation(api.vault.setup, record(1));
    expect(
      await as.mutation(api.vault.markRecoveryChecked, { recWrapIv: record(1).recWrap.iv }),
    ).toEqual({ status: "ok" });
    const read = await as.query(api.vault.record, {});
    expect(read.state === "exists" && typeof read.record.recoveryCheckedAt).toBe("number");
  });

  test("confirming a key that has since been replaced marks nothing", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await as.mutation(api.vault.setup, record(1));
    // Another tab makes a newer key before this one is confirmed.
    await as.mutation(api.vault.rewrap, { recWrap: record(3).recWrap, recoveryFormat: 2 });

    expect(
      await as.mutation(api.vault.markRecoveryChecked, { recWrapIv: record(1).recWrap.iv }),
    ).toEqual({ status: "stale" });
    const read = await as.query(api.vault.record, {});
    expect(read.state === "exists" && read.record.recoveryCheckedAt).toBeNull();
  });
});

describe("vault passkeys", () => {
  const passkey = (credentialId: string, label = "iPhone") => ({
    credentialId,
    prfInput: bytes(1),
    hkdfSalt: bytes(2),
    ct: bytes(3),
    iv: bytes(4),
    label,
  });

  test("registering the same passkey again replaces it rather than adding one", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await as.mutation(api.vault.setup, record(1));
    await as.mutation(api.vault.addPasskey, passkey("cred-1", "古い名前"));
    await as.mutation(api.vault.addPasskey, passkey("cred-1", "新しい名前"));
    const read = await as.query(api.vault.status, {});
    expect(read!.passkeys.map((p) => p.label)).toEqual(["新しい名前"]);
  });

  test("at most ten passkeys, and labels are kept short", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await as.mutation(api.vault.setup, record(1));
    for (let i = 0; i < 10; i += 1) {
      expect(await as.mutation(api.vault.addPasskey, passkey(`cred-${i}`))).toEqual({
        status: "ok",
      });
    }
    expect(await as.mutation(api.vault.addPasskey, passkey("cred-10"))).toEqual({
      status: "tooMany",
    });
    // Replacing an existing one is still allowed at the limit.
    await as.mutation(api.vault.addPasskey, passkey("cred-0", "あ".repeat(200)));
    const read = await as.query(api.vault.status, {});
    expect(read!.passkeys).toHaveLength(10);
    expect(read!.passkeys.find((p) => p.credentialId === "cred-0")!.label).toHaveLength(64);
  });

  test("removing a passkey leaves the password wrapping alone", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await as.mutation(api.vault.setup, record(1));
    await as.mutation(api.vault.addPasskey, passkey("cred-1"));
    await as.mutation(api.vault.removePasskey, { credentialId: "cred-1" });
    const read = await as.query(api.vault.status, {});
    expect(read!.passkeys).toHaveLength(0);
    expect(new Uint8Array(read!.pwWrap.ct)).toEqual(new Uint8Array([1, 2]));
  });
});

describe("folder locks", () => {
  const stamp = (t: number) => ({ t, d: "device-1" });

  async function pushFolder(
    as: ReturnType<ReturnType<typeof setup>["withIdentity"]>,
    folderId: string,
    name: string,
    system: "inbox" | null = null,
  ) {
    await as.mutation(api.sync.push, {
      deviceId: "device-1",
      ops: [
        {
          kind: "folder",
          opId: `op-${folderId}`,
          folderId,
          create: { parentId: null, sortKey: "b", system },
          name: { value: name, icon: null, ts: stamp(1000) },
          place: { parentId: null, sortKey: "b", ts: stamp(1000) },
        },
      ],
    });
  }

  const folderRow = (t: ReturnType<typeof setup>, folderId: string) =>
    t.run(async (ctx) =>
      ctx.db
        .query("folders")
        .filter((q) => q.eq(q.field("folderId"), folderId))
        .unique(),
    );

  test("locking keeps the folder's name, even when an older client sends a sealed one", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushFolder(as, "work", "仕事");

    expect(
      await as.mutation(api.vault.setFolderLock, {
        folderId: "work",
        locked: true,
        name: null,
        nameSealed: { ct: bytes(1), iv: bytes(2) },
        ts: stamp(2000),
      }),
    ).toEqual({ status: "ok" });
    const row = await folderRow(t, "work");
    expect(row?.locked).toBe(true);
    expect(row?.name).toBe("仕事");
    expect(row?.nameSealed).toBeUndefined();
  });

  test("Inbox cannot be locked", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushFolder(as, "inbox", "Inbox", "inbox");
    expect(
      await as.mutation(api.vault.setFolderLock, { folderId: "inbox", locked: true, ts: stamp(2000) }),
    ).toEqual({ status: "rejected", reason: "systemFolder" });
    // Taking an old lock off it is still allowed.
    expect(
      await as.mutation(api.vault.setFolderLock, { folderId: "inbox", locked: false, ts: stamp(2001) }),
    ).toEqual({ status: "ok" });
  });

  test("an older change arriving late loses", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushFolder(as, "work", "仕事");
    await as.mutation(api.vault.setFolderLock, { folderId: "work", locked: true, ts: stamp(3000) });
    await as.mutation(api.vault.setFolderLock, { folderId: "work", locked: false, ts: stamp(2000) });
    expect((await folderRow(t, "work"))?.locked).toBe(true);
  });

  test("an older client unlocking a folder it sealed gives the folder its name back", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushFolder(as, "work", "仕事");
    // What such a client left behind: a locked folder with only a sealed name.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("folders")
        .filter((q) => q.eq(q.field("folderId"), "work"))
        .unique();
      await ctx.db.patch(row!._id, { locked: true, name: null, nameSealed: { ct: bytes(1), iv: bytes(2) } });
    });
    await as.mutation(api.vault.setFolderLock, {
      folderId: "work",
      locked: false,
      name: "仕事",
      ts: stamp(4000),
    });
    const row = await folderRow(t, "work");
    expect(row?.name).toBe("仕事");
    expect(row?.nameSealed).toBeUndefined();
    expect(row?.locked).toBe(false);
  });

  test("another person's folder is unknown", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    await seedUser(t, AUTH_B);
    await pushFolder(t.withIdentity({ subject: AUTH_A }), "work", "仕事");
    expect(
      await t
        .withIdentity({ subject: AUTH_B })
        .mutation(api.vault.setFolderLock, { folderId: "work", locked: true, ts: stamp(2000) }),
    ).toEqual({ status: "rejected", reason: "unknownFolder" });
  });
});

describe("note locks", () => {
  const stamp = (t: number, d = "device-1") => ({ t, d });
  const sealed = () => ({ ct: new Uint8Array(32).buffer, iv: new Uint8Array(12).buffer });
  type Caller = ReturnType<ReturnType<typeof setup>["withIdentity"]>;

  async function pushNote(as: Caller, noteId: string, extra: Record<string, unknown> = {}) {
    return as.mutation(api.sync.push, {
      deviceId: "device-1",
      ops: [
        {
          kind: "note",
          opId: `op-${noteId}-${Math.random()}`,
          noteId,
          create: { noteKind: "note", folderId: null, sortKey: "m" },
          ...extra,
        },
      ],
    });
  }

  const lockArgs = (noteId: string, extra: Record<string, unknown> = {}) => ({
    noteId,
    keyEpoch: 1,
    coversThroughSeq: 0,
    wrappedKey: { ct: new Uint8Array(48).buffer, iv: new Uint8Array(12).buffer },
    titleSealed: sealed(),
    snapshot: { payload: new Uint8Array(8).buffer, size: 8, iv: new Uint8Array(12).buffer },
    attachments: [],
    ts: stamp(2000),
    ...extra,
  });

  const noteRow = (t: ReturnType<typeof setup>, noteId: string) =>
    t.run(async (ctx) =>
      ctx.db
        .query("notes")
        .filter((q) => q.eq(q.field("noteId"), noteId))
        .unique(),
    );

  test("a lock records whether it came from the note or its folder, and unlocking clears it", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "by-hand");
    await pushNote(as, "by-folder");
    await as.mutation(api.vault.lockNote, lockArgs("by-hand"));
    await as.mutation(api.vault.lockNote, lockArgs("by-folder", { origin: "folder" }));
    expect((await noteRow(t, "by-hand"))?.lockOrigin).toBe("note");
    expect((await noteRow(t, "by-folder"))?.lockOrigin).toBe("folder");

    await as.mutation(api.vault.unlockNote, {
      noteId: "by-folder",
      keyEpoch: 2,
      coversThroughSeq: 0,
      title: "もとのメモ",
      preview: null,
      snapshot: { payload: new Uint8Array(8).buffer, size: 8 },
      attachments: [],
      ts: stamp(3000),
    });
    expect((await noteRow(t, "by-folder"))?.lockOrigin).toBeUndefined();
  });

  test("more update rows than one swap can replace are refused before anything changes", async () => {
    const t = setup();
    const userId = await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "long");
    await t.run(async (ctx) => {
      for (let i = 0; i < 2001; i += 1) {
        await ctx.db.insert("noteUpdates", {
          userId,
          noteId: "long",
          opId: `u${i}`,
          deviceId: "device-1",
          keyEpoch: 0,
          payload: new Uint8Array(1).buffer,
          size: 1,
          seq: i + 10,
        });
      }
    });
    expect(await as.mutation(api.vault.lockNote, lockArgs("long"))).toEqual({
      status: "rejected",
      reason: "compactFirst",
    });
    expect((await noteRow(t, "long"))?.locked).toBe(false);
  });

  test("a lock that would leave a plaintext file behind is refused", async () => {
    const t = setup();
    const userId = await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "with-file");

    // An upload still under way.
    await as.mutation(api.attachments.reserve, {
      attachmentId: "pending",
      noteId: "with-file",
      bytes: 10,
      mime: "image/webp",
      name: "a.webp",
      width: null,
      height: null,
      locked: false,
      category: "image",
    });
    expect((await as.mutation(api.vault.lockNote, lockArgs("with-file"))).reason).toBe(
      "uploadPending",
    );

    // A stored file the lock does not replace.
    await t.run(async (ctx) => {
      const pending = await ctx.db
        .query("attachments")
        .filter((q) => q.eq(q.field("attachmentId"), "pending"))
        .unique();
      await ctx.db.delete(pending!._id);
      const storageId = await ctx.storage.store(new Blob(["plain"]));
      await ctx.db.insert("attachments", {
        userId,
        attachmentId: "stored",
        noteId: "with-file",
        status: "committed",
        storageId,
        reservedBytes: 0,
        bytes: 5,
        mime: "image/webp",
        name: "b.webp",
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
    expect((await as.mutation(api.vault.lockNote, lockArgs("with-file"))).reason).toBe(
      "attachmentsNotCovered",
    );
    expect((await noteRow(t, "with-file"))?.locked).toBe(false);
  });

  test("a locked note takes no plaintext upload", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "locked");
    await as.mutation(api.vault.lockNote, lockArgs("locked"));
    const result = await as.mutation(api.attachments.reserve, {
      attachmentId: "plain",
      noteId: "locked",
      bytes: 10,
      mime: "image/webp",
      name: "c.webp",
      width: null,
      height: null,
      locked: false,
      category: "image",
    });
    expect(result).toMatchObject({ status: "rejected", reason: "lockMismatch" });
  });

  test("a note created locked is stored locked, and takes only encrypted writes", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    const created = await pushNote(as, "born-locked", {
      create: {
        noteKind: "note",
        folderId: null,
        sortKey: "m",
        lock: { keyEpoch: 1, wrappedKey: sealed(), ts: stamp(1000) },
      },
      title: { value: null, sealed: sealed(), preview: null, ts: stamp(1000) },
    });
    expect(created.results[0]!.status).toBe("ok");
    const row = await noteRow(t, "born-locked");
    expect(row).toMatchObject({
      locked: true,
      keyEpoch: 1,
      lockOrigin: "folder",
      title: null,
      preview: null,
    });

    const writes = await as.mutation(api.sync.push, {
      deviceId: "device-1",
      ops: [
        {
          kind: "update",
          opId: "plain",
          noteId: "born-locked",
          keyEpoch: 1,
          payload: new Uint8Array(4).buffer,
        },
        {
          kind: "update",
          opId: "sealed",
          noteId: "born-locked",
          keyEpoch: 1,
          payload: new Uint8Array(4).buffer,
          iv: new Uint8Array(12).buffer,
        },
      ],
    });
    expect(writes.results.map((r) => r.status)).toEqual(["rejected", "ok"]);
  });

  test("a note cannot be created locked with a plaintext title or a bad epoch", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    const plainTitle = await pushNote(as, "leaky", {
      create: {
        noteKind: "note",
        folderId: null,
        sortKey: "m",
        lock: { keyEpoch: 1, wrappedKey: sealed(), ts: stamp(1000) },
      },
      title: { value: "読める題名", preview: null, ts: stamp(1000) },
    });
    expect(plainTitle.results[0]!.reason).toBe("plaintextIntoLockedNote");
    const badEpoch = await pushNote(as, "epoch0", {
      create: {
        noteKind: "note",
        folderId: null,
        sortKey: "m",
        lock: { keyEpoch: 0, wrappedKey: sealed(), ts: stamp(1000) },
      },
    });
    expect(badEpoch.results[0]!.reason).toBe("badEpoch");
    expect(await noteRow(t, "leaky")).toBeNull();
  });

  test("attachments of an unlocked note cannot be swapped as if it were locked", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });
    await pushNote(as, "open");
    expect(
      await as.mutation(api.vault.lockAttachments, { noteId: "open", attachments: [] }),
    ).toEqual({ status: "rejected", reason: "notLocked" });
  });
});
