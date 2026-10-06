import "fake-indexeddb/auto";
import { beforeEach, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { db, resetLocalData } from "@/lib/db";
import {
  dayOf,
  dayTitle,
  journalDay,
  journalNoteId,
  neighbourDays,
  openDay,
  openToday,
} from "@/lib/journal";
import { acquireDoc, releaseDoc, withStoredDoc } from "@/lib/sync/docs";
import {
  JOURNAL_FOLDER_ID,
  TEMPLATES_FOLDER_ID,
  createNote,
  ensureTemplatesFolder,
} from "@/lib/sync/mutations";
import { bodyFragment, extractText } from "@/lib/sync/ydoc";

beforeEach(async () => {
  await resetLocalData();
});

describe("a day", () => {
  test("is named, and its note known, by the date on this device", () => {
    expect(dayOf(new Date(2026, 9, 6, 23, 59))).toBe("2026-10-06");
    expect(dayTitle("2026-10-06")).toBe("2026年10月6日（火）");
    expect(journalNoteId("2026-10-06")).toBe("journal-2026-10-06");
    expect(journalDay("journal-2026-10-06")).toBe("2026-10-06");
    expect(journalDay("journal-2026-10-06-abcd1234")).toBe("2026-10-06");
    expect(journalDay("0190abcd-0000-7000-8000-000000000000")).toBeNull();
  });
});

describe("today's note", () => {
  test("is made the first time, named by the day, in the folder of the days' notes, and the same after", async () => {
    const first = await openToday(new Date(2026, 9, 6, 9));
    expect(first).toBe("journal-2026-10-06");
    const note = await db().notes.get(first);
    expect(note).toMatchObject({ title: "2026年10月6日（火）", folderId: JOURNAL_FOLDER_ID });
    expect((await db().folders.get(JOURNAL_FOLDER_ID))?.system).toBe("journal");
    expect(await openToday(new Date(2026, 9, 6, 21))).toBe(first);
    expect(await db().notes.count()).toBe(1);
  });

  test("in the trash, is taken out of it", async () => {
    const id = await openDay("2026-10-06");
    await db().notes.update(id, { deletedAt: 1 });
    expect(await openDay("2026-10-06")).toBe(id);
    expect((await db().notes.get(id))?.deletedAt).toBeNull();
  });

  test("deleted for good, is made again with an id of its own, and found by its day after", async () => {
    const id = await openDay("2026-10-06");
    await db().notes.update(id, { deletedAt: 1, purged: true });
    const again = await openDay("2026-10-06");
    expect(again).not.toBe(id);
    expect(journalDay(again)).toBe("2026-10-06");
    expect(await openDay("2026-10-06")).toBe(again);
  });

  test("starts from the template named 今日のメモ, its title its day's", async () => {
    const { folderId } = await ensureTemplatesFolder();
    expect(folderId).toBe(TEMPLATES_FOLDER_ID);
    const template = await createNote({ folderId, title: "今日のメモ" });
    const doc = await acquireDoc(template);
    try {
      const line = new Y.XmlElement("paragraph");
      bodyFragment(doc).push([line]);
      line.insert(0, [new Y.XmlText("やること")]);
    } finally {
      await releaseDoc(template);
    }
    const id = await openDay("2026-10-07");
    expect((await db().notes.get(id))?.title).toBe("2026年10月7日（水）");
    expect(await withStoredDoc(id, (body) => extractText(body))).toContain("やること");
  });
});

describe("the days before and after", () => {
  test("are the nearest with a note, none where there is none", async () => {
    for (const day of ["2026-10-01", "2026-10-04", "2026-10-09"]) await openDay(day);
    expect(await neighbourDays("2026-10-04")).toEqual({
      before: "2026-10-01",
      after: "2026-10-09",
    });
    expect(await neighbourDays("2026-10-01")).toEqual({ before: null, after: "2026-10-04" });
    expect(await neighbourDays("2026-10-09")).toEqual({ before: "2026-10-04", after: null });
  });
});
