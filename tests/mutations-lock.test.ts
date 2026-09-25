import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { VaultLockedError, prepareVault, vault } from "@/lib/crypto/vault";
import { db, resetLocalData } from "@/lib/db";
import { acquireDoc, flushAll, releaseDoc } from "@/lib/sync/docs";
import { createFolder, createNote, renameFolder } from "@/lib/sync/mutations";
import { FAST_ARGON, seedInbox } from "./helpers/seed";

beforeEach(async () => {
  await resetLocalData();
  await seedInbox();
  (await prepareVault("パスワード", FAST_ARGON)).adopt();
});

afterEach(() => vault.lock());

async function lockedFolder(name = "仕事") {
  const folderId = await createFolder({ parentId: null, name });
  await db().folders.update(folderId, { locked: true });
  return folderId;
}

describe("a note written in a locked folder", () => {
  test("is locked from the start: nothing of it is queued in plaintext", async () => {
    const work = await lockedFolder();
    const noteId = await createNote({ folderId: work, title: "秘密の題名" });

    expect(await db().notes.get(noteId)).toMatchObject({
      locked: true,
      keyEpoch: 1,
      lockOrigin: "folder",
      title: null,
      preview: null,
    });
    expect((await db().bodies.get(noteId))?.text).toBeNull();

    const ops = (await db().outbox.toArray()).filter((op) => op.entityId === noteId);
    expect(ops).toHaveLength(1);
    const payload = ops[0]!.payload as {
      create: { lock?: { keyEpoch: number } };
      title: { value: string | null; sealed?: unknown };
    };
    expect(payload.create.lock?.keyEpoch).toBe(1);
    expect(payload.title.value).toBeNull();
    expect(payload.title.sealed).toBeDefined();
    expect(JSON.stringify(ops)).not.toContain("秘密の題名");
  });

  test("so is a note in a subfolder of a locked folder", async () => {
    const work = await lockedFolder();
    const plans = await createFolder({ parentId: work, name: "企画" });
    const noteId = await createNote({ folderId: plans });
    expect((await db().notes.get(noteId))?.locked).toBe(true);
  });

  test("its first edit is stored encrypted", async () => {
    const work = await lockedFolder();
    const noteId = await createNote({ folderId: work });
    const doc = await acquireDoc(noteId);
    doc.getText("typed").insert(0, "最初の入力");
    await flushAll();
    await releaseDoc(noteId);
    const rows = await db().updates.where("noteId").equals(noteId).toArray();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.iv !== undefined && row.keyEpoch === 1)).toBe(true);
  });

  test("is not created at all while the vault is closed", async () => {
    const work = await lockedFolder();
    vault.lock();
    await expect(createNote({ folderId: work })).rejects.toBeInstanceOf(VaultLockedError);
    expect(await db().notes.filter((n) => n.folderId === work).count()).toBe(0);
  });

  test("elsewhere, notes stay ordinary", async () => {
    const home = await createFolder({ parentId: null, name: "家" });
    const noteId = await createNote({ folderId: home });
    expect((await db().notes.get(noteId))?.locked).toBe(false);
  });
});

describe("folder names", () => {
  test("a locked folder is renamed in plaintext", async () => {
    const work = await lockedFolder();
    await renameFolder(work, "新しい名前");
    const folder = await db().folders.get(work);
    expect(folder?.name).toBe("新しい名前");
    expect(folder?.nameSealed).toBeUndefined();
  });
});
