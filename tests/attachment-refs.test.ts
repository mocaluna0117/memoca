import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { prepareVault, vault } from "@/lib/crypto/vault";
import { db, resetLocalData } from "@/lib/db";
import { refFor } from "@/lib/media/ref";
import { reportAttachmentRefs, resetReportRefs } from "@/lib/media/report-refs";
import { FRAGMENT, attachmentRefs } from "@/lib/sync/ydoc";
import type { Note } from "@/lib/types";
import { fakeConvex } from "./helpers/fake-convex";
import { FAST_ARGON, zero } from "./helpers/seed";

/** A note body shaped like BlockNote's: blocks carry their props as attributes. */
function noteDoc(build: (blocks: Y.XmlElement) => void): Y.Doc {
  const doc = new Y.Doc();
  const group = new Y.XmlElement("blockGroup");
  doc.getXmlFragment(FRAGMENT).insert(0, [group]);
  build(group);
  return doc;
}

function block(group: Y.XmlElement, content: Y.XmlElement | Y.XmlText) {
  const container = new Y.XmlElement("blockContainer");
  group.insert(group.length, [container]);
  const inner = content instanceof Y.XmlText ? new Y.XmlElement("paragraph") : content;
  container.insert(0, [inner]);
  if (content instanceof Y.XmlText) inner.insert(0, [content]);
}

function image(url: string) {
  const element = new Y.XmlElement("image");
  element.setAttribute("url", url);
  element.setAttribute("caption", "");
  return element;
}

describe("the files a note uses", () => {
  test("images, videos and files are found by their url, once each", () => {
    const doc = noteDoc((group) => {
      block(group, image(refFor("img-1")));
      block(group, image(refFor("img-1")));
      const video = new Y.XmlElement("video");
      video.setAttribute("url", refFor("vid-1"));
      block(group, video);
    });
    expect(attachmentRefs(doc)).toEqual(["img-1", "vid-1"]);
  });

  test("a link to a file in text counts, anything that is not a file does not", () => {
    const doc = noteDoc((group) => {
      const text = new Y.XmlText();
      block(group, text);
      text.insert(0, "資料", { link: { href: refFor("doc-1") } });
      text.insert(2, " と外のリンク", { link: { href: "https://example.com/a.png" } });
      block(group, image("https://example.com/b.png"));
    });
    expect(attachmentRefs(doc)).toEqual(["doc-1"]);
  });

  test("an empty note uses nothing", () => {
    expect(attachmentRefs(new Y.Doc())).toEqual([]);
  });
});

describe("reporting them to the server", () => {
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
    lastUpdateSeq: 5,
    snapshotSeq: 0,
    ts: { title: zero, preview: zero, place: zero, pin: zero, trash: zero, lock: zero },
    seq: 0,
    updatedAt: 0,
    ...over,
  });

  /** A note this device holds exactly as the server does, with one image. */
  async function syncedNote(noteId: string, over: Partial<Note> = {}, refs = ["img-1"]) {
    const doc = noteDoc((group) => {
      for (const id of refs) block(group, image(refFor(id)));
    });
    const row = note(noteId, over);
    await db().notes.put(row);
    await db().bodies.put({
      noteId,
      throughSeq: row.lastUpdateSeq,
      keyEpoch: row.keyEpoch,
      text: "",
      updatedAt: 0,
    });
    await db().updates.add({
      noteId,
      seq: row.lastUpdateSeq,
      opId: `op-${noteId}`,
      keyEpoch: row.keyEpoch,
      data: Y.encodeStateAsUpdate(doc),
      pushed: 1,
      createdAt: 0,
    });
  }

  let server: ReturnType<typeof fakeConvex>;
  const fetched: string[][] = [];
  const run = () =>
    reportAttachmentRefs(server.client, async (ids) => {
      fetched.push(ids);
    });

  beforeEach(async () => {
    await resetLocalData();
    resetReportRefs();
    fetched.length = 0;
    server = fakeConvex({ "attachments:reportRefs": () => ({ status: "ok" }) });
  });

  afterEach(() => vault.lock());

  test("reports a note that changed since its last report, and remembers it", async () => {
    await syncedNote("n1", { refsThroughSeq: 2 });
    expect(await run()).toBe(1);
    expect(server.callsTo("attachments:reportRefs")[0]!.args).toEqual({
      noteId: "n1",
      throughSeq: 5,
      refs: ["img-1"],
    });
    expect((await db().notes.get("n1"))?.refsThroughSeq).toBe(5);
    // Up to date now: nothing more to say.
    resetReportRefs();
    expect(await run()).toBe(0);
  });

  test("a note never reported, with nothing in it, is reported as using nothing", async () => {
    await db().notes.put(note("empty", { lastUpdateSeq: 0 }));
    expect(await run()).toBe(1);
    expect(server.callsTo("attachments:reportRefs")[0]!.args).toMatchObject({ throughSeq: 0, refs: [] });
  });

  test("waits while its own changes are still unsent", async () => {
    await syncedNote("n1");
    await db().updates.add({
      noteId: "n1",
      seq: null,
      opId: "local",
      keyEpoch: 0,
      data: new Uint8Array(),
      pushed: 0,
      createdAt: 0,
    });
    expect(await run()).toBe(0);
    expect(server.callsTo("attachments:reportRefs")).toHaveLength(0);
  });

  test("fetches a note it does not hold yet, and reports it later", async () => {
    await db().notes.put(note("remote"));
    expect(await run()).toBe(0);
    expect(fetched).toEqual([["remote"]]);
    expect(server.callsTo("attachments:reportRefs")).toHaveLength(0);
  });

  test("a locked note waits for the vault", async () => {
    await syncedNote("secret", {
      locked: true,
      keyEpoch: 1,
      wrappedKey: { ct: new ArrayBuffer(48), iv: new ArrayBuffer(12) },
    });
    expect(await run()).toBe(0);
    expect(server.callsTo("attachments:reportRefs")).toHaveLength(0);
  });

  test("a locked note that cannot be opened is never reported as using nothing", async () => {
    (await prepareVault("パスワード", FAST_ARGON)).adopt();
    // Its key is not one this vault can unwrap.
    await syncedNote("unreadable", {
      locked: true,
      keyEpoch: 1,
      wrappedKey: { ct: new ArrayBuffer(48), iv: new ArrayBuffer(12) },
    });
    expect(await run()).toBe(0);
    expect(server.callsTo("attachments:reportRefs")).toHaveLength(0);
  });

  test("a note whose content reads as nothing at all is not reported", async () => {
    await db().notes.put(note("hollow"));
    await db().bodies.put({ noteId: "hollow", throughSeq: 5, keyEpoch: 0, text: "", updatedAt: 0 });
    expect(await run()).toBe(0);
    expect(server.callsTo("attachments:reportRefs")).toHaveLength(0);
  });

  test("a refused report is kept for later and not retried at once", async () => {
    server.handlers["attachments:reportRefs"] = () => ({ status: "stale" });
    await syncedNote("n1");
    expect(await run()).toBe(0);
    expect((await db().notes.get("n1"))?.refsThroughSeq).toBeUndefined();
    await run();
    expect(server.callsTo("attachments:reportRefs")).toHaveLength(1);
  });
});
