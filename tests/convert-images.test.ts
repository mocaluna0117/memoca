import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { prepareVault, vault } from "@/lib/crypto/vault";
import { db, getMeta, resetLocalData } from "@/lib/db";
import { META } from "@/lib/db/meta";
import { refFor } from "@/lib/media/attachments";
import type { PreparedImage } from "@/lib/media/compress";
import { acquireDoc, releaseDoc, withDetachedDoc } from "@/lib/sync/docs";
import { FRAGMENT, attachmentRefs } from "@/lib/sync/ydoc";
import type { Attachment, Note } from "@/lib/types";
import { fakeConvex } from "./helpers/fake-convex";
import { FAST_ARGON, zero } from "./helpers/seed";

const h = vi.hoisted(() => ({
  /** What writing an image again comes to, by the size it had. */
  prepare: vi.fn(),
}));
vi.mock("@/lib/media/compress", async (original) => ({
  ...(await original<typeof import("@/lib/media/compress")>()),
  prepareImage: h.prepare,
}));

import {
  type Convertible,
  KEEP_BELOW,
  type Stored,
  convertImages,
  findConvertible,
  isAnimatedPng,
  untilStored,
} from "@/lib/media/convert-images";
import { MAX_REPLACED_PER_CALL } from "@convex/lib/constants";

// jsdom has no object URLs; staging only needs a string back.
let nextUrl = 0;
URL.createObjectURL = () => `blob:test/${nextUrl++}`;
URL.revokeObjectURL = () => {};

/** jsdom's Blob does not survive fake-indexeddb, so a labelled stand-in is stored. */
const stored = (size: number, type: string, label: string) =>
  ({ size, type, label }) as unknown as Blob;

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
  bytes: 1_000,
  mime: "image/png",
  name: "image.png",
  locked: false,
  width: 1179,
  height: 640,
  deletedAt: null,
  seq: 1,
  ...over,
});

/** A note body like BlockNote's, showing these files as image blocks. */
async function writeBody(noteId: string, urls: string[]) {
  const doc = await acquireDoc(noteId);
  doc.transact(() => {
    const group = new Y.XmlElement("blockGroup");
    doc.getXmlFragment(FRAGMENT).insert(0, [group]);
    for (const url of urls) {
      const container = new Y.XmlElement("blockContainer");
      group.insert(group.length, [container]);
      const image = new Y.XmlElement("image");
      image.setAttribute("url", url);
      container.insert(0, [image]);
    }
  });
  await releaseDoc(noteId);
}

const refsOf = (noteId: string) => withDetachedDoc(noteId, (doc) => [...attachmentRefs(doc)]);

/** The server: which notes show each file, and what it was told was replaced, with its limits. */
let usedBy: Record<string, string[]>;
let told: string[][];
let pairs: { original: string; copy: string }[];
let asked: number[];
let tellFails: boolean;
const server = () =>
  fakeConvex({
    "attachments:usedBy": (args) => {
      const ids = args.attachmentIds as string[];
      asked.push(ids.length);
      return Object.fromEntries(
        ids.slice(0, MAX_REPLACED_PER_CALL).map((id) => [id, usedBy[id] ?? []]),
      );
    },
    "attachments:markReplaced": (args) => {
      if (tellFails) throw new Error("offline");
      const replaced = args.replaced as { original: string; copy: string }[];
      if (replaced.length > MAX_REPLACED_PER_CALL) return { status: "rejected", reason: "tooMany" };
      told.push(replaced.map((entry) => entry.original));
      pairs.push(...replaced);
      return { status: "ok", marked: replaced.length };
    },
  }).client;

const ROOM = {
  quotaBytes: 100_000_000,
  usedBytes: 0,
  reservedBytes: 0,
  limits: { maxImageBytes: 5_000_000 },
};

/** A PNG in `owner`, shown by `notes`, its bytes cached on the device. */
async function png(attachmentId: string, owner: string, notes: string[], bytes = 1_000) {
  await db().attachments.put(file(attachmentId, owner, { bytes }));
  await db().blobs.put({
    attachmentId,
    blob: stored(bytes, "image/png", attachmentId),
    bytes,
    lastUsed: 0,
  });
  usedBy[attachmentId] = notes;
}

/** The notes as the server has them: written, and nothing left to send. */
async function notesWith(bodies: Record<string, string[]>) {
  for (const [noteId, urls] of Object.entries(bodies)) {
    await db().notes.put(note(noteId));
    await writeBody(noteId, urls);
  }
  await db().outbox.clear();
}

const find = () => findConvertible(server());

/** Replacements a run could not tell the server of, left on the device. */
async function setMetaWaiting(count: number) {
  const { setMeta } = await import("@/lib/db");
  await setMeta(
    META.replacedToTell,
    Array.from({ length: count }, (_, i) => ({ original: `old${i}`, copy: `new${i}` })),
  );
}
/** The copy on the server as soon as it is staged, as a quick sync engine would have it. */
const storedAtOnce = async (): Promise<Stored> => "committed";
const run = async (files: Convertible[], over: Partial<Parameters<typeof convertImages>[0]> = {}) =>
  convertImages({ client: server(), files, allowance: ROOM, upload: storedAtOnce, ...over });

beforeEach(async () => {
  await resetLocalData();
  usedBy = {};
  told = [];
  pairs = [];
  asked = [];
  tellFails = false;
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  // Writing again comes to a fifth of an image of the usual 1,000 bytes, as
  // a screenshot's PNG does in WebP. (A stand-in wrapped in a File loses its
  // size, so the copy's is given, not worked out.)
  h.prepare.mockReset().mockImplementation(async (): Promise<PreparedImage> => ({
    blob: stored(200, "image/webp", "webp"),
    mime: "image/webp",
    width: 1179,
    height: 640,
  }));
});

afterEach(() => {
  vault.lock();
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

describe("finding the images worth writing again", () => {
  test("PNG and JPEG a note out of the trash shows, and nothing else", async () => {
    await db().notes.bulkPut([note("n1"), note("binned", { deletedAt: 1 })]);
    await png("shown", "n1", ["n1"], 1_000);
    await db().attachments.put(file("photo", "n1", { mime: "image/jpeg", bytes: 500 }));
    usedBy.photo = ["n1"];
    await db().attachments.put(file("webp", "n1", { mime: "image/webp" }));
    usedBy.webp = ["n1"];
    await db().attachments.put(file("gif", "n1", { mime: "image/gif" }));
    usedBy.gif = ["n1"];
    await png("unused", "n1", []);
    await png("in-bin", "binned", ["binned"]);
    await db().attachments.put(file("uploading", "n1", { status: "reserved" }));
    usedBy.uploading = ["n1"];

    const found = await find();
    expect(found.files.map((f) => f.attachmentId).sort()).toEqual(["photo", "shown"]);
    expect(found.bytes).toBe(1_500);
    expect(found.files.find((f) => f.attachmentId === "shown")).toMatchObject({
      noteId: "n1",
      mime: "image/png",
      usedBy: ["n1"],
      locked: false,
    });
  });

  test("a note whose copy here is behind is taken at the server's word", async () => {
    await db().notes.put(note("far", { snapshotSeq: 5 }));
    await png("shot", "far", ["far"]);
    expect(await find()).toMatchObject({ files: [{ attachmentId: "shot", usedBy: ["far"] }] });
  });

  test("a locked note, read with the vault closed, is taken at the server's word, not as showing nothing", async () => {
    await notesWith({ n1: [refFor("shot")] });
    await db().notes.put(note("n2", { locked: true, keyEpoch: 1 }));
    await db().bodies.put({ noteId: "n2", throughSeq: 0, keyEpoch: 1, text: null, updatedAt: 0 });
    await png("shot", "n1", ["n1", "n2"]);
    expect((await find()).files[0]?.usedBy.sort()).toEqual(["n1", "n2"]);
  });

  test("an image its own note shows is found before the server has heard of the use", async () => {
    await notesWith({ n1: [refFor("fresh")] });
    await png("fresh", "n1", []);
    expect(await find()).toMatchObject({ files: [{ attachmentId: "fresh", usedBy: ["n1"] }] });
  });

  test("a locked note's file is counted as waiting while the vault is closed, and looked at once it is open", async () => {
    (await prepareVault("パスワード", FAST_ARGON)).adopt();
    await db().notes.put(note("secret", { locked: true, keyEpoch: 1 }));
    const { ctx } = await import("@/lib/crypto/context");
    const { seal } = await import("@/lib/crypto/primitives");
    const { toArrayBuffer } = await import("@/lib/bytes");
    const { wrapped, key } = await vault.createAttachmentKey("sealed");
    const meta = await seal(
      key,
      new TextEncoder().encode(JSON.stringify({ name: "shot.png", mime: "image/png" })),
      ctx.attachmentMeta("sealed"),
    );
    await db().attachments.put(
      file("sealed", "secret", {
        locked: true,
        mime: null,
        name: null,
        wrappedKey: wrapped,
        metaSealed: { ct: toArrayBuffer(meta.ct), iv: toArrayBuffer(meta.iv) },
      }),
    );
    usedBy.sealed = ["secret"];

    expect(await find()).toMatchObject({
      files: [{ attachmentId: "sealed", mime: "image/png", locked: true }],
    });
    vault.lock();
    expect(await find()).toMatchObject({ files: [], waitingForVault: 1 });
  });
});

describe("writing them again as WebP", () => {
  test("puts one copy in place of the original in every note that shows it, and tells the server", async () => {
    await notesWith({ n1: [refFor("shot")], n2: [refFor("shot"), refFor("other")] });
    await png("shot", "n1", ["n1", "n2"], 1_000);
    const progress: number[] = [];

    const report = await run((await find()).files, { onProgress: (p) => progress.push(p.done) });
    expect(report).toMatchObject({
      total: 1,
      done: 1,
      converted: 1,
      kept: 0,
      failed: 0,
      before: 1_000,
      after: 200,
      stopped: null,
    });
    expect(progress).toEqual([1]);

    const copies = (await db().attachments.toArray()).filter((row) => row.attachmentId !== "shot");
    expect(copies).toHaveLength(1);
    const copy = copies[0]!;
    expect(copy).toMatchObject({
      noteId: "n1",
      mime: "image/webp",
      name: "image.webp",
      locked: false,
    });
    expect(await refsOf("n1")).toEqual([copy.attachmentId]);
    expect((await refsOf("n2")).sort()).toEqual([copy.attachmentId, "other"].sort());
    expect(told).toEqual([["shot"]]);
    expect(pairs).toEqual([{ original: "shot", copy: copy.attachmentId }]);
    // Nothing is left to offer, though the server has yet to hear the notes changed.
    await db().outbox.clear();
    expect((await find()).files).toEqual([]);
  });

  test("an image whose copy is not clearly smaller is left as it is", async () => {
    await notesWith({ n1: [refFor("small")] });
    await png("small", "n1", ["n1"], 1_000);
    h.prepare.mockImplementation(async () => ({
      blob: stored(Math.ceil(1_000 * KEEP_BELOW), "image/webp", "webp"),
      mime: "image/webp",
      width: 10,
      height: 10,
    }));
    expect(await run((await find()).files)).toMatchObject({ converted: 0, kept: 1 });
    expect(await refsOf("n1")).toEqual(["small"]);
    expect(await db().pendingUploads.count()).toBe(0);
    expect(told).toEqual([]);
  });

  test("does not start while this device has changes to send: a note not sent may show the file", async () => {
    await notesWith({ n1: [refFor("shot")] });
    await png("shot", "n1", ["n1"]);
    await writeBody("n1", []);
    expect(await run((await find()).files)).toMatchObject({ done: 0, stopped: "unsent" });
    expect(h.prepare).not.toHaveBeenCalled();
  });

  test("stops when the account has no room for the next copy, keeping what was done", async () => {
    await notesWith({ n1: [refFor("a"), refFor("b")] });
    await png("a", "n1", ["n1"], 1_000);
    await png("b", "n1", ["n1"], 1_000);
    const report = await run((await find()).files, {
      allowance: { ...ROOM, quotaBytes: 250, usedBytes: 0 },
    });
    expect(report).toMatchObject({ converted: 1, stopped: "quota" });
    // The one written again is told as replaced; the other is left for next time.
    expect(told.flat()).toHaveLength(1);
    expect((await refsOf("n1")).filter((id) => id === "a" || id === "b")).toHaveLength(1);
  });

  test("stops when asked to, or when the network goes, keeping what was done", async () => {
    await notesWith({ n1: [refFor("a"), refFor("b")] });
    await png("a", "n1", ["n1"]);
    await png("b", "n1", ["n1"]);
    const files = (await find()).files;
    const stop = new AbortController();
    const cancelled = await run(files, { signal: stop.signal, onProgress: () => stop.abort() });
    expect(cancelled).toMatchObject({ done: 1, converted: 1, stopped: "cancelled" });

    // Its edit sent, as the sync engine would.
    await db().outbox.clear();
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    expect(await run((await find()).files)).toMatchObject({ done: 0, stopped: "offline" });
  });

  test("an image shown by a note whose body is not here is fetched first, or left for next time", async () => {
    await db().notes.put(note("far", { snapshotSeq: 5 }));
    await png("shot", "far", ["far"]);
    // Not fetched: left as it is, nothing staged.
    expect(await run((await find()).files)).toMatchObject({ failed: 1, converted: 0 });
    expect(await db().pendingUploads.count()).toBe(0);

    // Fetched as the sync engine would: converted.
    const fetchBodies = vi.fn(async () => {
      await writeBody("far", [refFor("shot")]);
      await db().outbox.clear();
      const body = await db().bodies.get("far");
      await db().bodies.put({ ...body!, throughSeq: 5 });
    });
    expect(await run((await find()).files, { fetchBodies })).toMatchObject({ converted: 1 });
    expect(fetchBodies).toHaveBeenCalledWith(["far"]);
  });

  test("a note open in the editor meanwhile shows the copy at once", async () => {
    await notesWith({ n1: [refFor("shot")] });
    await png("shot", "n1", ["n1"]);
    const open = await acquireDoc("n1");
    try {
      await run((await find()).files);
      expect([...attachmentRefs(open)]).not.toContain("shot");
      expect([...attachmentRefs(open)]).toHaveLength(1);
    } finally {
      await releaseDoc("n1");
    }
  });

  test("a replacement the server could not be told of is told on the next run", async () => {
    await notesWith({ n1: [refFor("shot")] });
    await png("shot", "n1", ["n1"]);
    tellFails = true;
    expect(await run((await find()).files)).toMatchObject({ converted: 1 });
    expect(await getMeta(META.replacedToTell, [])).toEqual([
      { original: "shot", copy: expect.any(String) },
    ]);

    tellFails = false;
    await run([]);
    expect(told).toEqual([["shot"]]);
    expect(await getMeta(META.replacedToTell, [])).toEqual([]);
  });

  test("a copy no note takes, the image having gone from them since it was found, is left to go unused", async () => {
    await notesWith({ n1: [refFor("gone")] });
    await png("gone", "n1", ["n1"]);
    const files = (await find()).files;
    // Taken out of the note between finding it and writing it again.
    const doc = await acquireDoc("n1");
    doc.getXmlFragment(FRAGMENT).delete(0, doc.getXmlFragment(FRAGMENT).length);
    await releaseDoc("n1");
    await db().outbox.clear();

    expect(await run(files)).toMatchObject({ converted: 0, kept: 1 });
    expect(await refsOf("n1")).toEqual([]);
    // The server holds the copy by then; no note points at it, and it goes as
    // an unused file does. The original is not told replaced.
    expect(told).toEqual([]);
  });

  test("an image that cannot be written again is counted, and the rest go on", async () => {
    await notesWith({ n1: [refFor("broken"), refFor("fine")] });
    await png("broken", "n1", ["n1"]);
    await png("fine", "n1", ["n1"]);
    h.prepare.mockImplementationOnce(async () => {
      throw new Error("decode");
    });
    const report = await run((await find()).files);
    expect(report).toMatchObject({ done: 2, failed: 1, converted: 1, stopped: null });
  });

  test("a copy the server turns away is taken back: the notes left as they were, the original not told", async () => {
    await notesWith({ n1: [refFor("shot")] });
    await png("shot", "n1", ["n1"]);
    const report = await run((await find()).files, { upload: async () => "refused" });
    expect(report).toMatchObject({ converted: 0, failed: 1, stopped: null });
    expect(await refsOf("n1")).toEqual(["shot"]);
    expect(await db().pendingUploads.count()).toBe(0);
    expect(told).toEqual([]);
  });

  test("a copy not on the server in time stops the run, before any note points at it", async () => {
    await notesWith({ n1: [refFor("a"), refFor("b")] });
    await png("a", "n1", ["n1"]);
    await png("b", "n1", ["n1"]);
    const send = vi.fn();
    const report = await run((await find()).files, { upload: async () => "timeout", send });
    expect(report).toMatchObject({ done: 0, converted: 0, stopped: "offline" });
    expect(send).toHaveBeenCalledOnce();
    expect((await refsOf("n1")).sort()).toEqual(["a", "b"]);
    expect(await db().pendingUploads.count()).toBe(0);
    expect(told).toEqual([]);
  });

  test("the copy is sent at once, and only then does any note point at it", async () => {
    await notesWith({ n1: [refFor("shot")] });
    await png("shot", "n1", ["n1"]);
    const seenAtUpload: string[][] = [];
    const report = await run((await find()).files, {
      upload: async () => {
        seenAtUpload.push(await refsOf("n1"));
        return "committed";
      },
    });
    expect(report.converted).toBe(1);
    expect(seenAtUpload).toEqual([["shot"]]);
  });

  test("the copy belongs to a note out of the trash that shows it, when the original's own is not", async () => {
    await notesWith({ n2: [refFor("shot")] });
    // Its own note is in the trash, the image living on where it was copied to.
    await db().notes.put(note("n1", { deletedAt: 1 }));
    await png("shot", "n1", ["n1", "n2"]);
    await run((await find()).files);
    const copy = (await db().attachments.toArray()).find((row) => row.attachmentId !== "shot")!;
    expect(copy.noteId).toBe("n2");
  });

  test("the account's figures are read for each image, as each copy counts", async () => {
    await notesWith({ n1: [refFor("a"), refFor("b")] });
    await png("a", "n1", ["n1"]);
    await png("b", "n1", ["n1"]);
    let used = 0;
    const allowance = {
      get quotaBytes() {
        return 300;
      },
      get usedBytes() {
        return used;
      },
      reservedBytes: 0,
    };
    // The first copy reaches the server, and counts there.
    const report = await run((await find()).files, {
      allowance,
      upload: async () => {
        used += 200;
        await db().pendingUploads.clear();
        return "committed";
      },
    });
    expect(report).toMatchObject({ converted: 1, stopped: "quota" });
  });

  test("an image that came to no less is not offered again", async () => {
    await notesWith({ n1: [refFor("small")] });
    await png("small", "n1", ["n1"], 1_000);
    h.prepare.mockImplementation(async () => ({
      blob: stored(950, "image/webp", "webp"),
      mime: "image/webp",
      width: 10,
      height: 10,
    }));
    expect(await run((await find()).files)).toMatchObject({ kept: 1 });
    expect((await find()).files).toEqual([]);
  });

  test("more than the server takes at once are asked about, and told, in parts", async () => {
    const notes: Record<string, string[]> = {};
    for (let i = 0; i <= MAX_REPLACED_PER_CALL; i += 1) notes[`n${i}`] = [refFor(`f${i}`)];
    await notesWith(notes);
    for (let i = 0; i <= MAX_REPLACED_PER_CALL; i += 1) await png(`f${i}`, `n${i}`, [`n${i}`]);
    const found = await find();
    expect(found.files).toHaveLength(MAX_REPLACED_PER_CALL + 1);
    expect(asked).toEqual([MAX_REPLACED_PER_CALL, 1]);

    await setMetaWaiting(120);
    await run([]);
    expect(told.map((part) => part.length)).toEqual([50, 50, 20]);
    expect(await getMeta(META.replacedToTell, [])).toEqual([]);
  }, 30_000);

  test("a note whose body cannot be fetched leaves the image for next time, in every note", async () => {
    await notesWith({ n1: [refFor("shot")] });
    await db().notes.put(note("far", { snapshotSeq: 5 }));
    await png("shot", "n1", ["n1", "far"]);
    const report = await run((await find()).files, {
      fetchBodies: async () => {
        throw new Error("offline");
      },
    });
    expect(report).toMatchObject({ failed: 1, converted: 0 });
    // Not in n1 either: the original must not be told replaced while far shows it.
    expect(await refsOf("n1")).toEqual(["shot"]);
    expect(await db().pendingUploads.count()).toBe(0);
  });

  test("a locked note's file waits while the vault is closed", async () => {
    await db().notes.put(note("secret", { locked: true, keyEpoch: 1 }));
    const locked: Convertible = {
      attachmentId: "sealed",
      noteId: "secret",
      bytes: 1_000,
      mime: "image/png",
      name: "shot.png",
      locked: true,
      usedBy: ["secret"],
    };
    expect(await run([locked])).toMatchObject({ failed: 1, converted: 0 });
    expect(h.prepare).not.toHaveBeenCalled();
  });
});

describe("an animated PNG", () => {
  const png = (chunks: string[]) =>
    new Blob([
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      ...chunks.map((c) => new TextEncoder().encode(`\0\0\0\0${c}`)),
    ]);

  test("is told by its animation control chunk before the image data", async () => {
    expect(await isAnimatedPng(png(["IHDR", "acTL", "IDAT"]))).toBe(true);
    expect(await isAnimatedPng(png(["IHDR", "IDAT"]))).toBe(false);
    // A chunk named so in the pixels' place does not count.
    expect(await isAnimatedPng(png(["IHDR", "IDAT", "acTL"]))).toBe(false);
  });
});

describe("waiting for a copy to reach the server", () => {
  const ID = "copy-1";
  const QUICK = { pollMs: 5, timeoutMs: 200 };
  const waitingHere = () =>
    db().pendingUploads.put({
      attachmentId: ID,
      noteId: "n1",
      blob: stored(200, "image/webp", "copy"),
      mime: "image/webp",
      name: "image.webp",
      width: 1,
      height: 1,
      category: "image",
      locked: false,
      createdAt: 0,
    } as never);
  /** Storage that has the copy from the `from`th time it is asked. */
  const storage = (from: number) => {
    let asks = 0;
    return fakeConvex({
      "attachments:urls": () => ({
        [ID]: (asks += 1) >= from ? "https://storage.test/copy" : null,
      }),
    }).client;
  };

  test("is over once the server holds it", async () => {
    await waitingHere();
    expect(await untilStored(storage(3), ID, undefined, QUICK)).toBe("committed");
  });

  test("the server turned it away once nothing of it is left here to send and it has none", async () => {
    expect(await untilStored(storage(Infinity), ID, undefined, QUICK)).toBe("refused");
  });

  test("gives up with no network, when stopped, and in time", async () => {
    await waitingHere();
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    expect(await untilStored(storage(Infinity), ID, undefined, QUICK)).toBe("offline");
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });

    const stop = new AbortController();
    stop.abort();
    expect(await untilStored(storage(Infinity), ID, stop.signal, QUICK)).toBe("cancelled");

    expect(await untilStored(storage(Infinity), ID, undefined, QUICK)).toBe("timeout");
  });
});
