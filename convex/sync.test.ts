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
const DEVICE_1 = "device-1";
const DEVICE_2 = "device-2";

function setup() {
  return convexTest(schema, modules);
}

async function seedUser(
  t: ReturnType<typeof setup>,
  authId: string,
  quotaBytes = 10_000_000,
): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      authId,
      email: `${authId}@example.com`,
      role: "user",
      quotaBytes,
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

const stamp = (t: number, d: string) => ({ t, d });

type Caller = Pick<ReturnType<typeof setup>, "query" | "mutation">;

/** Reads a pull batch, asserting the caller is recognised. */
async function pull(as: Caller, args: { since: number; limit?: number }) {
  const batch = await as.query(api.sync.pull, args);
  expect(batch, "pull should be authenticated").not.toBeNull();
  return batch!;
}

const folderOp = (
  opId: string,
  folderId: string,
  extra: Record<string, unknown> = {},
) => ({
  kind: "folder" as const,
  opId,
  folderId,
  create: { parentId: null, sortKey: "m", system: null },
  ...extra,
});

const noteOp = (opId: string, noteId: string, extra: Record<string, unknown> = {}) => ({
  kind: "note" as const,
  opId,
  noteId,
  create: { noteKind: "note" as const, folderId: null, sortKey: "m" },
  ...extra,
});

describe("authorisation", () => {
  test("pull tells a signed-out client to wait instead of failing", async () => {
    const t = setup();
    // It must not throw: this subscription is live from the moment the app
    // starts, including before an auth token has attached.
    expect(await t.query(api.sync.pull, { since: 0 })).toBeNull();
  });

  test("one user never sees another user's rows", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    await seedUser(t, AUTH_B);

    const asA = t.withIdentity({ subject: AUTH_A });
    const asB = t.withIdentity({ subject: AUTH_B });

    await asA.mutation(api.sync.push, {
      deviceId: DEVICE_1,
      ops: [
        folderOp("op-1", "folder-a", {
          name: { value: "A の秘密", icon: null, ts: stamp(1000, DEVICE_1) },
        }),
      ],
    });

    const seenByB = await pull(asB, { since: 0 });
    expect(seenByB.folders).toHaveLength(0);

    const seenByA = await pull(asA, { since: 0 });
    expect(seenByA.folders).toHaveLength(1);
    expect(seenByA.folders[0]!.name).toBe("A の秘密");
  });
});

describe("last-writer-wins", () => {
  test("a rename on one device and a move on another both survive", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });

    await as.mutation(api.sync.push, {
      deviceId: DEVICE_1,
      ops: [
        folderOp("create-parent", "parent"),
        folderOp("create-child", "child", {
          name: { value: "もとの名前", icon: null, ts: stamp(1000, DEVICE_1) },
        }),
      ],
    });

    // Device 1 renames; device 2, offline at the time, moves it.
    await as.mutation(api.sync.push, {
      deviceId: DEVICE_1,
      ops: [
        {
          kind: "folder",
          opId: "rename",
          folderId: "child",
          name: { value: "新しい名前", icon: null, ts: stamp(2000, DEVICE_1) },
        },
      ],
    });
    await as.mutation(api.sync.push, {
      deviceId: DEVICE_2,
      ops: [
        {
          kind: "folder",
          opId: "move",
          folderId: "child",
          place: { parentId: "parent", sortKey: "z", ts: stamp(1500, DEVICE_2) },
        },
      ],
    });

    const { folders } = await pull(as, { since: 0 });
    const child = folders.find((f) => f.folderId === "child")!;
    expect(child.name).toBe("新しい名前");
    expect(child.parentId).toBe("parent");
  });

  test("an older stamp does not overwrite a newer value", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });

    await as.mutation(api.sync.push, {
      deviceId: DEVICE_1,
      ops: [
        folderOp("create", "f1", {
          name: { value: "新しい", icon: null, ts: stamp(5000, DEVICE_1) },
        }),
      ],
    });
    await as.mutation(api.sync.push, {
      deviceId: DEVICE_2,
      ops: [
        {
          kind: "folder",
          opId: "stale",
          folderId: "f1",
          name: { value: "古い", icon: null, ts: stamp(1000, DEVICE_2) },
        },
      ],
    });

    const { folders } = await pull(as, { since: 0 });
    expect(folders[0]!.name).toBe("新しい");
  });

  test("a stamp from the future is rejected rather than winning forever", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });

    await as.mutation(api.sync.push, { deviceId: DEVICE_1, ops: [folderOp("c", "f1")] });
    const res = await as.mutation(api.sync.push, {
      deviceId: DEVICE_2,
      ops: [
        {
          kind: "folder",
          opId: "skewed",
          folderId: "f1",
          name: {
            value: "壊れた時計",
            icon: null,
            ts: stamp(Date.now() + 10 * 60_000, DEVICE_2),
          },
        },
      ],
    });
    expect(res.results[0]!.status).toBe("rejected");
    expect(res.results[0]!.reason).toBe("clockSkew");
  });
});

describe("push", () => {
  test("replaying a batch does not duplicate Yjs updates", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });

    await as.mutation(api.sync.push, { deviceId: DEVICE_1, ops: [noteOp("n", "note-1")] });

    const update = {
      kind: "update" as const,
      opId: "update-1",
      noteId: "note-1",
      keyEpoch: 0,
      payload: new Uint8Array([1, 2, 3, 4]).buffer,
    };
    await as.mutation(api.sync.push, { deviceId: DEVICE_1, ops: [update] });
    const second = await as.mutation(api.sync.push, { deviceId: DEVICE_1, ops: [update] });

    expect(second.results[0]!.status).toBe("ok");
    const { updates } = await pull(as, { since: 0 });
    expect(updates).toHaveLength(1);
  });

  test("one rejected operation does not roll back the rest of the batch", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });

    const res = await as.mutation(api.sync.push, {
      deviceId: DEVICE_1,
      ops: [
        folderOp("good", "f-ok"),
        {
          kind: "update",
          opId: "orphan-update",
          noteId: "does-not-exist",
          keyEpoch: 0,
          payload: new Uint8Array([9]).buffer,
        },
        folderOp("good-2", "f-ok-2"),
      ],
    });

    expect(res.results.map((r) => r.status)).toEqual(["ok", "rejected", "ok"]);
    const { folders } = await pull(as, { since: 0 });
    expect(folders.map((f) => f.folderId).sort()).toEqual(["f-ok", "f-ok-2"]);
  });

  test("writing past the quota is refused", async () => {
    const t = setup();
    await seedUser(t, AUTH_A, 100);
    const as = t.withIdentity({ subject: AUTH_A });

    await as.mutation(api.sync.push, { deviceId: DEVICE_1, ops: [noteOp("n", "note-1")] });
    const res = await as.mutation(api.sync.push, {
      deviceId: DEVICE_1,
      ops: [
        {
          kind: "update",
          opId: "big",
          noteId: "note-1",
          keyEpoch: 0,
          payload: new Uint8Array(500).buffer,
        },
      ],
    });
    expect(res.results[0]!.reason).toBe("quotaExceeded");
  });

  test("two devices moving folders under each other cannot make a cycle", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });

    await as.mutation(api.sync.push, {
      deviceId: DEVICE_1,
      ops: [folderOp("a", "f1"), folderOp("b", "f2")],
    });
    await as.mutation(api.sync.push, {
      deviceId: DEVICE_1,
      ops: [
        {
          kind: "folder",
          opId: "m1",
          folderId: "f1",
          place: { parentId: "f2", sortKey: "m", ts: stamp(2000, DEVICE_1) },
        },
      ],
    });
    await as.mutation(api.sync.push, {
      deviceId: DEVICE_2,
      ops: [
        {
          kind: "folder",
          opId: "m2",
          folderId: "f2",
          place: { parentId: "f1", sortKey: "m", ts: stamp(3000, DEVICE_2) },
        },
      ],
    });

    const { folders } = await pull(as, { since: 0 });
    const parents = Object.fromEntries(folders.map((f) => [f.folderId, f.parentId]));
    // Whichever way it resolves, following parents must terminate.
    let node: string | null = "f1";
    for (let i = 0; i < 10 && node; i += 1) node = parents[node] ?? null;
    expect(node).toBeNull();
  });
});

describe("pull cursor", () => {
  test("the cursor stops at the lowest full page so no table is skipped", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });

    // Five folders, then a note: with a page limit of 2 the folder page fills
    // first and the note sits above the cursor.
    await as.mutation(api.sync.push, {
      deviceId: DEVICE_1,
      ops: [
        folderOp("f1", "f1"),
        folderOp("f2", "f2"),
        folderOp("f3", "f3"),
        folderOp("f4", "f4"),
        folderOp("f5", "f5"),
        noteOp("n1", "n1"),
      ],
    });

    const first = await pull(as, { since: 0, limit: 2 });
    expect(first.folders).toHaveLength(2);
    expect(first.notes).toHaveLength(0);
    expect(first.complete).toBe(false);

    let cursor = first.cursor;
    const seenFolders = new Set(first.folders.map((f) => f.folderId));
    const seenNotes = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      const page = await pull(as, { since: cursor, limit: 2 });
      for (const f of page.folders) seenFolders.add(f.folderId);
      for (const n of page.notes) seenNotes.add(n.noteId);
      cursor = page.cursor;
      if (page.complete) break;
    }

    expect([...seenFolders].sort()).toEqual(["f1", "f2", "f3", "f4", "f5"]);
    expect([...seenNotes]).toEqual(["n1"]);
  });
});

describe("compaction", () => {
  test("a snapshot replaces the updates it covers, and lagging devices refetch", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });

    await as.mutation(api.sync.push, { deviceId: DEVICE_1, ops: [noteOp("n", "note-1")] });
    for (let i = 0; i < 3; i += 1) {
      await as.mutation(api.sync.push, {
        deviceId: DEVICE_1,
        ops: [
          {
            kind: "update",
            opId: `u${i}`,
            noteId: "note-1",
            keyEpoch: 0,
            payload: new Uint8Array([i]).buffer,
          },
        ],
      });
    }

    // A second device that is still behind, before compaction happens.
    const behind = await pull(as, { since: 0 });
    expect(behind.updates).toHaveLength(3);
    const lastUpdateSeq = Math.max(...behind.updates.map((u) => u.seq));

    const compacted = await as.mutation(api.notes.compact, {
      noteId: "note-1",
      keyEpoch: 0,
      coversThroughSeq: lastUpdateSeq,
      payload: new Uint8Array([7, 7, 7]).buffer,
      size: 3,
    });
    expect(compacted.status).toBe("ok");

    const after = await pull(as, { since: 0 });
    expect(after.updates).toHaveLength(0);
    expect(after.snapshots).toHaveLength(1);
    expect(after.snapshots[0]!.coversThroughSeq).toBe(lastUpdateSeq);

    // A device that had nothing gets the snapshot body.
    const fresh = await as.query(api.notes.getBodies, {
      items: [{ noteId: "note-1", haveThroughSeq: 0 }],
    });
    expect(fresh.bodies[0]!.snapshot).not.toBeNull();

    // A device already at the snapshot does not pay for it again.
    const current = await as.query(api.notes.getBodies, {
      items: [{ noteId: "note-1", haveThroughSeq: lastUpdateSeq }],
    });
    expect(current.bodies[0]!.snapshot).toBeNull();
    expect(current.bodies[0]!.updates).toHaveLength(0);
  });

  test("compacting without having seen the newest update is refused", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });

    await as.mutation(api.sync.push, { deviceId: DEVICE_1, ops: [noteOp("n", "note-1")] });
    await as.mutation(api.sync.push, {
      deviceId: DEVICE_1,
      ops: [
        {
          kind: "update",
          opId: "u0",
          noteId: "note-1",
          keyEpoch: 0,
          payload: new Uint8Array([1]).buffer,
        },
      ],
    });
    const { updates } = await pull(as, { since: 0 });
    const seq = updates[0]!.seq;

    // Another update lands while this client was preparing its snapshot.
    await as.mutation(api.sync.push, {
      deviceId: DEVICE_2,
      ops: [
        {
          kind: "update",
          opId: "u1",
          noteId: "note-1",
          keyEpoch: 0,
          payload: new Uint8Array([2]).buffer,
        },
      ],
    });

    const res = await as.mutation(api.notes.compact, {
      noteId: "note-1",
      keyEpoch: 0,
      coversThroughSeq: seq,
      payload: new Uint8Array([9]).buffer,
      size: 1,
    });
    expect(res.status).toBe("rejected");
    expect(res.reason).toBe("behind");

    // Nothing was lost.
    const after = await pull(as, { since: 0 });
    expect(after.updates).toHaveLength(2);
  });
});

describe("vault", () => {
  test("locking removes the plaintext body and rejects later plaintext writes", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });

    await as.mutation(api.sync.push, {
      deviceId: DEVICE_1,
      ops: [
        noteOp("n", "note-1", {
          title: { value: "秘密のメモ", preview: "本文", ts: stamp(1000, DEVICE_1) },
        }),
      ],
    });
    await as.mutation(api.sync.push, {
      deviceId: DEVICE_1,
      ops: [
        {
          kind: "update",
          opId: "u0",
          noteId: "note-1",
          keyEpoch: 0,
          payload: new TextEncoder().encode("読めてしまう平文").buffer as ArrayBuffer,
        },
      ],
    });

    const before = await pull(as, { since: 0 });
    const lastUpdateSeq = before.updates[0]!.seq;

    const locked = await as.mutation(api.vault.lockNote, {
      noteId: "note-1",
      keyEpoch: 1,
      coversThroughSeq: lastUpdateSeq,
      wrappedKey: { ct: new Uint8Array(48).buffer, iv: new Uint8Array(12).buffer },
      titleSealed: { ct: new Uint8Array(32).buffer, iv: new Uint8Array(12).buffer },
      snapshot: { payload: new Uint8Array(64).buffer, size: 64, iv: new Uint8Array(12).buffer },
      attachments: [],
      ts: stamp(2000, DEVICE_1),
    });
    expect(locked.status).toBe("ok");

    const after = await pull(as, { since: 0 });
    const note = after.notes.find((n) => n.noteId === "note-1")!;
    expect(note.locked).toBe(true);
    expect(note.title).toBeNull();
    expect(note.preview).toBeNull();
    expect(note.keyEpoch).toBe(1);
    // Every plaintext Yjs update is gone from the server.
    expect(after.updates).toHaveLength(0);

    // A device that had not noticed the lock cannot write plaintext afterwards.
    const stale = await as.mutation(api.sync.push, {
      deviceId: DEVICE_2,
      ops: [
        {
          kind: "update",
          opId: "stale-plaintext",
          noteId: "note-1",
          keyEpoch: 0,
          payload: new TextEncoder().encode("まだ平文").buffer as ArrayBuffer,
        },
      ],
    });
    expect(stale.results[0]!.reason).toBe("epochMismatch");
  });

  test("unlocking restores the title and clears the wrapped key", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    const as = t.withIdentity({ subject: AUTH_A });

    await as.mutation(api.sync.push, { deviceId: DEVICE_1, ops: [noteOp("n", "note-1")] });
    await as.mutation(api.vault.lockNote, {
      noteId: "note-1",
      keyEpoch: 1,
      coversThroughSeq: 0,
      wrappedKey: { ct: new Uint8Array(48).buffer, iv: new Uint8Array(12).buffer },
      titleSealed: { ct: new Uint8Array(32).buffer, iv: new Uint8Array(12).buffer },
      snapshot: { payload: new Uint8Array(8).buffer, size: 8, iv: new Uint8Array(12).buffer },
      attachments: [],
      ts: stamp(2000, DEVICE_1),
    });

    const res = await as.mutation(api.vault.unlockNote, {
      noteId: "note-1",
      keyEpoch: 2,
      coversThroughSeq: 0,
      title: "もう秘密ではない",
      preview: "本文",
      snapshot: { payload: new Uint8Array(8).buffer, size: 8 },
      attachments: [],
      ts: stamp(3000, DEVICE_1),
    });
    expect(res.status).toBe("ok");

    const after = await pull(as, { since: 0 });
    const note = after.notes.find((n) => n.noteId === "note-1")!;
    expect(note.locked).toBe(false);
    expect(note.title).toBe("もう秘密ではない");
    expect(note.wrappedKey).toBeUndefined();
  });
});

describe("admin access", () => {
  test("ADMIN_EMAILS grants access to an account created before it was set", async () => {
    const t = setup();
    // The stored role is written once, at sign-up. An operator who names their
    // address afterwards must still get in, otherwise there is no way back
    // into the admin screen short of editing the database.
    await t.run(async (ctx) =>
      ctx.db.insert("users", {
        authId: AUTH_A,
        email: "operator@example.com",
        role: "user",
        quotaBytes: 100,
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
    const as = t.withIdentity({ subject: AUTH_A });

    process.env.ADMIN_EMAILS = "";
    await expect(as.query(api.admin.overview, {})).rejects.toThrow();

    process.env.ADMIN_EMAILS = "Operator@Example.com";
    const overview = await as.query(api.admin.overview, {});
    expect(overview.config.maxUsers).toBeGreaterThan(0);
    expect((await as.query(api.users.me, {}))?.role).toBe("admin");
  });

  test("a plain account is refused", async () => {
    const t = setup();
    process.env.ADMIN_EMAILS = "someone-else@example.com";
    await seedUser(t, AUTH_B);
    const as = t.withIdentity({ subject: AUTH_B });
    await expect(as.query(api.admin.overview, {})).rejects.toThrow();
  });
});

describe("token issuer", () => {
  /** What convex-test stamps on an identity when none is given. */
  const TEST_ISSUER = "https://convex.test";

  test("a token from the expected issuer is accepted", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    process.env.CONVEX_SITE_URL = TEST_ISSUER;
    try {
      const as = t.withIdentity({ subject: AUTH_A, issuer: TEST_ISSUER });
      expect(await pull(as, { since: 0 })).not.toBeNull();
    } finally {
      delete process.env.CONVEX_SITE_URL;
    }
  });

  test("a token from another issuer cannot claim the same subject", async () => {
    const t = setup();
    await seedUser(t, AUTH_A);
    // `subject` is only unique within an issuer. A second provider whose
    // subjects are user-chosen would otherwise let anyone register this id and
    // read the victim's notes.
    process.env.CONVEX_SITE_URL = "https://memoca.convex.site";
    try {
      const impostor = t.withIdentity({
        subject: AUTH_A,
        issuer: "https://attacker.example.com",
      });
      expect(await impostor.query(api.sync.pull, { since: 0 })).toBeNull();
      await expect(
        impostor.mutation(api.sync.push, { deviceId: DEVICE_1, ops: [] }),
      ).rejects.toThrow();
    } finally {
      delete process.env.CONVEX_SITE_URL;
    }
  });
});
