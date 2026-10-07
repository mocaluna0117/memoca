import "fake-indexeddb/auto";
import { beforeEach, describe, expect, test } from "vitest";
import { db, resetLocalData } from "@/lib/db";
import { type Named, duplicateRenames, freeTitle, titleKey } from "@/lib/note-titles";
import {
  createFolder,
  createNote,
  moveNote,
  renameNote,
  setNoteTrashed,
  settleAllNoteTitles,
  settleNoteTitle,
  typingTitle,
} from "@/lib/sync/mutations";

describe("a name of its own", () => {
  test("blanks, width and case make no difference", () => {
    expect(titleKey(" Ｍｅｍｏ ")).toBe(titleKey("memo"));
  });

  test("numbered from 2, past those taken; one numbered already, on from it", () => {
    const taken = new Set(["会議", "会議 (2)"].map(titleKey));
    expect(freeTitle("買い物", taken)).toBe("買い物");
    expect(freeTitle("会議", taken)).toBe("会議 (3)");
    expect(freeTitle("会議 (2)", taken)).toBe("会議 (3)");
    expect(freeTitle(" 会議 ", new Set())).toBe("会議");
  });

  test("of those sharing one, the one made first keeps it; untitled, locked and trashed ones are left be", () => {
    const note = (noteId: string, title: string | null, more: Partial<Named> = {}): Named => ({
      noteId,
      title,
      locked: false,
      deletedAt: null,
      purged: false,
      ...more,
    });
    const renames = duplicateRenames([
      note("03", "会議"),
      note("01", "会議"),
      note("02", "会議 (2)"),
      note("04", "会議"),
      note("05", ""),
      note("06", ""),
      note("07", "会議", { locked: true }),
      note("08", "会議", { deletedAt: 1 }),
    ]);
    expect(renames).toEqual([
      { noteId: "03", title: "会議 (3)" },
      { noteId: "04", title: "会議 (4)" },
    ]);
    // One whose name is being typed is left for now, and keeps no name from another.
    expect(duplicateRenames([note("01", "会議"), note("02", "会議")], new Set(["01"]))).toEqual([]);
  });
});

describe("notes of a folder, as they are named, moved and made", () => {
  let folder: string;
  let other: string;
  beforeEach(async () => {
    await resetLocalData();
    folder = await createFolder({ parentId: null, name: "仕事" });
    other = await createFolder({ parentId: null, name: "趣味" });
  });
  const titleOf = async (noteId: string) => (await db().notes.get(noteId))?.title;

  test("made with a name one there has: numbered", async () => {
    const first = await createNote({ folderId: folder, title: "会議" });
    const second = await createNote({ folderId: folder, title: "会議" });
    const elsewhere = await createNote({ folderId: other, title: "会議" });
    expect(await titleOf(first)).toBe("会議");
    expect(await titleOf(second)).toBe("会議 (2)");
    expect(await titleOf(elsewhere)).toBe("会議");
  });

  test("renamed to one: the one renamed is numbered; typed, only once the field is left", async () => {
    const first = await createNote({ folderId: folder, title: "会議" });
    const second = await createNote({ folderId: folder, title: "メモ" });
    await renameNote(second, "会議", { settle: false });
    expect(await titleOf(second)).toBe("会議");
    await settleNoteTitle(second);
    expect(await titleOf(second)).toBe("会議 (2)");
    await renameNote(first, "会議 (2)");
    expect(await titleOf(first)).toBe("会議 (3)");
  });

  test("moved, or taken out of the trash, into a folder with its name: numbered", async () => {
    await createNote({ folderId: folder, title: "会議" });
    const moving = await createNote({ folderId: other, title: "会議" });
    await moveNote(moving, folder);
    expect(await titleOf(moving)).toBe("会議 (2)");

    const trashed = await createNote({ folderId: other, title: "予定" });
    await setNoteTrashed(trashed, true);
    await createNote({ folderId: other, title: "予定" });
    await setNoteTrashed(trashed, false);
    expect(await titleOf(trashed)).toBe("予定 (2)");
  });

  test("ones sharing a name already, numbered all at once, the one made first keeping it; not one being typed", async () => {
    const first = await createNote({ folderId: folder, title: "会議" });
    const second = await createNote({ folderId: folder, title: "下書き" });
    const third = await createNote({ folderId: folder, title: "下書き2" });
    await renameNote(second, "会議", { settle: false });
    await renameNote(third, "会議", { settle: false });
    typingTitle(third);
    await settleAllNoteTitles();
    expect(await titleOf(first)).toBe("会議");
    expect(await titleOf(second)).toBe("会議 (2)");
    expect(await titleOf(third)).toBe("会議");
    typingTitle(null);
    await settleAllNoteTitles();
    expect(await titleOf(third)).toBe("会議 (3)");
  });
});
