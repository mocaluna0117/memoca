import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { db, resetLocalData } from "@/lib/db";
import { acquireDoc, flushDoc, releaseDoc } from "@/lib/sync/docs";
import { keepVersion, openVersion, restoreVersion, stateBeforeEdits } from "@/lib/sync/versions";
import { bodyFragment } from "@/lib/sync/ydoc";
import type { Note } from "@/lib/types";
import { fakeConvex } from "./helpers/fake-convex";
import { zero } from "./helpers/seed";

const note = (): Note => ({
  noteId: "n1",
  folderId: null,
  kind: "note",
  title: "メモ",
  preview: null,
  pinned: false,
  sortKey: "a",
  locked: false,
  keyEpoch: 0,
  deletedAt: null,
  purged: false,
  lastUpdateSeq: 1,
  snapshotSeq: 0,
  ts: { title: zero, preview: zero, place: zero, pin: zero, trash: zero, lock: zero },
  seq: 1,
  updatedAt: 0,
});

/** A line of text at the end of a note's body, as a paragraph would hold it. */
function addLine(doc: Y.Doc, text: string) {
  const paragraph = new Y.XmlElement("paragraph");
  bodyFragment(doc).push([paragraph]);
  paragraph.insert(0, [new Y.XmlText(text)]);
}

/** The text of a body's lines. */
const lines = (doc: Y.Doc) =>
  bodyFragment(doc)
    .toArray()
    .map((node) =>
      (node as Y.XmlElement)
        .toArray()
        .map((child) => child.toString())
        .join(""),
    );

/** What storage holds, and what was uploaded to it. */
let stored: Map<string, Uint8Array>;
const server = () =>
  fakeConvex({
    "notes:snapshotUploadUrl": () => "https://upload.test/",
    "versions:save": () => ({ status: "ok" }),
    "versions:get": ({ versionId }) => ({
      noteId: "n1",
      keyEpoch: 0,
      createdAt: 0,
      url: `https://storage.test/${versionId as string}`,
      iv: null,
    }),
  });

beforeEach(async () => {
  await resetLocalData();
  await db().notes.put(note());
  stored = new Map();
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const id = `s${stored.size + 1}`;
      stored.set(id, new Uint8Array(init.body as ArrayBuffer));
      return new Response(JSON.stringify({ storageId: id }));
    }
    const id = url.split("/").pop()!;
    return new Response(stored.get(id) as Uint8Array<ArrayBuffer>);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Something typed in the note, stored here, and sent (pushed) or not. */
async function typed(text: string, sent: boolean) {
  const doc = await acquireDoc("n1");
  try {
    addLine(doc, text);
    await flushDoc("n1");
  } finally {
    await releaseDoc("n1");
  }
  // Sent, as the server's echo marks it (sync/apply.ts).
  if (sent) {
    for (const row of await db().updates.toArray()) {
      // A fresh array: fake-indexeddb's copy of one read back is not one Yjs reads.
      await db().updates.put({
        ...row,
        data: Uint8Array.from(row.data),
        pushed: 1,
        seq: row.seq ?? 1,
      });
    }
  }
}

describe("a version kept before edits go out", () => {
  test("is the note as the server has it, without the edits about to be sent", async () => {
    await typed("前からある行", true);
    await typed("いま書いた行", false);
    const state = (await stateBeforeEdits("n1"))!;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    expect(lines(doc)).toEqual(["前からある行"]);
  });

  test("is not due again for ten minutes once kept", async () => {
    await typed("前からある行", true);
    const client = server();
    const state = (await stateBeforeEdits("n1"))!;
    expect(await keepVersion(client.client, "n1", state)).toBe(true);
    expect(await stateBeforeEdits("n1")).toBeNull();
    expect(client.callsTo("versions:save")).toHaveLength(1);
  });

  test("is nothing for a note with nothing in it yet", async () => {
    await typed("最初の行", false);
    expect(await stateBeforeEdits("n1")).toBeNull();
  });
});

describe("putting a note back as it was", () => {
  test("makes its body the version's, as an edit to send, and keeps the note as it was first", async () => {
    await typed("昔の行", true);
    const client = server();
    await keepVersion(client.client, "n1", (await stateBeforeEdits("n1"))!);
    await typed("あとで足した行", false);
    await db().outbox.clear();

    const version = await openVersion(client.client, "s1" as never);
    expect(lines(version)).toEqual(["昔の行"]);
    await restoreVersion(client.client, "n1", version);

    const doc = await acquireDoc("n1");
    try {
      expect(lines(doc)).toEqual(["昔の行"]);
    } finally {
      await releaseDoc("n1");
    }
    // Sent to every device, as any edit.
    expect(await db().outbox.where("kind").equals("update").count()).toBeGreaterThan(0);
    // And the note as it was just before, kept to undo this.
    const saves = client.callsTo("versions:save");
    expect(saves.at(-1)!.args.beforeRestore).toBe(true);
    const before = new Y.Doc();
    Y.applyUpdate(before, stored.get("s2")!);
    expect(lines(before)).toEqual(["昔の行", "あとで足した行"]);
  });
});
