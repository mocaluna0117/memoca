import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { toArrayBuffer } from "@/lib/bytes";
import { ctx } from "@/lib/crypto/context";
import { importAesKey, randomBytes, seal } from "@/lib/crypto/primitives";
import { prepareVault, vault } from "@/lib/crypto/vault";
import { db, resetLocalData } from "@/lib/db";
import type { Folder } from "@/lib/types";
import {
  checkVaultHealth,
  clearInboxLock,
  lockPlaintextAttachments,
  readVaultHealth,
  unsealFolderNames,
} from "@/lib/vault/reconcile";
import { purgeLockedBlobs } from "@/lib/media/attachments";
import { createNote } from "@/lib/sync/mutations";
import type { Attachment } from "@/lib/types";
import { fakeConvex } from "./helpers/fake-convex";
import { FAST_ARGON, seedInbox, zero } from "./helpers/seed";

let raw: Uint8Array;

beforeEach(async () => {
  await resetLocalData();
  const prepared = await prepareVault("パスワード", FAST_ARGON, { keepRaw: true });
  raw = prepared.takeRaw()!;
  prepared.adopt();
});

afterEach(() => vault.lock());

/** A locked folder as an earlier version left it: only a sealed name. */
async function sealedFolder(folderId: string, name: string, key: Uint8Array = raw) {
  const sealed = await seal(await importAesKey(key), new TextEncoder().encode(name), ctx.folderName(folderId));
  const folder: Folder = {
    folderId,
    parentId: null,
    name: null,
    nameSealed: { ct: toArrayBuffer(sealed.ct), iv: toArrayBuffer(sealed.iv) },
    icon: null,
    sortKey: "b",
    locked: true,
    system: null,
    deletedAt: null,
    purged: false,
    ts: { name: zero, place: zero, trash: zero, lock: zero },
    seq: 1,
  };
  await db().folders.put(folder);
}

describe("folder names sealed by an earlier version", () => {
  test("come back as plaintext and sync as an ordinary rename", async () => {
    await sealedFolder("work", "仕事");
    expect(await unsealFolderNames()).toBe(1);

    const folder = await db().folders.get("work");
    expect(folder?.name).toBe("仕事");
    expect(folder?.nameSealed).toBeUndefined();
    expect(folder?.locked).toBe(true);
    const ops = await db().outbox.toArray();
    expect(ops.map((op) => (op.payload as { name?: { value: string } }).name?.value)).toContain("仕事");
  });

  test("a name the key cannot open is left alone and recorded", async () => {
    await sealedFolder("other", "他人の鍵", randomBytes(32));
    expect(await unsealFolderNames()).toBe(0);
    expect((await db().folders.get("other"))?.nameSealed).toBeDefined();
    expect((await readVaultHealth())?.unreadableFolders).toEqual(["other"]);
  });

  test("nothing happens while the vault is closed", async () => {
    await sealedFolder("work", "仕事");
    vault.lock();
    expect(await unsealFolderNames()).toBe(0);
    expect((await db().folders.get("work"))?.name).toBeNull();
  });
});

const attachment = (attachmentId: string, noteId: string, over: Partial<Attachment> = {}): Attachment => ({
  attachmentId,
  noteId,
  status: "committed",
  bytes: 5,
  mime: "image/webp",
  name: `${attachmentId}.webp`,
  locked: false,
  width: null,
  height: null,
  deletedAt: null,
  seq: 1,
  ...over,
});

describe("repairs", () => {
  test("Inbox's old lock flag comes off", async () => {
    await seedInbox();
    await db().folders.update("inbox", { locked: true });
    const server = fakeConvex({ "vault:setFolderLock": () => ({ status: "ok" }) });
    expect(await clearInboxLock(server.client)).toBe(true);
    expect(server.callsTo("vault:setFolderLock")[0]!.args).toMatchObject({ folderId: "inbox", locked: false });
    expect((await db().folders.get("inbox"))?.locked).toBe(false);
    // Nothing to do the second time.
    expect(await clearInboxLock(server.client)).toBe(false);
  });

  test("a locked note whose key this vault cannot open is recorded, not deleted", async () => {
    await seedInbox();
    const mine = await createNote({ folderId: null });
    const { wrapped } = await vault.createNoteKey(mine, 1);
    await db().notes.update(mine, { locked: true, keyEpoch: 1, wrappedKey: wrapped });
    const foreign = await createNote({ folderId: null });
    await db().notes.update(foreign, {
      locked: true,
      keyEpoch: 1,
      wrappedKey: { ct: toArrayBuffer(randomBytes(48)), iv: toArrayBuffer(randomBytes(12)) },
    });

    const health = await checkVaultHealth();
    expect(health?.unreadableNotes).toEqual([foreign]);
    expect(await db().notes.get(foreign)).toBeDefined();
  });

  test("plaintext copies of a locked note's files leave the device cache", async () => {
    await seedInbox();
    const locked = await createNote({ folderId: null });
    const plain = await createNote({ folderId: null });
    await db().notes.update(locked, { locked: true });
    await db().attachments.bulkPut([attachment("secret", locked), attachment("open", plain)]);
    const blob = (id: string) => ({ attachmentId: id, blob: new Blob(["x"]), bytes: 1, lastUsed: 0 });
    await db().blobs.bulkPut([blob("secret"), blob("open")]);

    const purge = vi.fn(async () => true);
    vi.stubGlobal("caches", { delete: purge });
    try {
      expect(await purgeLockedBlobs()).toBe(1);
      // The service worker's own copies go too.
      expect(purge).toHaveBeenCalledWith("memoca-media");
      purge.mockClear();
      expect(await purgeLockedBlobs()).toBe(0);
      expect(purge).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(await db().blobs.get("secret")).toBeUndefined();
    expect(await db().blobs.get("open")).toBeDefined();
  });

  test("plaintext files left on a locked note are encrypted and swapped in", async () => {
    await seedInbox();
    const noteId = await createNote({ folderId: null });
    await db().notes.update(noteId, { locked: true });
    await db().attachments.put(attachment("left", noteId));
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ storageId: "stored-1" }))
        : new Response(new Uint8Array([1, 2, 3])),
    );
    vi.stubGlobal("fetch", fetchMock);
    const purge = vi.fn(async () => true);
    vi.stubGlobal("caches", { delete: purge });
    const server = fakeConvex({
      "attachments:urls": () => ({ left: "https://files.example/left" }),
      "notes:snapshotUploadUrl": () => "https://upload.example",
      "vault:lockAttachments": () => ({ status: "ok" }),
    });
    try {
      expect(await lockPlaintextAttachments(server.client)).toBe(1);
      expect(purge).toHaveBeenCalledWith("memoca-media");
    } finally {
      vi.unstubAllGlobals();
    }
    // Read for sealing only: the browser is not to keep the plaintext.
    const download = fetchMock.mock.calls.find(([, init]) => init?.method !== "POST")!;
    expect(download[1]).toMatchObject({ cache: "no-store" });
    const swap = server.callsTo("vault:lockAttachments")[0]!.args as {
      noteId: string;
      attachments: { attachmentId: string; wrappedKey?: unknown; contentIv?: unknown }[];
    };
    expect(swap.noteId).toBe(noteId);
    expect(swap.attachments[0]).toMatchObject({ attachmentId: "left", storageId: "stored-1" });
    expect(swap.attachments[0]!.wrappedKey).toBeDefined();
    // What was uploaded is not the plaintext.
    const uploaded = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body as Blob;
    expect(new Uint8Array(await uploaded.arrayBuffer())).not.toEqual(new Uint8Array([1, 2, 3]));
  });
});
