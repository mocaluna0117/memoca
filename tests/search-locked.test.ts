import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { prepareVault, vault } from "@/lib/crypto/vault";
import { db, resetLocalData } from "@/lib/db";
import { buildIndex, search } from "@/lib/search/engine";
import { lockedSearchNote, searchScope } from "@/lib/search/rows";
import { createFolder, createNote } from "@/lib/sync/mutations";
import type { Folder, Note } from "@/lib/types";
import { openTitles, openedTitles, titleKey } from "@/lib/vault/titles";
import { FAST_ARGON, seedInbox, zero } from "./helpers/seed";

const folder = (folderId: string, over: Partial<Folder> = {}): Folder => ({
  folderId,
  parentId: null,
  name: folderId,
  icon: null,
  sortKey: "a",
  locked: false,
  system: null,
  deletedAt: null,
  purged: false,
  ts: { name: zero, place: zero, trash: zero, lock: zero },
  seq: 0,
  ...over,
});

const note = (noteId: string, folderId: string | null, over: Partial<Note> = {}): Note => ({
  noteId,
  folderId,
  kind: "note",
  title: noteId,
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

const sealedTitle = { ct: new ArrayBuffer(8), iv: new ArrayBuffer(12) };
const folders = [folder("秘密", { locked: true }), folder("ごみ", { deletedAt: 1 })];
const plain = note("買い物リスト", null);
const locked = note("secret", "秘密", {
  title: null,
  locked: true,
  keyEpoch: 1,
  titleSealed: sealedTitle,
  wrappedKey: sealedTitle,
});
const trashedLocked = note("old", "ごみ", {
  title: null,
  locked: true,
  keyEpoch: 1,
  titleSealed: sealedTitle,
  wrappedKey: sealedTitle,
});
const notes = [plain, locked, trashedLocked];
const bodies = [
  { noteId: "買い物リスト", text: "牛乳とパン", reading: null },
  // What a locked note's body row holds on disk: nothing to search.
  { noteId: "secret", text: null, reading: null },
];

const find = (scope: ReturnType<typeof searchScope>, query: string) =>
  search(buildIndex(scope.rows), query).map((hit) => hit.noteId);

describe("what search looks through", () => {
  test("with the vault closed, a locked note is left out entirely", () => {
    const scope = searchScope(notes, folders, bodies, { open: false, titles: new Map() });
    // Not even the placeholder title: searching "ロック" must not list it.
    expect(find(scope, "ロック")).toEqual([]);
    expect(find(scope, "秘密")).toEqual([]);
    expect(find(scope, "牛乳")).toEqual(["買い物リスト"]);
    // The trashed one is not counted either.
    expect(scope.locked).toBe(1);
    expect(lockedSearchNote({ count: scope.locked, open: false })).toBe(
      "ロックされたメモは、金庫を開くとタイトルで検索できます。",
    );
  });

  test("with the vault open, it is found by its real title but not by its body", () => {
    const titles = new Map([[titleKey(locked), "旅行の計画"]]);
    const scope = searchScope(notes, folders, bodies, { open: true, titles });
    expect(find(scope, "旅行")).toEqual(["secret"]);
    expect(find(scope, "秘密")).toEqual(["secret"]);
    expect(find(scope, "ロック")).toEqual([]);
    const row = scope.rows.find((r) => r.noteId === "secret")!;
    expect(row).toMatchObject({ locked: true, body: null, reading: null });
    expect(lockedSearchNote({ count: scope.locked, open: true })).toBe(
      "ロックされたメモの本文は検索されません。",
    );
  });

  test("a title not opened yet is left out rather than shown as a placeholder", () => {
    const scope = searchScope(notes, folders, bodies, { open: true, titles: new Map() });
    expect(scope.rows.map((r) => r.noteId)).toEqual(["買い物リスト"]);
  });

  test("a title opened for an older version of the note does not count", () => {
    const titles = new Map([[titleKey(locked), "古い題名"]]);
    const renamed = { ...locked, ts: { ...locked.ts, title: { t: 5, d: "test" } } };
    const scope = searchScope([renamed], folders, bodies, { open: true, titles });
    expect(scope.rows).toEqual([]);
  });

  test("nothing is said when there are no locked notes", () => {
    expect(lockedSearchNote({ count: 0, open: false })).toBeNull();
    expect(lockedSearchNote({ count: 0, open: true })).toBeNull();
  });
});

describe("opening locked titles for search", () => {
  beforeEach(async () => {
    await resetLocalData();
    await seedInbox();
    (await prepareVault("パスワード", FAST_ARGON)).adopt();
  });

  afterEach(() => vault.lock());

  async function lockedNote(title: string) {
    const work = await createFolder({ parentId: null, name: "仕事" });
    await db().folders.update(work, { locked: true });
    const noteId = await createNote({ folderId: work, title });
    return (await db().notes.get(noteId))!;
  }

  test("opens them in memory while the vault is open", async () => {
    const created = await lockedNote("秘密の題名");
    await openTitles(await db().notes.toArray());
    expect(openedTitles().get(titleKey(created))).toBe("秘密の題名");
  });

  test("forgets every one of them when the vault closes", async () => {
    await lockedNote("秘密の題名");
    await openTitles(await db().notes.toArray());
    expect(openedTitles().size).toBe(1);
    vault.lock();
    expect(openedTitles().size).toBe(0);
  });

  test("opens nothing while the vault is closed", async () => {
    await lockedNote("秘密の題名");
    vault.lock();
    await openTitles(await db().notes.toArray());
    expect(openedTitles().size).toBe(0);
  });

  test("drops titles of notes that are no longer locked or no longer there", async () => {
    await lockedNote("秘密の題名");
    await openTitles(await db().notes.toArray());
    await openTitles([]);
    expect(openedTitles().size).toBe(0);
  });
});
