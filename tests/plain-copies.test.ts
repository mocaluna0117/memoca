import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { toArrayBuffer } from "@/lib/bytes";
import { ctx } from "@/lib/crypto/context";
import { seal } from "@/lib/crypto/primitives";
import { prepareVault, vault } from "@/lib/crypto/vault";
import { db, resetLocalData, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import { flushUploads, refFor, revokeResolvedUrls } from "@/lib/media/attachments";
import { forgetRelockState, plainCopies } from "@/lib/media/relock-copies";
import { acquireDoc, releaseDoc, withDetachedDoc } from "@/lib/sync/docs";
import { createFolder, createNote } from "@/lib/sync/mutations";
import { FRAGMENT, attachmentRefs } from "@/lib/sync/ydoc";
import { plainCopiedFiles, repairLocks } from "@/lib/vault/reconcile";
import type { Attachment, Note } from "@/lib/types";
import { fakeConvex } from "./helpers/fake-convex";
import { FAST_ARGON, seedInbox, zero } from "./helpers/seed";

// jsdom has no object URLs: each one made is remembered, so that fetching
// it gives back what it was made for, as a browser would.
const made = new Map<string, Blob>();
let nextUrl = 0;
URL.createObjectURL = (blob: Blob | MediaSource) => {
  const url = `blob:test/${nextUrl++}`;
  made.set(url, blob as Blob);
  return url;
};
URL.revokeObjectURL = (url: string) => {
  made.delete(url);
};

const note = (noteId: string, over: Partial<Note> = {}): Note => ({
  noteId,
  folderId: null,
  kind: "note",
  title: noteId,
  preview: null,
  pinned: false,
  sortKey: "a",
  locked: false,
  keyEpoch: 0,
  deletedAt: null,
  purged: false,
  lastUpdateSeq: 0,
  snapshotSeq: 0,
  ts: { title: zero, preview: zero, place: zero, pin: zero, trash: zero, lock: zero },
  seq: 0,
  updatedAt: 0,
  ...over,
});

const file = (
  attachmentId: string,
  noteId: string,
  over: Partial<Attachment> = {},
): Attachment => ({
  attachmentId,
  noteId,
  status: "committed",
  bytes: 400,
  mime: "image/webp",
  name: "a.webp",
  locked: false,
  width: 400,
  height: 300,
  deletedAt: null,
  seq: 1,
  ...over,
});

const NONE = { copied: 0, pending: 0, tooLarge: 0, readable: 0 };

/** What the server stores for each encrypted file, by the URL storage serves it at. */
const storage = new Map<string, ArrayBuffer>();
const urlOf = (attachmentId: string) => `https://storage.test/${attachmentId}`;

/**
 * A file kept encrypted, as the server holds it once its note is locked: its
 * name and type sealed with it, the row carrying neither, and its size the
 * ciphertext's.
 */
async function sealedFile(
  attachmentId: string,
  noteId: string,
  { text = "plaintext of the picture", mime = "image/webp", name = "a.webp" } = {},
) {
  const { key, wrapped } = await vault.createAttachmentKey(attachmentId);
  const body = await seal(key, new TextEncoder().encode(text), ctx.attachmentBody(attachmentId));
  const meta = await seal(
    key,
    new TextEncoder().encode(JSON.stringify({ name, mime })),
    ctx.attachmentMeta(attachmentId),
  );
  await db().attachments.put(
    file(attachmentId, noteId, {
      bytes: body.ct.byteLength,
      mime: null,
      name: null,
      locked: true,
      wrappedKey: wrapped,
      contentIv: toArrayBuffer(body.iv),
      metaSealed: { ct: toArrayBuffer(meta.ct), iv: toArrayBuffer(meta.iv) },
    }),
  );
  storage.set(urlOf(attachmentId), toArrayBuffer(body.ct));
}

/**
 * Storage, and the tab's own URLs. What a decrypted file's URL gives back is
 * a stand-in holding its text: jsdom's Blob does not survive fake-indexeddb.
 */
function serveFiles() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const blob = made.get(url);
      if (blob) {
        const text = new TextDecoder().decode(await blob.arrayBuffer());
        return { ok: true, blob: async () => ({ size: blob.size, type: blob.type, label: text }) };
      }
      const stored = storage.get(url);
      if (!stored) throw new TypeError("network");
      return new Response(stored.slice(0));
    }),
  );
}

function imageBlock(group: Y.XmlElement, url: string) {
  const container = new Y.XmlElement("blockContainer");
  group.insert(group.length, [container]);
  const image = new Y.XmlElement("image");
  image.setAttribute("url", url);
  image.setAttribute("name", "a.webp");
  container.insert(0, [image]);
}

/** A note body like BlockNote's, showing these files as image blocks. */
async function writeBody(noteId: string, urls: string[]) {
  const doc = await acquireDoc(noteId);
  doc.transact(() => {
    const group = new Y.XmlElement("blockGroup");
    doc.getXmlFragment(FRAGMENT).insert(0, [group]);
    for (const url of urls) imageBlock(group, url);
  });
  await releaseDoc(noteId);
}

const refsOf = (noteId: string) => withDetachedDoc(noteId, (doc) => attachmentRefs(doc));

/** Which stand-in a staged copy holds: the decrypted text, for a copy of an encrypted file. */
const labelOf = async (attachmentId: string) =>
  ((await db().pendingUploads.get(attachmentId))?.blob as unknown as { label: string }).label;

/** The upload queue as {@link flushUploads} reads it, with real bytes in place of the stand-ins. */
function realBytesInQueue() {
  const table = db().pendingUploads;
  const read = table.toArray.bind(table);
  vi.spyOn(table, "toArray").mockImplementation((async () =>
    (await read()).map((row) => ({
      ...row,
      blob: new Blob([new Uint8Array(row.blob.size)], { type: row.mime }),
    }))) as never);
}

/** A note locked from the start, with a real key: one written in a locked folder. */
async function lockedNote(): Promise<string> {
  const folderId = await createFolder({ parentId: null, name: "仕事" });
  await db().folders.update(folderId, { locked: true });
  return createNote({ folderId });
}

describe("giving a note that is not locked its own copy of an encrypted file", () => {
  let server: ReturnType<typeof fakeConvex>;

  beforeEach(async () => {
    await resetLocalData();
    forgetRelockState();
    revokeResolvedUrls();
    storage.clear();
    await seedInbox();
    server = fakeConvex({
      "attachments:urls": (args) =>
        Object.fromEntries(
          (args.attachmentIds as string[]).map((id) => [
            id,
            storage.has(urlOf(id)) ? urlOf(id) : null,
          ]),
        ),
    });
    (await prepareVault("パスワード", FAST_ARGON)).adopt();
    // A locked note, with a file of its own, pasted into an ordinary one.
    await db().notes.bulkPut([note("a", { locked: true }), note("b")]);
    await sealedFile("fromA", "a");
    await writeBody("b", [refFor("fromA")]);
    serveFiles();
  });

  afterEach(() => {
    vault.lock();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("a plaintext copy of the decrypted file, and the note pointing at it", async () => {
    expect(await plainCopies(server.client, "b")).toEqual({ ...NONE, copied: 1 });

    const [copy] = await refsOf("b");
    expect(copy).not.toBe("fromA");
    expect(await db().pendingUploads.get(copy!)).toMatchObject({
      noteId: "b",
      locked: false,
      copyOf: "fromA",
      // Taken over from what was sealed with the file.
      mime: "image/webp",
      name: "a.webp",
      width: 400,
      height: 300,
    });
    expect(await labelOf(copy!)).toBe("plaintext of the picture");
    expect(await db().attachments.get(copy!)).toMatchObject({ noteId: "b", locked: false });
    // The original stays encrypted with the note it belongs to, and nothing is left to copy.
    expect(await db().attachments.get("fromA")).toMatchObject({ noteId: "a", locked: true });
    expect(await plainCopies(server.client, "b")).toEqual(NONE);
  });

  test("the copy goes up in plaintext, as an ordinary note's file", async () => {
    expect((await plainCopies(server.client, "b")).copied).toBe(1);
    const [copy] = await refsOf("b");
    server.handlers["attachments:reserve"] = () => ({
      status: "rejected",
      reason: "quotaExceeded",
    });
    realBytesInQueue();
    await expect(flushUploads(server.client)).rejects.toThrow();
    const [asked] = server.callsTo("attachments:reserve");
    expect(asked!.args).toMatchObject({
      attachmentId: copy,
      noteId: "b",
      locked: false,
      mime: "image/webp",
      name: "a.webp",
      category: "image",
    });
    expect(asked!.args.wrappedKey).toBeUndefined();
  });

  test("not sent until the note points at it, and sent once it does", async () => {
    let heldWhileReading: boolean | undefined;
    const put = db().pendingUploads.put.bind(db().pendingUploads);
    vi.spyOn(db().pendingUploads, "put").mockImplementation((async (row: {
      heldForLock?: boolean;
    }) => {
      // As it was first put: let go of later, the row is put again (updatePending).
      heldWhileReading ??= row.heldForLock;
      return put(row as never);
    }) as never);
    expect((await plainCopies(server.client, "b")).copied).toBe(1);
    expect(heldWhileReading).toBe(true);
    const [copy] = await refsOf("b");
    expect((await db().pendingUploads.get(copy!))?.heldForLock).toBe(false);
  });

  test("nothing for a note in a locked folder, about to be locked, or one in the trash", async () => {
    const folderId = await createFolder({ parentId: null, name: "鍵" });
    await db().folders.update(folderId, { locked: true });
    await db().notes.update("b", { folderId });
    expect(await plainCopies(server.client, "b")).toEqual(NONE);
    expect(await refsOf("b")).toEqual(["fromA"]);
    expect((await plainCopiedFiles(server.client)).copied).toBe(0);

    await db().notes.update("b", { folderId: null, deletedAt: 1 });
    expect(await plainCopies(server.client, "b")).toEqual(NONE);
    expect((await plainCopiedFiles(server.client)).copied).toBe(0);
    expect(await db().pendingUploads.count()).toBe(0);
  });

  test("leaves the note's own files alone, encrypted or not", async () => {
    // Say the note was unlocked elsewhere, and its files' new rows are not here yet.
    await sealedFile("ownSealed", "b");
    await db().attachments.put(file("ownPlain", "b"));
    await writeBody("b", [refFor("ownSealed"), refFor("ownPlain")]);

    expect(await plainCopies(server.client, "b")).toEqual({ ...NONE, copied: 1 });
    const after = await refsOf("b");
    expect(after).toContain("ownSealed");
    expect(after).toContain("ownPlain");
    expect(after).not.toContain("fromA");
    expect(after).toHaveLength(3);
    expect(await db().pendingUploads.toArray()).toMatchObject([{ copyOf: "fromA" }]);
  });

  test("leaves another note's plain file alone: it shows as it is", async () => {
    await db().notes.put(note("c"));
    await db().attachments.put(file("fromC", "c"));
    await db().notes.put(note("d"));
    await writeBody("d", [refFor("fromC")]);
    expect(await plainCopies(server.client, "d")).toEqual(NONE);
    expect(await refsOf("d")).toEqual(["fromC"]);
    expect(await db().pendingUploads.count()).toBe(0);
  });

  test("never makes a plaintext copy for a locked note", async () => {
    const secret = await lockedNote();
    await writeBody(secret, [refFor("fromA")]);
    expect(await plainCopies(server.client, secret)).toEqual(NONE);
    expect(await refsOf(secret)).toEqual(["fromA"]);
    expect(await db().pendingUploads.count()).toBe(0);
  });

  test("does nothing with the vault closed, and never holds it open", async () => {
    const hold = vi.spyOn(vault, "hold");
    vault.lock();
    expect(await plainCopies(server.client, "b")).toEqual(NONE);
    expect(await refsOf("b")).toEqual(["fromA"]);
    expect(fetch).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
  });

  test("a copy is taken back when the note is locked before it is pointed at", async () => {
    const table = db().attachments;
    const put = table.put.bind(table);
    vi.spyOn(table, "put").mockImplementation((async (...args: Parameters<typeof table.put>) => {
      const key = await put(...args);
      // The copy's row is written: the note is locked just then.
      if (args[0].noteId === "b") await db().notes.update("b", { locked: true });
      return key;
    }) as never);

    expect(await plainCopies(server.client, "b")).toMatchObject({ copied: 0, pending: 1 });
    vi.restoreAllMocks();
    expect(await db().pendingUploads.count()).toBe(0);
    expect((await db().attachments.toArray()).map((row) => row.attachmentId)).toEqual(["fromA"]);
    await db().notes.update("b", { locked: false });
    expect(await refsOf("b")).toEqual(["fromA"]);
  });

  test("a copy that would not fit the allowance is not made, and nothing is downloaded", async () => {
    // 24 bytes of plaintext: nothing is added for encryption.
    const tight = await plainCopies(server.client, "b", {
      allowance: { quotaBytes: 1_000, usedBytes: 977, reservedBytes: 0 },
    });
    expect(tight).toEqual({ ...NONE, tooLarge: 1 });
    expect(await refsOf("b")).toEqual(["fromA"]);
    expect(await db().pendingUploads.count()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();

    const enough = await plainCopies(server.client, "b", {
      allowance: { quotaBytes: 1_000, usedBytes: 976, reservedBytes: 0 },
    });
    expect(enough).toEqual({ ...NONE, copied: 1 });
  });

  test("a copy the server refuses leaves the note showing the original, not copied again at once", async () => {
    expect((await plainCopies(server.client, "b")).copied).toBe(1);
    server.handlers["attachments:reserve"] = () => ({
      status: "rejected",
      reason: "quotaExceeded",
    });
    realBytesInQueue();
    await expect(flushUploads(server.client)).rejects.toThrow();
    vi.restoreAllMocks();
    expect(await refsOf("b")).toEqual(["fromA"]);
    expect(await db().pendingUploads.count()).toBe(0);
    // It would only be refused again.
    expect(await plainCopies(server.client, "b")).toMatchObject({ copied: 0, tooLarge: 1 });
    expect(await db().pendingUploads.count()).toBe(0);
  });

  test("a file of a type only a locked note can hold is left as it is", async () => {
    await sealedFile("docx", "a", {
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      name: "資料.docx",
    });
    await db().notes.put(note("d"));
    await writeBody("d", [refFor("docx")]);
    expect(await plainCopies(server.client, "d")).toEqual(NONE);
    expect(await refsOf("d")).toEqual(["docx"]);
    expect(await db().pendingUploads.count()).toBe(0);
  });

  test("a file this device has no row for yet waits for it, without asking the server", async () => {
    await db().notes.put(note("d"));
    await writeBody("d", [refFor("notYet")]);
    expect(await plainCopies(server.client, "d")).toEqual(NONE);
    expect(server.callsTo("attachments:urls")).toHaveLength(0);
  });

  test("a download that fails while the server still holds the file is tried again later", async () => {
    storage.set(urlOf("fromA"), new ArrayBuffer(0));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("network"))),
    );
    expect(await plainCopies(server.client, "b")).toEqual({ ...NONE, pending: 1 });
    expect(await refsOf("b")).toEqual(["fromA"]);
  });
});

describe("the repair pass over notes that are not locked", () => {
  let server: ReturnType<typeof fakeConvex>;

  beforeEach(async () => {
    await resetLocalData();
    forgetRelockState();
    revokeResolvedUrls();
    storage.clear();
    await seedInbox();
    server = fakeConvex({
      "attachments:urls": (args) =>
        Object.fromEntries(
          (args.attachmentIds as string[]).map((id) => [
            id,
            storage.has(urlOf(id)) ? urlOf(id) : null,
          ]),
        ),
    });
    (await prepareVault("パスワード", FAST_ARGON)).adopt();
    await db().notes.put(note("a", { locked: true }));
    await sealedFile("fromA", "a");
    serveFiles();
  });

  afterEach(() => {
    vault.lock();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("copies into a note that is not open, and reads nothing again while nothing changes", async () => {
    const plain = await createNote({ folderId: null });
    await writeBody(plain, [refFor("fromA")]);
    expect(await plainCopiedFiles(server.client)).toEqual({ copied: 1, tooLarge: 0 });
    expect(await refsOf(plain)).not.toContain("fromA");

    const read = vi.spyOn(db().bodies, "get");
    expect(await plainCopiedFiles(server.client)).toEqual({ copied: 0, tooLarge: 0 });
    // The note's edit is not sent yet, so it counts as unchanged.
    expect(read).not.toHaveBeenCalled();
  });

  test("copies once a file a note shows is locked with its note, though the note itself has not changed", async () => {
    await db().notes.put(note("c"));
    await db().attachments.put(file("fromC", "c"));
    const plain = await createNote({ folderId: null });
    await writeBody(plain, [refFor("fromC")]);
    expect(await plainCopiedFiles(server.client)).toEqual({ copied: 0, tooLarge: 0 });

    // Note c is locked, and its file sealed where it is.
    await db().notes.update("c", { locked: true });
    await sealedFile("fromC", "c");
    expect(await plainCopiedFiles(server.client)).toEqual({ copied: 1, tooLarge: 0 });
    expect(await refsOf(plain)).not.toContain("fromC");
  });

  test("does nothing with the vault closed", async () => {
    const plain = await createNote({ folderId: null });
    await writeBody(plain, [refFor("fromA")]);
    vault.lock();
    expect(await plainCopiedFiles(server.client)).toEqual({ copied: 0, tooLarge: 0 });
    expect(await refsOf(plain)).toEqual(["fromA"]);
  });

  test("is part of every repair, and reports copies that do not fit", async () => {
    const plain = await createNote({ folderId: null });
    await writeBody(plain, [refFor("fromA")]);
    await setMeta(META.profile, { quotaBytes: 10, usedBytes: 0, reservedBytes: 0 });
    expect(await repairLocks(server.client, null)).toMatchObject({
      plainCopies: 0,
      plainCopiesTooLarge: 1,
    });
    await setMeta(META.profile, null);
    // Tried again only a while later: nothing changed.
    expect(await repairLocks(server.client, null)).toMatchObject({
      plainCopies: 0,
      plainCopiesTooLarge: 0,
    });
  });
});
