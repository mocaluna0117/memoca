import "fake-indexeddb/auto";
import { beforeEach, expect, test } from "vitest";
import * as Y from "yjs";
import { db, resetLocalData } from "@/lib/db";
import { refFor } from "@/lib/media/ref";
import { rewriteRefInDoc } from "@/lib/media/relock-copies";
import { reportAttachmentRefs, resetReportRefs } from "@/lib/media/report-refs";
import { acquireDoc, releaseDoc, withDetachedDoc } from "@/lib/sync/docs";
import { FRAGMENT, attachmentRefs } from "@/lib/sync/ydoc";
import type { Note } from "@/lib/types";
import { fakeConvex } from "./helpers/fake-convex";
import { zero } from "./helpers/seed";

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
  lastUpdateSeq: 1,
  snapshotSeq: 0,
  refsThroughSeq: 1,
  ts: { title: zero, preview: zero, place: zero, pin: zero, trash: zero, lock: zero },
  seq: 0,
  updatedAt: 0,
  ...over,
});

beforeEach(async () => {
  await resetLocalData();
  resetReportRefs();
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

test("a note open in one tab is reported as stored, with what another tab of the device wrote to it", async () => {
  // Note B as the server has it: one image, X, update seq 1, reported.
  const base = new Y.Doc();
  const group = new Y.XmlElement("blockGroup");
  base.getXmlFragment(FRAGMENT).insert(0, [group]);
  const container = new Y.XmlElement("blockContainer");
  group.insert(0, [container]);
  const image = new Y.XmlElement("image");
  image.setAttribute("url", refFor("X"));
  container.insert(0, [image]);
  await db().notes.put(note("B"));
  await db().updates.add({
    noteId: "B",
    seq: 1,
    opId: "op-1",
    keyEpoch: 0,
    data: Y.encodeStateAsUpdate(base),
    pushed: 1,
    createdAt: 0,
  });
  await db().bodies.put({ noteId: "B", throughSeq: 1, keyEpoch: 0, text: "", updatedAt: 0 });

  // This tab, the one syncing, has B open in its editor.
  const open = await acquireDoc("B");
  expect(attachmentRefs(open)).toEqual(["X"]);

  // Another tab (settings, converting an image) rewrites B in storage, and
  // the update is pushed and comes back: applyBatch finds it already stored
  // (same opId), so it is not applied to this tab's open document.
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(base));
  const before = Y.encodeStateVector(other);
  expect(rewriteRefInDoc(other, refFor("X"), refFor("Xcopy"))).toBe(1);
  await db().updates.add({
    noteId: "B",
    seq: 2,
    opId: "op-2",
    keyEpoch: 0,
    data: Y.encodeStateAsUpdate(other, before),
    pushed: 1,
    createdAt: 1,
  });
  await db().notes.update("B", { lastUpdateSeq: 2 });
  await db().bodies.update("B", { throughSeq: 2 });

  const reported: string[][] = [];
  const server = fakeConvex({
    "attachments:reportRefs": (args) => {
      reported.push(args.refs as string[]);
      return { status: "ok" };
    },
  });
  expect(await reportAttachmentRefs(server.client, async () => {})).toBe(1);
  // As the server has it: showing the copy, not the original the open document still shows.
  expect(reported).toEqual([["Xcopy"]]);

  await releaseDoc("B");
  // What storage (and the server) actually holds for B.
  expect(await withDetachedDoc("B", (doc) => attachmentRefs(doc))).toEqual(["Xcopy"]);
});
