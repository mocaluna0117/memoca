import "fake-indexeddb/auto";
import { afterEach, expect, test, vi } from "vitest";
import { toArrayBuffer } from "@/lib/bytes";
import { ctx } from "@/lib/crypto/context";
import { seal } from "@/lib/crypto/primitives";
import { prepareVault, vault } from "@/lib/crypto/vault";
import { db, resetLocalData } from "@/lib/db";
import { resolveAttachment } from "@/lib/media/attachments";
import type { Note } from "@/lib/types";
import { fakeConvex } from "./helpers/fake-convex";
import { FAST_ARGON } from "./helpers/seed";

// A file of its own, with this its only test: attachments.ts starts watching
// the vault on its first use, and here, as on a device that opens a locked
// note before adding any file, that first use is showing one.

let nextUrl = 0;
URL.createObjectURL = () => `blob:test/${nextUrl++}`;
const revoked: string[] = [];
URL.revokeObjectURL = (url: string) => void revoked.push(url);

afterEach(() => {
  vault.lock();
  vi.unstubAllGlobals();
});

test("the first file shown, before any is added, is revoked when the vault closes", async () => {
  await resetLocalData();
  (await prepareVault("パスワード", FAST_ARGON)).adopt();
  const zero = { t: 0, d: "test" };
  await db().notes.put({
    noteId: "n",
    folderId: null,
    kind: "note",
    title: null,
    preview: null,
    pinned: false,
    sortKey: "a",
    locked: true,
    keyEpoch: 1,
    deletedAt: null,
    purged: false,
    updatedAt: 0,
    ts: { title: zero, place: zero, pin: zero, trash: zero, lock: zero },
    seq: 0,
    lastUpdateSeq: 0,
  } as unknown as Note);
  const { key, wrapped } = await vault.createAttachmentKey("s");
  const body = await seal(key, new Uint8Array([1, 2, 3]), ctx.attachmentBody("s"));
  const meta = await seal(
    key,
    new TextEncoder().encode(JSON.stringify({ name: "a.webp", mime: "image/webp" })),
    ctx.attachmentMeta("s"),
  );
  await db().attachments.put({
    attachmentId: "s",
    noteId: "n",
    status: "committed",
    bytes: 3,
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(toArrayBuffer(body.ct))),
  );
  const { client } = fakeConvex({ "attachments:urls": () => ({ s: "https://storage.test/s" }) });

  const url = await resolveAttachment(client, "s");
  expect(url).toMatch(/^blob:/);
  await vault.close("idle");
  expect(revoked).toContain(url);
});
