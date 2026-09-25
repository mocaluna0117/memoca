import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { toArrayBuffer } from "@/lib/bytes";
import { ctx } from "@/lib/crypto/context";
import { importAesKey, randomBytes, seal } from "@/lib/crypto/primitives";
import { prepareVault, vault } from "@/lib/crypto/vault";
import { db, resetLocalData } from "@/lib/db";
import type { Folder } from "@/lib/types";
import { readVaultHealth, unsealFolderNames } from "@/lib/vault/reconcile";
import { FAST_ARGON, zero } from "./helpers/seed";

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
