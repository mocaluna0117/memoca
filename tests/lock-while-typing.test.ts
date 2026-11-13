import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, test } from "vitest";
import * as Y from "yjs";
import { prepareVault, vault } from "@/lib/crypto/vault";
import { db, resetLocalData } from "@/lib/db";
import { acquireDoc, flushDoc, releaseDoc, withDetachedDoc } from "@/lib/sync/docs";
import type { Note } from "@/lib/types";
import { lockNote, unlockNote } from "@/lib/vault/actions";
import { fakeConvex } from "./helpers/fake-convex";
import { FAST_ARGON, seedInbox, zero } from "./helpers/seed";

const NOTE = "n";
const row: Note = {
  noteId: NOTE,
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
  seq: 0,
  updatedAt: 0,
};

beforeEach(async () => {
  await resetLocalData();
  await seedInbox();
  (await prepareVault("パスワード", FAST_ARGON)).adopt();
  const doc = new Y.Doc();
  doc.getText("t").insert(0, "はじめ");
  await db().notes.put(row);
  await db().updates.add({
    noteId: NOTE,
    seq: 1,
    opId: "u1",
    keyEpoch: 0,
    data: Y.encodeStateAsUpdate(doc),
    pushed: 1,
    createdAt: 0,
  });
  await db().bodies.put({ noteId: NOTE, throughSeq: 1, keyEpoch: 0, text: "", updatedAt: 0 });
});

afterEach(() => {
  vault.lock();
});

test("what is typed while a note is being locked is still stored on the device once it is", async () => {
  // The note is open, and stays one that can be written in while its lock
  // is under way (its files are sealed and sent first, which takes as long
  // as they are large).
  const doc = await acquireDoc(NOTE);
  const server = fakeConvex({
    "attachments:urls": () => ({}),
    "vault:lockNote": async () => {
      // Typed, and stored (every half second), before the server has answered.
      doc.getText("t").insert(doc.getText("t").length, "、ロック中に書いた");
      await flushDoc(NOTE);
      return { status: "ok" };
    },
  });
  try {
    expect(await lockNote(server.client, NOTE)).toMatchObject({ status: "ok" });
    // The edit's row is still there: the lock cleared every row of the
    // note, this one with those the sealed version holds, and with it the
    // only stored copy of what was typed (its op was then refused, for the
    // key the note has left, and nothing was left to send again).
    const kept = await db().updates.where("noteId").equals(NOTE).toArray();
    expect(kept.filter((update) => update.pushed === 0)).toHaveLength(1);
  } finally {
    await releaseDoc(NOTE);
  }
  // And read with the note, opened again from what is stored.
  expect(await withDetachedDoc(NOTE, (doc) => doc.getText("t").toString())).toBe("はじめ、ロック中に書いた");
});

test("and what is typed while a note is being unlocked: kept as typed, not under the key the note has left", async () => {
  const quiet = fakeConvex({ "attachments:urls": () => ({}), "vault:lockNote": () => ({ status: "ok" }) });
  expect(await lockNote(quiet.client, NOTE)).toMatchObject({ status: "ok" });
  const doc = await acquireDoc(NOTE);
  expect(doc.getText("t").toString()).toBe("はじめ");
  const server = fakeConvex({
    "attachments:urls": () => ({}),
    "vault:unlockNote": async () => {
      doc.getText("t").insert(doc.getText("t").length, "、解除中に書いた");
      await flushDoc(NOTE);
      return { status: "ok" };
    },
  });
  try {
    expect(await unlockNote(server.client, NOTE)).toMatchObject({ status: "ok" });
    const kept = (await db().updates.where("noteId").equals(NOTE).toArray()).filter((update) => update.pushed === 0);
    expect(kept).toHaveLength(1);
    // Sealed as it was stored (the note was locked then): now as typed.
    expect(kept[0]!.iv).toBeUndefined();
  } finally {
    await releaseDoc(NOTE);
  }
  expect(await withDetachedDoc(NOTE, (doc) => doc.getText("t").toString())).toBe("はじめ、解除中に書いた");
});
