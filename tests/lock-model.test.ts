import { describe, expect, test } from "vitest";
import type { Folder, Note } from "@/lib/types";
import {
  canLockFolder,
  folderLockKind,
  lockCoverage,
  lockOriginOf,
  needsLock,
  planFolderLock,
  planFolderUnlock,
} from "@/lib/vault/model";
import { zero } from "./helpers/seed";

const folder = (folderId: string, parentId: string | null, over: Partial<Folder> = {}): Folder => ({
  folderId,
  parentId,
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

// work (locked) ─ plans ─ secret (locked)
// home
const folders = [
  folder("inbox", null, { system: "inbox", locked: true }),
  folder("work", null, { locked: true }),
  folder("plans", "work"),
  folder("secret", "plans", { locked: true }),
  folder("home", null),
];

describe("which lock covers what", () => {
  const coverage = lockCoverage(folders);

  test("a folder is covered by its own lock or its nearest locked ancestor's", () => {
    expect(coverage.get("work")).toBe("work");
    expect(coverage.get("plans")).toBe("work");
    expect(coverage.get("secret")).toBe("secret");
    expect(coverage.has("home")).toBe(false);
  });

  test("Inbox's old flag covers nothing, and it can never be locked", () => {
    expect(coverage.has("inbox")).toBe(false);
    expect(canLockFolder(folders[0]!, coverage)).toBe(false);
  });

  test("kinds: own, inherited from a parent, or none", () => {
    expect(folderLockKind("work", coverage)).toBe("own");
    expect(folderLockKind("plans", coverage)).toBe("inherited");
    expect(folderLockKind("home", coverage)).toBe("none");
    expect(canLockFolder(folders[2]!, coverage)).toBe(false);
    expect(canLockFolder(folders[4]!, coverage)).toBe(true);
  });

  test("a plaintext note inside a locked folder needs locking", () => {
    expect(needsLock(note("n", "plans"), coverage)).toBe(true);
    expect(needsLock(note("n", "home"), coverage)).toBe(false);
    expect(needsLock(note("n", "inbox"), coverage)).toBe(false);
    expect(needsLock(note("n", "plans", { purged: true }), coverage)).toBe(false);
  });

  test("a note locked before the reason was recorded counts as its folder's when covered", () => {
    expect(lockOriginOf(note("n", "plans", { locked: true }), coverage)).toBe("folder");
    expect(lockOriginOf(note("n", "home", { locked: true }), coverage)).toBe("note");
    expect(lockOriginOf(note("n", "plans", { locked: true, lockOrigin: "note" }), coverage)).toBe("note");
  });
});

describe("planning a folder lock", () => {
  test("covers every plaintext note in the subtree, trashed ones too", () => {
    const notes = [
      note("a", "work"),
      note("b", "plans", { deletedAt: 1 }),
      note("c", "secret", { locked: true }),
      note("d", "home"),
      note("e", "plans", { purged: true }),
    ];
    expect(planFolderLock("work", folders, notes).sort()).toEqual(["a", "b"]);
  });
});

describe("planning to take a folder lock off", () => {
  test("keeps notes locked by hand and notes another lock still covers", () => {
    const notes = [
      note("by-folder", "plans", { locked: true, lockOrigin: "folder" }),
      note("by-hand", "plans", { locked: true, lockOrigin: "note" }),
      note("in-locked-child", "secret", { locked: true, lockOrigin: "folder" }),
      note("legacy", "work", { locked: true }),
      note("plain", "work"),
      note("elsewhere", "home", { locked: true }),
    ];
    const plan = planFolderUnlock("work", folders, notes);
    expect(plan.unlock.sort()).toEqual(["by-folder", "legacy"]);
    expect(plan.keep.sort()).toEqual(["by-hand", "in-locked-child"]);
  });

  test("a note inside a locked folder under a locked folder stays locked", () => {
    const nested = [folder("outer", null, { locked: true }), folder("inner", "outer", { locked: true })];
    const notes = [note("n", "inner", { locked: true, lockOrigin: "folder" })];
    expect(planFolderUnlock("inner", nested, notes)).toEqual({ unlock: [], keep: ["n"] });
  });
});
