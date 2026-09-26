import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { db, resetLocalData } from "@/lib/db";
import {
  AttachmentUnavailableError,
  discardStaged,
  fitsAllowance,
  idFromRef,
  loadAttachmentBlob,
  queuedBytes,
  stageUpload,
} from "@/lib/media/attachments";
import type { Note } from "@/lib/types";
import { fakeConvex } from "./helpers/fake-convex";

const zero = { t: 0, d: "test" };

async function putNote(noteId: string, locked: boolean) {
  await db().notes.put({
    noteId,
    folderId: null,
    kind: "note",
    title: locked ? null : "メモ",
    preview: null,
    pinned: false,
    sortKey: "a",
    locked,
    keyEpoch: locked ? 1 : 0,
    deletedAt: null,
    purged: false,
    updatedAt: 0,
    ts: { title: zero, place: zero, pin: zero, trash: zero, lock: zero },
    seq: 0,
    lastUpdateSeq: 0,
  } as unknown as Note);
}

/**
 * jsdom's Blob does not survive a trip through fake-indexeddb, so tests store
 * a labelled stand-in and check which one comes back.
 */
const image = (size: number, label = "image", type = "image/webp") =>
  ({ size, type, label }) as unknown as Blob;

// jsdom has no object URLs; staging only needs a string back.
let nextUrl = 0;
URL.createObjectURL = () => `blob:test/${nextUrl++}`;
URL.revokeObjectURL = () => {};

beforeEach(async () => {
  await resetLocalData();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stageUpload with an image that is already encoded", () => {
  test("stores it as given, without compressing it again", async () => {
    await putNote("n1", false);
    const blob = image(1234, "photo", "image/jpeg");
    const ref = await stageUpload({
      noteId: "n1",
      file: new File([blob], "写真.png", { type: "image/jpeg" }),
      prepared: { blob, mime: "image/jpeg", width: 200, height: 150 },
    });
    const id = idFromRef(ref)!;
    const pending = await db().pendingUploads.get(id);
    expect(pending).toMatchObject({
      mime: "image/jpeg",
      width: 200,
      height: 150,
      name: "写真.png",
      locked: false,
    });
    expect(pending?.blob).toMatchObject({ label: "photo" });
    expect(await db().attachments.get(id)).toMatchObject({
      status: "reserved",
      bytes: 1234,
      locked: false,
    });
  });

  test("marks the file locked when the note is locked now, whatever the caller thought", async () => {
    await putNote("n2", true);
    const blob = image(10);
    const ref = await stageUpload({
      noteId: "n2",
      file: new File([blob], "a.webp", { type: "image/webp" }),
      locked: false,
      prepared: { blob, mime: "image/webp", width: 1, height: 1 },
    });
    const id = idFromRef(ref)!;
    expect((await db().pendingUploads.get(id))?.locked).toBe(true);
    expect((await db().attachments.get(id))?.locked).toBe(true);
  });

  test("a staged file can be taken back before it uploads", async () => {
    await putNote("n3", false);
    const blob = image(10);
    const ref = await stageUpload({
      noteId: "n3",
      file: new File([blob], "a.webp", { type: "image/webp" }),
      prepared: { blob, mime: "image/webp", width: 1, height: 1 },
    });
    await discardStaged(idFromRef(ref)!);
    expect(await db().pendingUploads.count()).toBe(0);
    expect(await db().attachments.count()).toBe(0);
  });
});

describe("loadAttachmentBlob", () => {
  const server = () => fakeConvex({ "attachments:urls": () => ({}) });

  test("reads a file still waiting to upload", async () => {
    await putNote("n1", false);
    const blob = image(42, "waiting");
    const ref = await stageUpload({
      noteId: "n1",
      file: new File([blob], "a.webp", { type: "image/webp" }),
      prepared: { blob, mime: "image/webp", width: 1, height: 1 },
    });
    const loaded = await loadAttachmentBlob(server().client, idFromRef(ref)!);
    expect(loaded).toMatchObject({ label: "waiting" });
  });

  test("reads a plain file from the device cache", async () => {
    await db().attachments.put({
      attachmentId: "a1",
      noteId: "n1",
      status: "committed",
      bytes: 7,
      mime: "image/webp",
      name: "a.webp",
      locked: false,
      width: 1,
      height: 1,
      deletedAt: null,
      seq: 1,
    });
    await db().blobs.put({ attachmentId: "a1", blob: image(7, "cached"), bytes: 7, lastUsed: 0 });
    expect(await loadAttachmentBlob(server().client, "a1")).toMatchObject({ label: "cached" });
  });

  test("ignores a plaintext copy of a locked file, and says so when offline", async () => {
    await db().attachments.put({
      attachmentId: "a2",
      noteId: "n2",
      status: "committed",
      bytes: 7,
      mime: null,
      name: null,
      locked: true,
      width: 1,
      height: 1,
      deletedAt: null,
      seq: 1,
    });
    await db().blobs.put({ attachmentId: "a2", blob: image(7), bytes: 7, lastUsed: 0 });
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const failure = loadAttachmentBlob(server().client, "a2");
    await expect(failure).rejects.toBeInstanceOf(AttachmentUnavailableError);
    await expect(failure).rejects.toMatchObject({ reason: "offline" });
  });

  test("a file the server does not know is missing, not offline", async () => {
    await expect(loadAttachmentBlob(server().client, "nothing")).rejects.toMatchObject({
      reason: "missing",
    });
  });
});

describe("fitsAllowance", () => {
  const me = {
    quotaBytes: 1000,
    usedBytes: 600,
    reservedBytes: 100,
    limits: { maxImageBytes: 500 },
  };

  test("counts what is used and what is reserved", () => {
    expect(fitsAllowance(me, 300)).toBe(true);
    expect(fitsAllowance(me, 301)).toBe(false);
  });

  test("refuses an image over the per-image cap even with room to spare", () => {
    expect(fitsAllowance({ ...me, usedBytes: 0, reservedBytes: 0 }, 501)).toBe(false);
  });

  test("works from an account snapshot saved before limits were reported", () => {
    expect(fitsAllowance({ quotaBytes: 1000, usedBytes: 0, reservedBytes: 0 }, 900)).toBe(true);
  });

  test("counts what this device is still to upload", () => {
    expect(fitsAllowance(me, 200, 100)).toBe(true);
    expect(fitsAllowance(me, 200, 101)).toBe(false);
  });

  test("holds a video, or any other file, to the other limit, as the server does", () => {
    const roomy = { quotaBytes: 10_000, usedBytes: 0, reservedBytes: 0 };
    const limits = { maxImageBytes: 500, maxVideoBytes: 2_000 };
    expect(fitsAllowance({ ...roomy, limits }, 1_500, 0, "video")).toBe(true);
    expect(fitsAllowance({ ...roomy, limits }, 2_001, 0, "video")).toBe(false);
    expect(fitsAllowance({ ...roomy, limits }, 2_001, 0, "other")).toBe(false);
    expect(fitsAllowance({ ...roomy, limits }, 501, 0, "image")).toBe(false);
    // Not reported by an older server: left to the server to decide.
    expect(fitsAllowance({ ...roomy, limits: { maxImageBytes: 500 } }, 5_000, 0, "video")).toBe(true);
  });
});

describe("queuedBytes", () => {
  test("adds up every file waiting to upload", async () => {
    await putNote("n1", false);
    expect(await queuedBytes()).toBe(0);
    for (const size of [30, 12]) {
      const blob = image(size);
      await stageUpload({
        noteId: "n1",
        file: new File([blob], "a.webp", { type: "image/webp" }),
        prepared: { blob, mime: "image/webp", width: 1, height: 1 },
      });
    }
    expect(await queuedBytes()).toBe(42);
  });
});
