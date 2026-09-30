import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { prepareVault, vault } from "@/lib/crypto/vault";
import { db, resetLocalData } from "@/lib/db";
import type { Note } from "@/lib/types";
import { lockNote } from "@/lib/vault/actions";
import { openTitles, openedTitles, titleKey } from "@/lib/vault/titles";
import { fakeConvex } from "./helpers/fake-convex";
import { FAST_ARGON, seedInbox, zero } from "./helpers/seed";

const note = (noteId: string, over: Partial<Note> = {}): Note => ({
  noteId,
  folderId: null,
  kind: "quick",
  title: "",
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

let server: ReturnType<typeof fakeConvex>;

/** Locks a note held on this device with this text, and reads its sealed title back. */
async function lockedTitle(over: Partial<Note>, text: string | null): Promise<string | undefined> {
  await db().notes.put(note("n", over));
  await db().bodies.put({ noteId: "n", throughSeq: 0, keyEpoch: 0, text, updatedAt: 0 });
  expect(await lockNote(server.client, "n")).toMatchObject({ status: "ok" });
  const locked = (await db().notes.get("n"))!;
  expect(locked.title).toBeNull();
  await openTitles([locked]);
  return openedTitles().get(titleKey(locked));
}

beforeEach(async () => {
  await resetLocalData();
  await seedInbox();
  server = fakeConvex({
    "attachments:urls": () => ({}),
    "vault:lockNote": () => ({ status: "ok" }),
  });
  (await prepareVault("パスワード", FAST_ARGON)).adopt();
});

afterEach(() => {
  vault.lock();
});

describe("a note locked with no title", () => {
  test("is given its first line as its title, sealed, so the list still tells it apart", async () => {
    expect(await lockedTitle({ preview: "牛乳を買う" }, "牛乳を買う\n卵")).toBe("牛乳を買う");
  });

  test("takes the line from its text when it keeps none", async () => {
    expect(await lockedTitle({ preview: null }, "\n  打ち合わせの件  \n続き")).toBe(
      "打ち合わせの件",
    );
  });

  test("a long line is cut as the list cuts it", async () => {
    expect(await lockedTitle({ preview: "あ".repeat(100) }, "あ".repeat(100))).toBe(
      "あ".repeat(60),
    );
  });

  test("with no text at all, stays without one", async () => {
    expect(await lockedTitle({ preview: null }, "")).toBe("");
  });
});

describe("a note locked with a title", () => {
  test("keeps it exactly as written", async () => {
    expect(await lockedTitle({ title: "  会議  ", preview: "議題" }, "議題")).toBe("  会議  ");
  });
});
