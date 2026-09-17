import { describe, expect, test } from "vitest";
import {
  buildTree,
  canMoveFolder,
  subtreeIds,
  trashedFolderIds,
  visibleNotes,
} from "@/lib/tree";
import type { Folder, Note } from "@/lib/types";

const s = { t: 0, d: "" };
const folder = (id: string, parentId: string | null, over: Partial<Folder> = {}): Folder => ({
  folderId: id,
  parentId,
  name: id,
  icon: null,
  sortKey: id,
  locked: false,
  system: null,
  deletedAt: null,
  purged: false,
  ts: { name: s, place: s, trash: s, lock: s },
  seq: 1,
  ...over,
});

const note = (id: string, folderId: string | null, over: Partial<Note> = {}): Note => ({
  noteId: id,
  folderId,
  kind: "note",
  title: id,
  preview: null,
  pinned: false,
  sortKey: id,
  locked: false,
  keyEpoch: 0,
  deletedAt: null,
  purged: false,
  lastUpdateSeq: 0,
  snapshotSeq: 0,
  ts: { title: s, place: s, pin: s, trash: s, lock: s },
  seq: 1,
  updatedAt: 1,
  ...over,
});

describe("derived trash", () => {
  test("a folder inside a trashed folder counts as trashed", () => {
    const folders = [
      folder("a", null, { deletedAt: 100 }),
      folder("b", "a"),
      folder("c", "b"),
      folder("d", null),
    ];
    expect([...trashedFolderIds(folders)].sort()).toEqual(["a", "b", "c"]);
  });

  test("a note created inside a trashed folder while offline is not lost", () => {
    const folders = [folder("a", null, { deletedAt: 100 })];
    const notes = [note("n1", "a"), note("n2", null)];
    const trashed = trashedFolderIds(folders);
    // It is hidden from the normal view...
    expect(visibleNotes(notes, trashed).map((n) => n.noteId)).toEqual(["n2"]);
    // ...but it was never given its own deletedAt, so restoring the folder
    // brings it straight back.
    expect(notes[0]!.deletedAt).toBeNull();
  });

  test("a cycle does not hang the walk", () => {
    const folders = [folder("a", "b"), folder("b", "a")];
    expect(() => trashedFolderIds(folders)).not.toThrow();
    expect(() => buildTree(folders)).not.toThrow();
  });
});

describe("tree", () => {
  test("Inbox is pinned to the top regardless of its sort key", () => {
    const tree = buildTree([
      folder("zzz", null, { sortKey: "a" }),
      folder("inbox", null, { sortKey: "z", system: "inbox" }),
    ]);
    expect(tree.map((f) => f.folderId)).toEqual(["inbox", "zzz"]);
  });

  test("a locked folder marks its whole subtree", () => {
    const tree = buildTree([
      folder("a", null, { locked: true }),
      folder("b", "a"),
      folder("c", null),
    ]);
    const a = tree.find((f) => f.folderId === "a")!;
    expect(a.inLockedTree).toBe(true);
    expect(a.children[0]!.inLockedTree).toBe(true);
    expect(tree.find((f) => f.folderId === "c")!.inLockedTree).toBe(false);
  });

  test("a folder cannot be dropped inside itself", () => {
    const folders = [folder("a", null), folder("b", "a"), folder("c", "b")];
    expect(subtreeIds(folders, "a").sort()).toEqual(["a", "b", "c"]);
    expect(canMoveFolder(folders, "a", "c")).toBe(false);
    expect(canMoveFolder(folders, "a", null)).toBe(true);
    expect(canMoveFolder(folders, "c", "a")).toBe(true);
  });
});
