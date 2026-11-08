import "fake-indexeddb/auto";
import { beforeEach, describe, expect, test } from "vitest";
import { db, resetLocalData } from "@/lib/db";
import { TODO_NOTE_ID, ensureTodoNote, isQuickTodo } from "@/lib/quick/todo";
import { createNote, setNoteTrashed } from "@/lib/sync/mutations";
import { visibleNotes } from "@/lib/tree";

beforeEach(async () => {
  await resetLocalData();
});

describe("the quick note's Todo, as a note", () => {
  test("is made the first time, at the top level, with no title; the same after", async () => {
    const first = await ensureTodoNote();
    expect(first).toBe(TODO_NOTE_ID);
    expect(await db().notes.get(first)).toMatchObject({ folderId: null, title: "", kind: "note" });
    expect(await ensureTodoNote()).toBe(first);
    expect(await db().notes.count()).toBe(1);
  });

  test("one in the trash is taken out of it; one deleted for good leaves an id after it", async () => {
    const first = await ensureTodoNote();
    await setNoteTrashed(first, true);
    expect(await ensureTodoNote()).toBe(first);
    expect((await db().notes.get(first))?.deletedAt).toBeNull();

    await db().notes.update(first, { purged: true });
    const again = await ensureTodoNote();
    expect(again).not.toBe(first);
    expect(again.startsWith(`${TODO_NOTE_ID}-`)).toBe(true);
    expect(isQuickTodo(again)).toBe(true);
    expect(await ensureTodoNote()).toBe(again);
  });

  test("is told apart by its id alone", () => {
    expect(isQuickTodo(TODO_NOTE_ID)).toBe(true);
    expect(isQuickTodo(`${TODO_NOTE_ID}-abcd1234`)).toBe(true);
    expect(isQuickTodo("quick-todos")).toBe(false);
    expect(isQuickTodo("0190abcd-0000-7000-8000-000000000000")).toBe(false);
  });

  test("is left out of Memoca's lists, the others kept", async () => {
    const todo = await ensureTodoNote();
    const other = await createNote({ folderId: null, topLevel: true, title: "ふつうのメモ" });
    const shown = visibleNotes(await db().notes.toArray(), new Set()).map((note) => note.noteId);
    expect(shown).toEqual([other]);
    expect(shown).not.toContain(todo);
  });
});
