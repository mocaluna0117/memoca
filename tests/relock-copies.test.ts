import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { prepareVault, vault } from "@/lib/crypto/vault";
import { db, resetLocalData, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import {
  flushUploads,
  idFromRef,
  refFor,
  resolveAttachment,
  revokeResolvedUrls,
  stageUpload,
} from "@/lib/media/attachments";
import {
  forgetRelockState,
  foreignFiles,
  relockCopies,
  restoreOriginal,
  rewriteRefInDoc,
  settleHeldCopies,
} from "@/lib/media/relock-copies";
import { acquireDoc, releaseDoc, withDetachedDoc } from "@/lib/sync/docs";
import { createFolder, createNote } from "@/lib/sync/mutations";
import { FRAGMENT, attachmentRefs } from "@/lib/sync/ydoc";
import { lockNote, unlockNote } from "@/lib/vault/actions";
import { lockFolder } from "@/lib/vault/cascade";
import { relockCopiedFiles, repairLocks } from "@/lib/vault/reconcile";
import type { Attachment, Note } from "@/lib/types";
import { fakeConvex } from "./helpers/fake-convex";
import { FAST_ARGON, seedInbox, zero } from "./helpers/seed";

// jsdom has no object URLs; staging only needs a string back.
let nextUrl = 0;
URL.createObjectURL = () => `blob:test/${nextUrl++}`;
URL.revokeObjectURL = () => {};

/** jsdom's Blob does not survive fake-indexeddb, so a labelled stand-in is stored. */
const stored = (size: number, label = "original") =>
  ({ size, type: "image/webp", label }) as unknown as Blob;

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

const file = (attachmentId: string, noteId: string, over: Partial<Attachment> = {}): Attachment => ({
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

/** Which stand-in a staged copy holds. */
const labelOf = async (attachmentId: string) =>
  ((await db().pendingUploads.get(attachmentId))?.blob as unknown as { label: string }).label;

/**
 * The upload queue as {@link flushUploads} reads it, with real bytes in
 * place of the stand-ins: a copy is encrypted before it is offered, and that
 * reads them.
 */
function realBytesInQueue() {
  const table = db().pendingUploads;
  const read = table.toArray.bind(table);
  vi.spyOn(table, "toArray").mockImplementation((async () =>
    (await read()).map((row) => ({
      ...row,
      blob: new Blob([new Uint8Array(row.blob.size)], { type: row.mime }),
    }))) as never);
}

/** Edits of a note waiting in the outbox to be sent. */
const editsQueued = (noteId: string) =>
  db().outbox.filter((op) => op.kind === "update" && op.entityId === noteId).count();

/**
 * As if every edit had reached the server. Rows are put back whole: Dexie's
 * modify() turns their bytes into plain objects under fake-indexeddb.
 */
async function markSent(noteId: string) {
  const rows = await db().updates.where("noteId").equals(noteId).toArray();
  for (const row of rows) await db().updates.put({ ...row, pushed: 1, seq: 1 });
  await db().notes.update(noteId, { lastUpdateSeq: 1 });
  const body = await db().bodies.get(noteId);
  await db().bodies.put({ noteId, throughSeq: 1, keyEpoch: body?.keyEpoch ?? 0, text: "", updatedAt: 0 });
}

/** A note locked from the start, with a real key: one written in a locked folder. */
async function lockedNote(): Promise<string> {
  const folderId = await createFolder({ parentId: null, name: "仕事" });
  await db().folders.update(folderId, { locked: true });
  return createNote({ folderId });
}

/** Just enough of the Web Locks API: one holder per name, in turn. */
function fakeLocks() {
  const held = new Map<string, Promise<void>>();
  return {
    async request<T>(
      name: string,
      options: { ifAvailable?: boolean },
      callback: (lock: object | null) => Promise<T> | T,
    ): Promise<T> {
      while (held.has(name)) {
        if (options.ifAvailable) return callback(null);
        await held.get(name);
      }
      let release!: () => void;
      held.set(name, new Promise<void>((resolve) => (release = resolve)));
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
        release();
      }
    },
  };
}

describe("pointing a note at a different file", () => {
  test("changes block props and text marks, and nothing else", () => {
    const doc = new Y.Doc();
    const group = new Y.XmlElement("blockGroup");
    doc.getXmlFragment(FRAGMENT).insert(0, [group]);
    imageBlock(group, refFor("old"));
    imageBlock(group, refFor("other"));
    const paragraph = new Y.XmlElement("paragraph");
    const text = new Y.XmlText();
    group.insert(group.length, [paragraph]);
    paragraph.insert(0, [text]);
    text.insert(0, "資料", { link: { href: refFor("old"), target: "_blank" } });
    text.insert(2, "と本文", { bold: true });

    expect(rewriteRefInDoc(doc, refFor("old"), refFor("new"))).toBe(2);
    expect(attachmentRefs(doc)).toEqual(["new", "other"]);
    expect(text.toDelta()).toEqual([
      { insert: "資料", attributes: { link: { href: refFor("new"), target: "_blank" } } },
      { insert: "と本文", attributes: { bold: true } },
    ]);
    expect(rewriteRefInDoc(doc, refFor("gone"), refFor("x"))).toBe(0);
  });
});

describe("which files are another note's", () => {
  beforeEach(() => resetLocalData());

  test("live files uploaded to a different note, locked or not, and ones not seen yet", async () => {
    await db().attachments.bulkPut([
      file("own", "b"),
      file("fromA", "a"),
      file("fromLocked", "c", { locked: true, mime: null, name: null }),
      file("deleted", "a", { deletedAt: 5 }),
    ]);
    const found = await foreignFiles("b", ["own", "fromA", "fromLocked", "deleted", "unknown"]);
    expect(found.map((f) => ("row" in f ? f.row.attachmentId : `?${f.unknown}`)).sort()).toEqual([
      "?unknown",
      "fromA",
      "fromLocked",
    ]);
  });
});

describe("giving a locked note its own copies", () => {
  let server: ReturnType<typeof fakeConvex>;
  let secret: string;

  beforeEach(async () => {
    await resetLocalData();
    forgetRelockState();
    await seedInbox();
    server = fakeConvex({ "attachments:urls": () => ({}) });
    (await prepareVault("パスワード", FAST_ARGON)).adopt();
    await db().notes.put(note("a"));
    await db().attachments.put(file("fromA", "a"));
    await db().blobs.put({ attachmentId: "fromA", blob: stored(400), bytes: 400, lastUsed: 0 });
    secret = await lockedNote();
    await writeBody(secret, [refFor("fromA")]);
  });

  afterEach(() => {
    vault.lock();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("an encrypted copy, and an encrypted edit pointing at it", async () => {
    const before = await db().updates.where("noteId").equals(secret).count();
    expect(await relockCopies(server.client, secret)).toEqual({ ...NONE, copied: 1 });

    const [copy] = await refsOf(secret);
    expect(copy).not.toBe("fromA");
    expect(await db().pendingUploads.get(copy!)).toMatchObject({
      noteId: secret,
      locked: true,
      copyOf: "fromA",
    });
    expect(await labelOf(copy!)).toBe("original");
    const rows = await db().updates.where("noteId").equals(secret).toArray();
    expect(rows).toHaveLength(before + 1);
    expect(rows.every((row) => row.iv !== undefined)).toBe(true);
    // The original stays with the note it belongs to, and nothing is left to copy.
    expect(await db().attachments.get("fromA")).toMatchObject({ noteId: "a", locked: false });
    expect(await relockCopies(server.client, secret)).toEqual(NONE);
  });

  test("leaves a note that is not locked to the lock, which makes its own copies", async () => {
    await db().notes.put(note("b"));
    await writeBody("b", [refFor("fromA")]);
    expect(await relockCopies(server.client, "b")).toEqual(NONE);
    expect(await refsOf("b")).toEqual(["fromA"]);
    expect(await db().pendingUploads.count()).toBe(0);
  });

  test("does nothing with the vault closed, and never holds it open", async () => {
    const hold = vi.spyOn(vault, "hold");
    expect((await relockCopies(server.client, secret)).copied).toBe(1);
    expect(hold).not.toHaveBeenCalled();

    const other = await lockedNote();
    await writeBody(other, [refFor("fromA")]);
    vault.lock();
    expect(await relockCopies(server.client, other)).toEqual(NONE);
    expect(await db().pendingUploads.count()).toBe(1);
  });

  test("a copy that would not fit the allowance is not made, and nothing is downloaded", async () => {
    await db().blobs.clear();
    const outcome = await relockCopies(server.client, secret, {
      allowance: { quotaBytes: 1_000, usedBytes: 900, reservedBytes: 0 },
    });
    expect(outcome).toEqual({ ...NONE, tooLarge: 1, readable: 1 });
    expect(await refsOf(secret)).toEqual(["fromA"]);
    expect(await db().pendingUploads.count()).toBe(0);
    // Decided from the row's size: the server was never asked for the file.
    expect(server.callsTo("attachments:urls")).toHaveLength(0);
  });

  test("nor one over the limit for one file, counting what encryption adds", async () => {
    const roomy = { quotaBytes: 1_000_000, usedBytes: 0, reservedBytes: 0 };
    // 400 bytes, and 16 more once encrypted.
    const tight = await relockCopies(server.client, secret, {
      allowance: { ...roomy, limits: { maxImageBytes: 415 } },
    });
    expect(tight).toMatchObject({ copied: 0, tooLarge: 1 });
    expect(await db().pendingUploads.count()).toBe(0);
    const enough = await relockCopies(server.client, secret, {
      allowance: { ...roomy, limits: { maxImageBytes: 416 } },
    });
    expect(enough.copied).toBe(1);
  });

  test("the last figures this device saw are used when none are given", async () => {
    await setMeta(META.profile, { quotaBytes: 1_000, usedBytes: 800, reservedBytes: 0 });
    expect((await relockCopies(server.client, secret)).tooLarge).toBe(1);
  });

  test("copies made in one pass count against the allowance together", async () => {
    await db().attachments.put(file("fromA2", "a"));
    await db().blobs.put({ attachmentId: "fromA2", blob: stored(400, "second"), bytes: 400, lastUsed: 0 });
    const two = await lockedNote();
    await writeBody(two, [refFor("fromA"), refFor("fromA2")]);
    const outcome = await relockCopies(server.client, two, {
      allowance: { quotaBytes: 1_000, usedBytes: 300, reservedBytes: 0 },
    });
    expect(outcome).toMatchObject({ copied: 1, tooLarge: 1 });
  });

  test("staging that fails part way takes back what it had staged", async () => {
    await db().attachments.put(file("fromA2", "a"));
    await db().blobs.put({ attachmentId: "fromA2", blob: stored(400, "second"), bytes: 400, lastUsed: 0 });
    const two = await lockedNote();
    await writeBody(two, [refFor("fromA"), refFor("fromA2")]);
    const table = db().pendingUploads;
    const put = table.put.bind(table);
    let calls = 0;
    vi.spyOn(table, "put").mockImplementation(((...args: Parameters<typeof table.put>) => {
      calls += 1;
      return calls === 2 ? Promise.reject(new Error("disk full")) : put(...args);
    }) as never);

    await expect(relockCopies(server.client, two)).rejects.toThrow("disk full");
    vi.restoreAllMocks();
    expect(await db().pendingUploads.count()).toBe(0);
    expect((await db().attachments.toArray()).map((row) => row.attachmentId).sort()).toEqual([
      "fromA",
      "fromA2",
    ]);
    expect(await refsOf(two)).toEqual(["fromA", "fromA2"]);
  });

  test("a file the server no longer holds leaves nothing to protect, and is not asked about again", async () => {
    await db().blobs.clear();
    expect(await relockCopies(server.client, secret)).toEqual(NONE);
    expect(await refsOf(secret)).toEqual(["fromA"]);
    const asked = server.callsTo("attachments:urls").length;
    expect(await relockCopies(server.client, secret)).toEqual(NONE);
    expect(server.callsTo("attachments:urls")).toHaveLength(asked);
  });

  test("nor is one this device never had a row for", async () => {
    const other = await lockedNote();
    await writeBody(other, [refFor("neverSeen")]);
    expect(await relockCopies(server.client, other)).toEqual(NONE);
    const asked = server.callsTo("attachments:urls").length;
    expect(await relockCopies(server.client, other)).toEqual(NONE);
    expect(server.callsTo("attachments:urls")).toHaveLength(asked);
  });

  test("a download that fails while the server still holds the file is tried again later", async () => {
    await db().blobs.clear();
    server.handlers["attachments:urls"] = () => ({ fromA: "https://storage.test/fromA" });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("network"))));
    expect(await relockCopies(server.client, secret)).toEqual({ ...NONE, pending: 1, readable: 1 });
    expect(await refsOf(secret)).toEqual(["fromA"]);
  });

  test("when the server cannot be asked, the file is tried again later, not given up", async () => {
    await db().blobs.clear();
    server.handlers["attachments:urls"] = () => {
      throw new Error("offline");
    };
    expect((await relockCopies(server.client, secret)).pending).toBe(1);
    const asked = server.callsTo("attachments:urls").length;
    expect((await relockCopies(server.client, secret)).pending).toBe(1);
    expect(server.callsTo("attachments:urls").length).toBeGreaterThan(asked);
  });

  test("a file still uploading elsewhere waits, and is given up an hour later", async () => {
    await db().blobs.clear();
    await db().attachments.put(file("fromA", "a", { status: "reserved" }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T00:00:00Z"));
    expect(await relockCopies(server.client, secret)).toEqual({ ...NONE, pending: 1, readable: 1 });
    vi.setSystemTime(new Date("2026-09-26T01:01:00Z"));
    expect(await relockCopies(server.client, secret)).toEqual(NONE);
  });

  test("a file this device has not heard of yet but the server holds waits for its row", async () => {
    const other = await lockedNote();
    await writeBody(other, [refFor("fromA"), refFor("notYet")]);
    server.handlers["attachments:urls"] = (args) =>
      (args.attachmentIds as string[]).includes("notYet") ? { notYet: "https://storage.test/x" } : {};
    const outcome = await relockCopies(server.client, other);
    expect(outcome).toMatchObject({ copied: 1, pending: 1 });
  });

  test("a plain file that comes back longer than its row says waits: it was sealed elsewhere since", async () => {
    // Neither the file's new row nor its note's has reached this device.
    await db().blobs.clear();
    server.handlers["attachments:urls"] = () => ({ fromA: "https://storage.test/fromA" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(416))));
    expect(await relockCopies(server.client, secret)).toEqual({ ...NONE, pending: 1, readable: 1 });
    expect(await db().pendingUploads.count()).toBe(0);
    expect(await refsOf(secret)).toEqual(["fromA"]);
  });

  test("a file only the vault can describe is held to the looser limit until it is read", async () => {
    // Another locked note's video: no type or name until it is opened.
    await db().notes.put(note("c", { locked: true }));
    await db().attachments.put(file("video", "c", { locked: true, mime: null, name: null, bytes: 10_000 }));
    const other = await lockedNote();
    await writeBody(other, [refFor("video")]);
    const outcome = await relockCopies(server.client, other, {
      allowance: {
        quotaBytes: 1_000_000,
        usedBytes: 0,
        reservedBytes: 0,
        limits: { maxImageBytes: 5_000, maxVideoBytes: 30_000 },
      },
    });
    // Not turned away for the image limit: it was fetched (and is gone here).
    expect(outcome.tooLarge).toBe(0);
    expect(server.callsTo("attachments:urls").length).toBeGreaterThan(0);
  });

  test("unlocking waits for a copy still on its way, which would stay encrypted under a plain note", async () => {
    expect((await relockCopies(server.client, secret)).copied).toBe(1);
    await markSent(secret);
    expect(await unlockNote(server.client, secret)).toEqual({ status: "skipped", reason: "uploadPending" });
    expect(server.callsTo("vault:unlockNote")).toHaveLength(0);
  });

  test("a file marked plain whose note is locked waits: what the server holds may be ciphertext", async () => {
    // Locked on another device; this one has the note's new state, not the file's.
    await db().notes.update("a", { locked: true });
    expect(await relockCopies(server.client, secret)).toEqual({ ...NONE, pending: 1 });
    expect(await db().pendingUploads.count()).toBe(0);
    expect(await refsOf(secret)).toEqual(["fromA"]);
  });

  test("a copy the server refuses leaves the note showing the original, not copied again at once", async () => {
    expect((await relockCopies(server.client, secret)).copied).toBe(1);
    server.handlers["attachments:reserve"] = () => ({ status: "rejected", reason: "quotaExceeded" });
    realBytesInQueue();
    await expect(flushUploads(server.client)).rejects.toThrow();
    expect(await refsOf(secret)).toEqual(["fromA"]);
    expect(await db().pendingUploads.count()).toBe(0);
    // It would only be refused again.
    expect(await relockCopies(server.client, secret)).toMatchObject({ copied: 0, tooLarge: 1 });
    expect(await db().pendingUploads.count()).toBe(0);
  });

  test("a copy refused while the pass is still reading another file goes back at once", async () => {
    await db().attachments.put(file("fromA2", "a"));
    const two = await lockedNote();
    await writeBody(two, [refFor("fromA"), refFor("fromA2")]);
    server.handlers["attachments:urls"] = () => ({ fromA2: "https://storage.test/fromA2" });
    server.handlers["attachments:reserve"] = () => ({ status: "rejected", reason: "quotaExceeded" });
    realBytesInQueue();
    // The upload queue runs, and refuses the first copy, while the second
    // file is being downloaded.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await flushUploads(server.client).catch(() => {});
        throw new TypeError("network");
      }),
    );

    expect(await relockCopies(server.client, two)).toMatchObject({ copied: 0, tooLarge: 1, pending: 1 });
    expect(await refsOf(two)).toEqual(["fromA", "fromA2"]);
    expect(await db().pendingUploads.count()).toBe(0);
  });

  test("a note still showing a refused copy is pointed back at the original, and copied again later", async () => {
    // Say an edit saved after the refusal, or another tab, still points there.
    const other = await lockedNote();
    await writeBody(other, [refFor("refused")]);
    const now = Date.now();
    await setMeta(META.refusedCopies, {
      refused: { noteId: other, originalId: "fromA", reason: "quotaExceeded", at: now },
    });

    expect(await relockCopies(server.client, other)).toMatchObject({ copied: 0, tooLarge: 1 });
    expect(await refsOf(other)).toEqual(["fromA"]);
    expect(await db().pendingUploads.count()).toBe(0);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now + 11 * 60 * 1000);
    expect((await relockCopies(server.client, other)).copied).toBe(1);
  });

  test("an unlock that finishes while the files are read leaves the note alone", async () => {
    const noteKey = vault.noteKey.bind(vault);
    vi.spyOn(vault, "noteKey").mockImplementation(async (...args: Parameters<typeof vault.noteKey>) => {
      // The note is opened for the edit once its copy is staged: the unlock
      // lands just then.
      if ((await db().pendingUploads.count()) > 0) await db().notes.update(secret, { locked: false });
      return noteKey(...args);
    });

    expect(await relockCopies(server.client, secret)).toMatchObject({ copied: 0, pending: 1 });
    expect(await db().pendingUploads.count()).toBe(0);
    vi.restoreAllMocks();
    await db().notes.update(secret, { locked: true });
    expect(await refsOf(secret)).toEqual(["fromA"]);
  });

  test("the edit is in storage when the pass ends, even with the note open in the editor", async () => {
    await acquireDoc(secret);
    try {
      const before = await db().updates.where("noteId").equals(secret).count();
      expect((await relockCopies(server.client, secret)).copied).toBe(1);
      expect(await db().updates.where("noteId").equals(secret).count()).toBe(before + 1);
    } finally {
      await releaseDoc(secret);
    }
  });

  test("one pass at a time: another is told the note is busy, or waits its turn", async () => {
    const locks = fakeLocks();
    Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
    try {
      let letGo!: () => void;
      const holding = locks.request(
        `memoca-relock:${secret}`,
        {},
        () => new Promise<void>((resolve) => (letGo = resolve)),
      );
      expect(await relockCopies(server.client, secret)).toEqual({ ...NONE, pending: 1 });

      let finished = false;
      const waiting = relockCopies(server.client, secret, { wait: true }).then((outcome) => {
        finished = true;
        return outcome;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(finished).toBe(false);
      letGo();
      await holding;
      expect((await waiting).copied).toBe(1);
    } finally {
      delete (navigator as { locks?: unknown }).locks;
    }
  });

  test("restoring points back only where the copy is shown", async () => {
    expect((await relockCopies(server.client, secret)).copied).toBe(1);
    const [copy] = await refsOf(secret);
    await restoreOriginal(secret, copy!, "fromA");
    expect(await refsOf(secret)).toEqual(["fromA"]);
  });

  test("a locked file waiting to go up is shown only while the vault is open", async () => {
    const ref = await stageUpload({
      noteId: secret,
      file: new File([], "a.webp", { type: "image/webp" }),
      locked: true,
      prepared: { blob: stored(10), mime: "image/webp", width: 1, height: 1 },
    });
    const id = idFromRef(ref)!;
    // What closing the vault does to the tab's own URLs.
    revokeResolvedUrls();
    expect(await resolveAttachment(server.client, id)).toMatch(/^blob:/);
    revokeResolvedUrls();
    vault.lock();
    expect(await resolveAttachment(server.client, id)).toBeNull();
  });
});

describe("locking a note with files copied in", () => {
  let server: ReturnType<typeof fakeConvex>;

  beforeEach(async () => {
    await resetLocalData();
    forgetRelockState();
    await seedInbox();
    server = fakeConvex({ "attachments:urls": () => ({}), "vault:lockNote": () => ({ status: "ok" }) });
    (await prepareVault("パスワード", FAST_ARGON)).adopt();
    await db().notes.bulkPut([note("a"), note("b")]);
    await db().attachments.put(file("fromA", "a"));
    await db().blobs.put({ attachmentId: "fromA", blob: stored(400), bytes: 400, lastUsed: 0 });
    await writeBody("b", [refFor("fromA")]);
    await markSent("b");
  });

  afterEach(() => {
    vault.lock();
    vi.restoreAllMocks();
  });

  test("seals the note already pointing at an encrypted copy, in one go", async () => {
    const queued = await editsQueued("b");
    expect(await lockNote(server.client, "b")).toEqual({ status: "ok", copiesLeft: 0 });
    expect(server.callsTo("vault:lockNote")).toHaveLength(1);

    // What was sealed shows the copy, which goes up encrypted, from a plain
    // original too.
    const [copy] = await refsOf("b");
    expect(copy).not.toBe("fromA");
    expect(await db().pendingUploads.get(copy!)).toMatchObject({ noteId: "b", locked: true, copyOf: "fromA" });
    // The note itself was never edited to point there: nothing readable to send.
    expect(await editsQueued("b")).toBe(queued);
    expect(await db().attachments.get("fromA")).toMatchObject({ noteId: "a", locked: false });
  });

  test("its copies are not sent, or refused, before the lock is through", async () => {
    let sentDuringLock = -1;
    server.handlers["attachments:reserve"] = () => ({ status: "rejected", reason: "quotaExceeded" });
    realBytesInQueue();
    server.handlers["vault:lockNote"] = async () => {
      // The upload queue runs while the lock is under way.
      await flushUploads(server.client).catch(() => {});
      sentDuringLock = server.callsTo("attachments:reserve").length;
      return { status: "ok" };
    };
    expect(await lockNote(server.client, "b")).toEqual({ status: "ok", copiesLeft: 0 });
    expect(sentDuringLock).toBe(0);
    const [copy] = await refsOf("b");
    expect(await db().pendingUploads.get(copy!)).toMatchObject({ heldForLock: false, locked: true });
  });

  test("a lock that does not go through leaves the note as it was, and takes its copies back", async () => {
    server.handlers["vault:lockNote"] = () => ({ status: "rejected", reason: "epochMismatch" });
    expect(await lockNote(server.client, "b")).toEqual({ status: "failed", reason: "epochMismatch" });
    expect(await refsOf("b")).toEqual(["fromA"]);
    expect(await db().pendingUploads.count()).toBe(0);
    expect((await db().attachments.toArray()).map((row) => row.attachmentId)).toEqual(["fromA"]);
  });

  test("a file that cannot be copied does not hold the lock up; the lock says how many are left", async () => {
    await setMeta(META.profile, {
      quotaBytes: 1_000_000,
      usedBytes: 0,
      reservedBytes: 0,
      limits: { maxImageBytes: 100 },
    });
    expect(await lockNote(server.client, "b")).toEqual({ status: "ok", copiesLeft: 1 });
    expect(await refsOf("b")).toEqual(["fromA"]);
    expect(await db().pendingUploads.count()).toBe(0);
  });

  test("only files readable where they are count as left", async () => {
    await db().notes.put(note("c", { locked: true }));
    await db().attachments.put(file("fromC", "c", { locked: true, mime: null, name: null }));
    await db().notes.put(note("d"));
    await writeBody("d", [refFor("fromA"), refFor("fromC")]);
    await markSent("d");
    await setMeta(META.profile, { quotaBytes: 1_000, usedBytes: 1_000, reservedBytes: 0 });
    // Neither fits; only the plain one is readable on the server.
    expect(await lockNote(server.client, "d")).toEqual({ status: "ok", copiesLeft: 1 });
  });

  test("a folder's lock adds up what its notes left", async () => {
    const work = await createFolder({ parentId: null, name: "仕事" });
    const inside = await createNote({ folderId: work });
    await writeBody(inside, [refFor("fromA")]);
    await markSent(inside);
    await db().outbox.clear();
    await setMeta(META.profile, { quotaBytes: 1_000, usedBytes: 1_000, reservedBytes: 0 });
    server.handlers["vault:setFolderLock"] = () => ({ status: "ok" });
    expect(await lockFolder(server.client, null, work)).toMatchObject({ done: 1, copiesLeft: 1 });
  });
});

describe("copies a lock held back when the tab went away", () => {
  const held = (attachmentId: string, noteId: string, createdAt: number) => ({
    attachmentId,
    noteId,
    blob: stored(10),
    mime: "image/webp",
    name: "a.webp",
    width: null,
    height: null,
    category: "image" as const,
    locked: true,
    copyOf: "fromA",
    heldForLock: true,
    createdAt,
  });

  beforeEach(async () => {
    await resetLocalData();
    await db().notes.bulkPut([note("sealed", { locked: true }), note("plain")]);
  });

  test("go up once the note turns out locked: the lock went through after all", async () => {
    await db().pendingUploads.put(held("c1", "sealed", 0));
    expect(await settleHeldCopies(null)).toBe(1);
    expect(await db().pendingUploads.get("c1")).toMatchObject({ heldForLock: false });
  });

  test("are taken back once this device has caught up well after, and the note is still plain", async () => {
    const madeAt = Date.now() - 60 * 60 * 1000;
    await db().pendingUploads.put(held("c1", "plain", madeAt));
    expect(await settleHeldCopies({ catchingUp: false, lastSyncAt: Date.now() })).toBe(1);
    expect(await db().pendingUploads.count()).toBe(0);
  });

  test("are kept while it cannot be told yet whether the lock went through", async () => {
    const madeAt = Date.now() - 60 * 60 * 1000;
    await db().pendingUploads.put(held("c1", "plain", madeAt));
    // Still catching up, or not synced since the copy was made.
    expect(await settleHeldCopies({ catchingUp: true, lastSyncAt: Date.now() })).toBe(0);
    expect(await settleHeldCopies({ catchingUp: false, lastSyncAt: madeAt + 1_000 })).toBe(0);
    expect(await settleHeldCopies(null)).toBe(0);
    expect(await db().pendingUploads.count()).toBe(1);
  });
});

describe("the repair pass over locked notes", () => {
  let server: ReturnType<typeof fakeConvex>;

  beforeEach(async () => {
    await resetLocalData();
    forgetRelockState();
    await seedInbox();
    server = fakeConvex({ "attachments:urls": () => ({}) });
    (await prepareVault("パスワード", FAST_ARGON)).adopt();
    await db().notes.put(note("a"));
    await db().attachments.bulkPut([file("fromA", "a"), file("uploading", "a", { status: "reserved" })]);
    await db().blobs.put({ attachmentId: "fromA", blob: stored(400), bytes: 400, lastUsed: 0 });
  });

  afterEach(() => {
    vault.lock();
    vi.useRealTimers();
  });

  test("takes turns: notes whose copies cannot be made yet do not keep the others waiting", async () => {
    // Five notes whose file is still uploading elsewhere, then one that can be copied.
    for (let i = 0; i < 5; i += 1) await writeBody(await lockedNote(), [refFor("uploading")]);
    const last = await lockedNote();
    await writeBody(last, [refFor("fromA")]);

    expect((await relockCopiedFiles(server.client)).copied).toBe(0);
    expect((await relockCopiedFiles(server.client)).copied).toBe(1);
    expect(await refsOf(last)).not.toContain("fromA");
    // Nothing changed and nothing is due: nothing is read, nobody is asked.
    const asked = server.callsTo("attachments:urls").length;
    expect(await relockCopiedFiles(server.client)).toEqual({ copied: 0, tooLarge: 0 });
    expect(server.callsTo("attachments:urls")).toHaveLength(asked);
  });

  test("takes turns even when every note is due again", async () => {
    for (let i = 0; i < 5; i += 1) await writeBody(await lockedNote(), [refFor("uploading")]);
    const last = await lockedNote();
    await writeBody(last, [refFor("fromA")]);
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);

    expect((await relockCopiedFiles(server.client)).copied).toBe(0);
    // The five are due again, and the one the first pass never reached comes first.
    vi.setSystemTime(start + 11 * 60 * 1000);
    expect((await relockCopiedFiles(server.client)).copied).toBe(1);
  });

  test("reports copies that do not fit", async () => {
    await setMeta(META.profile, { quotaBytes: 1_000, usedBytes: 800, reservedBytes: 0 });
    await writeBody(await lockedNote(), [refFor("fromA")]);
    expect(await relockCopiedFiles(server.client)).toEqual({ copied: 0, tooLarge: 1 });
  });

  test("is part of every repair", async () => {
    const secret = await lockedNote();
    await writeBody(secret, [refFor("fromA")]);
    expect(await repairLocks(server.client, null)).toMatchObject({ copiesLocked: 1, copiesTooLarge: 0 });
    expect(await refsOf(secret)).not.toContain("fromA");
  });
});
