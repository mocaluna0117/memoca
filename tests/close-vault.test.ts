import "fake-indexeddb/auto";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ctx } from "@/lib/crypto/context";
import { open } from "@/lib/crypto/primitives";
import { prepareVault, unlockWithPassword, vault } from "@/lib/crypto/vault";
import { db, resetLocalData } from "@/lib/db";
import { acquireDoc, flushAll, releaseDoc } from "@/lib/sync/docs";
import { createNote } from "@/lib/sync/mutations";
import { FAST_ARGON } from "./helpers/seed";

const PASSWORD = "パスワード";

beforeEach(async () => {
  await resetLocalData();
});

afterEach(() => {
  vault.lock();
});

/** A vault that is open, and the record it can be opened again with. */
async function openVault() {
  const prepared = await prepareVault(PASSWORD, FAST_ARGON);
  prepared.adopt();
  return { ...prepared.record, passkeys: [], version: 1 };
}

async function lockedNote(): Promise<string> {
  const noteId = await createNote({ folderId: null });
  const { wrapped } = await vault.createNoteKey(noteId, 1);
  await db().notes.update(noteId, { locked: true, keyEpoch: 1, wrappedKey: wrapped });
  return noteId;
}

/** Reads back every stored update of a note, decrypted, into one document. */
async function storedText(noteId: string): Promise<string> {
  const note = (await db().notes.get(noteId))!;
  const key = await vault.noteKey(noteId, note.keyEpoch, note.wrappedKey!);
  const doc = new Y.Doc();
  for (const row of await db().updates.where("noteId").equals(noteId).toArray()) {
    expect(row.iv, "a locked note's edits are only ever stored encrypted").toBeDefined();
    const plain = await open(key, row.data, row.iv!, ctx.yjsUpdate(noteId, row.keyEpoch));
    Y.applyUpdate(doc, plain);
  }
  return doc.getText("typed").toString();
}

describe("closing the vault", () => {
  test("saves edits typed just before it closes, encrypted", async () => {
    const record = await openVault();
    const noteId = await lockedNote();
    const doc = await acquireDoc(noteId);

    // Typed within the half second before edits are normally written.
    doc.getText("typed").insert(0, "閉じる直前の入力");
    await vault.close();
    expect(vault.isUnlocked).toBe(false);
    await releaseDoc(noteId);

    await unlockWithPassword(record, PASSWORD);
    expect(await storedText(noteId)).toBe("閉じる直前の入力");
  });

  test("a write another flush already started still finishes before the key goes", async () => {
    const record = await openVault();
    const noteId = await lockedNote();
    const doc = await acquireDoc(noteId);

    doc.getText("typed").insert(0, "書き込み中の入力");
    // A flush started elsewhere (the half-second timer, or the app being
    // hidden) has taken the edit out of the buffer but not stored it yet.
    const elsewhere = flushAll();
    const started = Date.now();
    await vault.close();
    await elsewhere;
    await releaseDoc(noteId);

    // It waited for that write rather than spinning out the whole grace period.
    expect(Date.now() - started).toBeLessThan(1_000);
    await unlockWithPassword(record, PASSWORD);
    expect(await storedText(noteId)).toBe("書き込み中の入力");
  });

  test("the auto-lock timer closes through close(), which saves first", async () => {
    await openVault();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // Only whether the timer takes the saving path; the saving itself is
    // covered above, with real timers.
    const closing = vi.spyOn(vault, "close").mockResolvedValue("closed");
    try {
      vault.setAutoLockMinutes(1);
      vi.advanceTimersByTime(59_000);
      expect(closing).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(closing).toHaveBeenCalledTimes(1);
      expect(closing).toHaveBeenCalledWith("idle");
    } finally {
      closing.mockRestore();
      vi.useRealTimers();
    }
  });

  test("dropping the key without saving loses them, which is why close exists", async () => {
    await openVault();
    const noteId = await lockedNote();
    const doc = await acquireDoc(noteId);

    doc.getText("typed").insert(0, "消えてしまう入力");
    vault.lock();
    await releaseDoc(noteId);
    expect(await db().updates.where("noteId").equals(noteId).count()).toBe(0);
  });

  test("runs its hooks while the key is still there, and repeats while work is pending", async () => {
    await openVault();
    const seen: boolean[] = [];
    let pendingRounds = 2;
    const unregister = vault.onBeforeClose({
      save: () => {
        seen.push(vault.isUnlocked);
      },
      pending: () => pendingRounds-- > 0,
    });
    await vault.close();
    unregister();

    expect(seen).toEqual([true, true, true]);
    expect(vault.isUnlocked).toBe(false);
  });

  test("closes anyway when saving never finishes", async () => {
    await openVault();
    const unregister = vault.onBeforeClose({
      save: () => new Promise<void>(() => {}),
      pending: () => true,
    });
    const started = Date.now();
    await vault.close();
    unregister();

    expect(vault.isUnlocked).toBe(false);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(1_400);
    expect(waited).toBeLessThan(2_500);
  });
});
