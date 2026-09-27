import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { toArrayBuffer } from "@/lib/bytes";
import { ctx } from "@/lib/crypto/context";
import { seal } from "@/lib/crypto/primitives";
import { prepareVault, vault } from "@/lib/crypto/vault";
import { db, resetLocalData } from "@/lib/db";
import {
  AttachmentUnavailableError,
  discardStaged,
  fitsAllowance,
  flushUploads,
  idFromRef,
  loadAttachmentBlob,
  queuedBytes,
  resolveAttachment,
  stageUpload,
} from "@/lib/media/attachments";
import type { Note } from "@/lib/types";
import { fakeConvex } from "./helpers/fake-convex";
import { FAST_ARGON } from "./helpers/seed";

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

describe("resolveAttachment and the vault", () => {
  // Storage serves every file asked for.
  const server = () =>
    fakeConvex({
      "attachments:urls": (args) =>
        Object.fromEntries(
          (args.attachmentIds as string[]).map((id) => [id, `https://storage.test/${id}`]),
        ),
    });
  let revoked: string[];

  beforeEach(async () => {
    (await prepareVault("パスワード", FAST_ARGON)).adopt();
    revoked = [];
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      revoked.push(url);
    });
  });

  afterEach(() => {
    vault.lock();
    vi.unstubAllGlobals();
  });

  /**
   * A locked note's file as the server holds it, sealed under the open vault,
   * and storage serving it. `onFetch` runs while it is being downloaded.
   */
  async function lockedFile(attachmentId: string, onFetch = () => {}, mime = "image/webp") {
    await putNote("n-locked", true);
    const { key, wrapped } = await vault.createAttachmentKey(attachmentId);
    const body = await seal(key, new Uint8Array([1, 2, 3]), ctx.attachmentBody(attachmentId));
    const meta = await seal(
      key,
      new TextEncoder().encode(JSON.stringify({ name: "a", mime })),
      ctx.attachmentMeta(attachmentId),
    );
    await db().attachments.put({
      attachmentId,
      noteId: "n-locked",
      status: "committed",
      bytes: body.ct.byteLength,
      mime: null,
      name: null,
      locked: true,
      wrappedKey: wrapped,
      contentIv: toArrayBuffer(body.iv),
      metaSealed: { ct: toArrayBuffer(meta.ct), iv: toArrayBuffer(meta.iv) },
      width: 1,
      height: 1,
      deletedAt: null,
      seq: 1,
    });
    const stored = toArrayBuffer(body.ct);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        onFetch();
        return new Response(stored);
      }),
    );
  }

  /** A plain file uploaded from this device, kept in its cache. */
  async function cachedPlainFile(attachmentId: string) {
    await db().attachments.put({
      attachmentId,
      noteId: "n-plain",
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
    await db().blobs.put({ attachmentId, blob: image(7, "cached"), bytes: 7, lastUsed: 0 });
  }

  test("a decrypted file's URL is revoked when the vault closes, with no workspace shell mounted", async () => {
    const client = server().client;
    await lockedFile("secret-1");
    const url = await resolveAttachment(client, "secret-1");
    expect(url).toMatch(/^blob:/);

    // Closed for inactivity, as it can be on the quick note, which has no
    // workspace shell.
    await vault.close("idle");
    expect(revoked).toContain(url);
    expect(await resolveAttachment(client, "secret-1")).toBeNull();
  });

  test("a locked file's URL is not handed out while the vault is closed", async () => {
    const client = server().client;
    await putNote("n-locked", true);
    vault.lock();
    // Dropped into a locked note as the vault closed: staged once the close
    // had revoked everything else, so its URL is still kept.
    const blob = image(10, "secret");
    const ref = await stageUpload({
      noteId: "n-locked",
      file: new File([blob], "a.webp", { type: "image/webp" }),
      prepared: { blob, mime: "image/webp", width: 1, height: 1 },
    });
    expect(await resolveAttachment(client, idFromRef(ref)!)).toBeNull();
  });

  test("nor is the URL of a file locked since it was shown", async () => {
    const client = server().client;
    vault.lock();
    await cachedPlainFile("photo-2");
    expect(await resolveAttachment(client, "photo-2")).toMatch(/^blob:/);
    // Its note was locked on another device, and the change has arrived.
    await db().attachments.update("photo-2", { locked: true });
    expect(await resolveAttachment(client, "photo-2")).toBeNull();
  });

  test("a plain file's URL is handed out as before while the vault is closed", async () => {
    const client = server().client;
    await putNote("n-plain", false);
    vault.lock();
    await cachedPlainFile("photo-3");
    const blob = image(10, "waiting");
    const waiting = idFromRef(
      await stageUpload({
        noteId: "n-plain",
        file: new File([blob], "b.webp", { type: "image/webp" }),
        prepared: { blob, mime: "image/webp", width: 1, height: 1 },
      }),
    )!;

    for (const id of ["photo-3", waiting]) {
      const url = await resolveAttachment(client, id);
      expect(url).toMatch(/^blob:/);
      expect(await resolveAttachment(client, id)).toBe(url);
      expect(revoked).not.toContain(url);
    }
  });

  test("the same locked file shown twice at once is decrypted once, and its URL goes with the vault", async () => {
    const client = server().client;
    await lockedFile("secret-5");
    const made = vi.spyOn(URL, "createObjectURL");
    // Both ask before either has its URL: the same image twice in a note.
    const [a, b] = await Promise.all([
      resolveAttachment(client, "secret-5"),
      resolveAttachment(client, "secret-5"),
    ]);
    expect(a).toMatch(/^blob:/);
    expect(b).toBe(a);
    expect(made).toHaveBeenCalledOnce();

    await vault.close("idle");
    expect(revoked).toEqual([a]);
  });

  test("a locked file of a type that would run as a page is handed out as bytes to download", async () => {
    const client = server().client;
    const made = vi.spyOn(URL, "createObjectURL");
    const typeOf = () => (made.mock.lastCall![0] as Blob).type;

    await lockedFile("page-6", () => {}, "text/html");
    await resolveAttachment(client, "page-6");
    expect(typeOf()).toBe("application/octet-stream");

    await lockedFile("drawing-7", () => {}, "image/svg+xml");
    await resolveAttachment(client, "drawing-7");
    expect(typeOf()).toBe("application/octet-stream");

    // Waiting to go up, in plaintext on the device, it is handed out the same.
    const page = new File(["<script>1</script>"], "a.html", { type: "text/html" });
    await stageUpload({
      noteId: "n-locked",
      file: page,
      prepared: { blob: page, mime: "text/html", width: 0, height: 0 },
    });
    expect(typeOf()).toBe("application/octet-stream");

    // What can only be looked at keeps its type, to be shown.
    for (const [id, type] of [
      ["photo-8", "image/webp"],
      ["clip-9", "video/mp4"],
      ["paper-10", "application/pdf"],
    ] as const) {
      await lockedFile(id, () => {}, type);
      await resolveAttachment(client, id);
      expect(typeOf(), type).toBe(type);
    }
  });

  test("a file still being decrypted when the vault closes is not shown", async () => {
    const client = server().client;
    // The vault closes while the file is on its way from storage.
    await lockedFile("secret-4", () => vault.lock());
    const made = vi.spyOn(URL, "createObjectURL");
    expect(await resolveAttachment(client, "secret-4")).toBeNull();
    expect(made).not.toHaveBeenCalled();
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
    expect(fitsAllowance({ ...roomy, limits: { maxImageBytes: 500 } }, 5_000, 0, "video")).toBe(
      true,
    );
  });
});

describe("flushUploads", () => {
  test("a file for a note the server has not heard of yet waits for it, and then goes up", async () => {
    // A note made offline: its file goes up before the note itself does.
    await putNote("n1", false);
    await stageUpload({
      noteId: "n1",
      file: new File([], "a.webp", { type: "image/webp" }),
      prepared: { blob: image(10), mime: "image/webp", width: 1, height: 1 },
    });
    const server = fakeConvex({
      "attachments:reserve": () => ({ status: "rejected", reason: "unknownNote", uploadUrl: null }),
    });
    await flushUploads(server.client);
    expect(await db().pendingUploads.count()).toBe(1);
    expect(await db().attachments.count()).toBe(1);

    // Once the note is through, the next pass sends the file.
    server.handlers["attachments:reserve"] = () => ({
      status: "ok",
      uploadUrl: "https://upload.test",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ storageId: "stored-1" }))),
    );
    try {
      await flushUploads(server.client);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(await db().pendingUploads.count()).toBe(0);
  });

  test("a file the server has reserved room for is no longer counted as waiting here", async () => {
    await putNote("n1", false);
    await stageUpload({
      noteId: "n1",
      file: new File([], "a.webp", { type: "image/webp" }),
      prepared: { blob: image(10), mime: "image/webp", width: 1, height: 1 },
    });
    expect(await queuedBytes()).toBe(10);
    const server = fakeConvex({
      "attachments:reserve": () => ({ status: "ok", uploadUrl: "https://upload.test" }),
    });
    // Reserved, then the upload itself does not get through.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("network"))),
    );
    try {
      await flushUploads(server.client);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(await db().pendingUploads.count()).toBe(1);
    expect(await queuedBytes()).toBe(0);
  });

  test("a file for a note gone from this device is given up", async () => {
    await putNote("n1", false);
    await stageUpload({
      noteId: "n1",
      file: new File([], "a.webp", { type: "image/webp" }),
      prepared: { blob: image(10), mime: "image/webp", width: 1, height: 1 },
    });
    await db().notes.delete("n1");
    const server = fakeConvex({
      "attachments:reserve": () => ({ status: "rejected", reason: "unknownNote", uploadUrl: null }),
    });
    await expect(flushUploads(server.client)).rejects.toThrow();
    expect(await db().pendingUploads.count()).toBe(0);
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
