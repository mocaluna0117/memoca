import "fake-indexeddb/auto";
import { beforeEach, expect, test } from "vitest";
import { db, resetLocalData, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import { anyUnsent, unsentLines, unsentOnDevice } from "@/lib/sync/unsent";

beforeEach(async () => {
  await resetLocalData();
});

test("nothing only this device has: nothing to ask about", async () => {
  const unsent = await unsentOnDevice();
  expect(unsent).toEqual({ changes: 0, files: 0, quickNotes: 0 });
  expect(anyUnsent(unsent)).toBe(false);
});

test("changes not sent, files not uploaded and quick notes not saved, each counted", async () => {
  await db().outbox.bulkPut([
    { opId: "a", kind: "note", entityId: "n1", payload: {}, createdAt: 0, attempts: 0 },
    { opId: "b", kind: "update", entityId: "n1", payload: {}, createdAt: 0, attempts: 0 },
  ] as never);
  await db().pendingUploads.put({ attachmentId: "f1", noteId: "n1" } as never);
  await setMeta(`${META.quickDraft}:t1`, { text: "書きかけ", updatedAt: 0, userKey: "me" });
  // Saved as it is: not lost with the device.
  await setMeta(`${META.quickDraft}:t2`, {
    text: "保存済み",
    updatedAt: 0,
    userKey: "me",
    saved: { noteId: "n2", text: "保存済み", images: [] },
  });

  const unsent = await unsentOnDevice();
  expect(unsent).toEqual({ changes: 2, files: 1, quickNotes: 1 });
  expect(anyUnsent(unsent)).toBe(true);
  expect(unsentLines(unsent)).toEqual([
    "サーバーに送っていない変更 2 件",
    "アップロードしていない画像・ファイル 1 件",
    "保存していない即席メモ 1 件",
  ]);
});
