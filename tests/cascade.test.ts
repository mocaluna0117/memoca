import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { prepareVault, vault } from "@/lib/crypto/vault";
import { db, getMeta, resetLocalData } from "@/lib/db";
import { META } from "@/lib/db/meta";
import { createFolder, createNote } from "@/lib/sync/mutations";
import { lockFolder, lockUncovered, resumeUnlockJob, unlockFolder } from "@/lib/vault/cascade";
import { fakeConvex } from "./helpers/fake-convex";
import { FAST_ARGON, seedInbox } from "./helpers/seed";

beforeEach(async () => {
  await resetLocalData();
  await seedInbox();
  (await prepareVault("パスワード", FAST_ARGON)).adopt();
});

afterEach(() => vault.lock());

/** A file in the upload queue; jsdom's Blob does not survive fake-indexeddb, so a stand-in. */
const waitingUpload = (attachmentId: string, noteId: string, locked: boolean) => ({
  attachmentId,
  noteId,
  blob: { size: 10, type: "image/webp" } as unknown as Blob,
  mime: "image/webp",
  name: "a.webp",
  width: null,
  height: null,
  category: "image" as const,
  locked,
  createdAt: 0,
});

/** A server that accepts everything, recording what it was asked. */
function acceptingServer() {
  return fakeConvex({
    "vault:setFolderLock": () => ({ status: "ok" }),
    "vault:lockNote": () => ({ status: "ok" }),
    "vault:unlockNote": () => ({ status: "ok" }),
    "attachments:urls": () => ({}),
  });
}

describe("locking a folder", () => {
  test("sets the folder's flag first, then locks every plaintext note inside", async () => {
    const server = acceptingServer();
    const work = await createFolder({ parentId: null, name: "仕事" });
    const plans = await createFolder({ parentId: work, name: "企画" });
    const a = await createNote({ folderId: work, title: "A" });
    const b = await createNote({ folderId: plans, title: "B" });
    const outside = await createNote({ folderId: null, title: "外" });

    const result = await lockFolder(server.client, null, work);
    expect(result).toMatchObject({ total: 2, done: 2, pending: [] });
    expect(server.calls[0]!.name).toBe("vault:setFolderLock");
    expect(server.callsTo("vault:lockNote").map((c) => c.args.noteId).sort()).toEqual([a, b].sort());
    expect(server.callsTo("vault:lockNote").every((c) => c.args.origin === "folder")).toBe(true);
    expect((await db().notes.get(a))).toMatchObject({ locked: true, lockOrigin: "folder", title: null });
    expect((await db().notes.get(outside))?.locked).toBe(false);
    expect((await db().folders.get(work))?.locked).toBe(true);
  });

  test("says what it could not do, instead of claiming success", async () => {
    const server = fakeConvex({
      "vault:setFolderLock": () => ({ status: "ok" }),
      "vault:lockNote": () => ({ status: "rejected", reason: "snapshotTooLargeInline" }),
      "attachments:urls": () => ({}),
    });
    const work = await createFolder({ parentId: null, name: "仕事" });
    await createNote({ folderId: work, title: "A" });
    const result = await lockFolder(server.client, null, work);
    expect(result.done).toBe(0);
    expect(result.pending).toEqual([expect.objectContaining({ reason: "snapshotTooLargeInline" })]);
  });

  test("retries a note that was only waiting for sync", async () => {
    let first = true;
    const server = fakeConvex({
      "vault:setFolderLock": () => ({ status: "ok" }),
      "vault:lockNote": () => {
        if (first) {
          first = false;
          return { status: "rejected", reason: "behind" };
        }
        return { status: "ok" };
      },
      "attachments:urls": () => ({}),
    });
    const work = await createFolder({ parentId: null, name: "仕事" });
    await createNote({ folderId: work, title: "A" });
    // Already pushed: with no sync engine here, nothing else would send it.
    await db().outbox.clear();
    const result = await lockFolder(server.client, null, work);
    expect(result).toMatchObject({ done: 1, pending: [] });
    expect(server.callsTo("vault:lockNote")).toHaveLength(2);
  });

  test("waits for a note's plain files to finish uploading before asking again", async () => {
    const seen: number[] = [];
    const server = fakeConvex({
      "vault:setFolderLock": () => ({ status: "ok" }),
      "vault:lockNote": async () => {
        seen.push(await db().pendingUploads.count());
        if (seen.length > 1) return { status: "ok" };
        // Uploaded a moment later.
        setTimeout(() => void db().pendingUploads.clear(), 600);
        return { status: "rejected", reason: "uploadPending" };
      },
      "attachments:urls": () => ({}),
    });
    const work = await createFolder({ parentId: null, name: "仕事" });
    const noteId = await createNote({ folderId: work, title: "A" });
    await db().outbox.clear();
    await db().pendingUploads.put(waitingUpload("plain", noteId, false));

    expect(await lockFolder(server.client, null, work)).toMatchObject({ done: 1, pending: [] });
    expect(seen).toEqual([1, 0]);
  });

  test("an encrypted file on its way does not hold the next try up", async () => {
    const seen: number[] = [];
    const server = fakeConvex({
      "vault:setFolderLock": () => ({ status: "ok" }),
      "vault:lockNote": async () => {
        seen.push(await db().pendingUploads.count());
        return seen.length > 1 ? { status: "ok" } : { status: "rejected", reason: "behind" };
      },
      "attachments:urls": () => ({}),
    });
    const work = await createFolder({ parentId: null, name: "仕事" });
    const noteId = await createNote({ folderId: work, title: "A" });
    await db().outbox.clear();
    // A copy a lock made, still to go up: the server does not wait for it.
    await db().pendingUploads.put(waitingUpload("copy", noteId, true));

    const started = Date.now();
    expect(await lockFolder(server.client, null, work)).toMatchObject({ done: 1, pending: [] });
    expect(seen).toEqual([1, 1]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("stops cleanly when the vault closes part way", async () => {
    const server = acceptingServer();
    const work = await createFolder({ parentId: null, name: "仕事" });
    await createNote({ folderId: work, title: "A" });
    await createNote({ folderId: work, title: "B" });
    server.handlers["vault:lockNote"] = () => {
      vault.lock();
      return { status: "ok" };
    };
    const result = await lockFolder(server.client, null, work);
    expect(result.aborted).toBe("vaultClosed");
    expect(result.done).toBe(1);
    expect(result.pending).toHaveLength(1);
  });
});

describe("taking a folder's lock off", () => {
  test("waits for every file of a note on its way, encrypted ones too", async () => {
    const server = acceptingServer();
    const work = await createFolder({ parentId: null, name: "仕事" });
    const noteId = await createNote({ folderId: work, title: "A" });
    await db().outbox.clear();
    await lockFolder(server.client, null, work);
    await db().outbox.clear();
    await db().pendingUploads.put(waitingUpload("copy", noteId, true));
    setTimeout(() => void db().pendingUploads.clear(), 600);

    expect(await unlockFolder(server.client, null, work)).toMatchObject({ done: 1, pending: [] });
    expect(server.callsTo("vault:unlockNote")).toHaveLength(1);
    expect(await db().pendingUploads.count()).toBe(0);
  });

  test("keeps notes locked by hand, and unlocks only what the folder locked", async () => {
    const server = acceptingServer();
    const work = await createFolder({ parentId: null, name: "仕事" });
    const byHand = await createNote({ folderId: work, title: "自分で" });
    const byFolder = await createNote({ folderId: work, title: "フォルダで" });
    await lockFolder(server.client, null, work);
    await db().notes.update(byHand, { lockOrigin: "note" });

    const result = await unlockFolder(server.client, null, work);
    expect(result).toMatchObject({ total: 1, done: 1, kept: 1, pending: [] });
    expect(server.callsTo("vault:unlockNote").map((c) => c.args.noteId)).toEqual([byFolder]);
    expect((await db().notes.get(byHand))?.locked).toBe(true);
    expect((await db().notes.get(byFolder))?.locked).toBe(false);
    // Finished, so nothing is left to resume.
    expect(await getMeta(META.unlockJob, null)).toBeNull();
  });

  test("remembers what it could not finish, and resumes it later", async () => {
    const server = acceptingServer();
    const work = await createFolder({ parentId: null, name: "仕事" });
    const note = await createNote({ folderId: work, title: "A" });
    await lockFolder(server.client, null, work);

    server.handlers["vault:unlockNote"] = () => ({ status: "rejected", reason: "serverBusy" });
    const partial = await unlockFolder(server.client, null, work);
    expect(partial.pending).toHaveLength(1);
    expect(await getMeta<{ noteIds: string[] }>(META.unlockJob, { noteIds: [] })).toMatchObject({
      noteIds: [note],
    });

    server.handlers["vault:unlockNote"] = () => ({ status: "ok" });
    const resumed = await resumeUnlockJob(server.client, null);
    expect(resumed).toMatchObject({ done: 1, pending: [] });
    expect((await db().notes.get(note))?.locked).toBe(false);
    expect(await getMeta(META.unlockJob, null)).toBeNull();
  });
});

describe("the repair pass", () => {
  test("locks plaintext notes found inside a locked folder", async () => {
    const server = acceptingServer();
    const work = await createFolder({ parentId: null, name: "仕事" });
    await lockFolder(server.client, null, work);
    // Written on a device that did not know about the lock yet.
    const late = await createNote({ folderId: work, title: "あとから" });
    await db().notes.update(late, { locked: false });

    expect(await lockUncovered(server.client, null)).toBe(1);
    expect((await db().notes.get(late))?.locked).toBe(true);
  });
});
