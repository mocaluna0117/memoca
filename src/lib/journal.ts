"use client";

import { uuidv7 } from "uuidv7";
import { db } from "@/lib/db";
import { createNote, ensureJournalFolder, setNoteTrashed } from "@/lib/sync/mutations";
import { TEMPLATES_FOLDER_ID, fillBodyFromTemplate, isTemplate } from "@/lib/templates";
import type { Note } from "@/lib/types";

/** The name of the template a new day's note starts from, if there is one. */
export const JOURNAL_TEMPLATE = "今日のメモ";

const PREFIX = "journal-";
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** A day, as this device's clock and time zone have it: 2026-10-06. */
export function dayOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A day's own note id: the same on every device, so two that make it make one. */
export const journalNoteId = (day: string) => `${PREFIX}${day}`;

/** The day a note is the note of, or null for any other note. */
export function journalDay(noteId: string): string | null {
  const match = /^journal-(\d{4}-\d{2}-\d{2})(?:-[\w-]+)?$/.exec(noteId);
  return match ? match[1]! : null;
}

/** A day as a note is named by it: 2026年10月6日（火）. */
export function dayTitle(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const weekday = WEEKDAYS[new Date(year, month - 1, date).getDay()];
  return `${year}年${month}月${date}日（${weekday}）`;
}

/** A day as the move to it is labelled: 10月6日. */
export function dayLabel(day: string): string {
  const [, month, date] = day.split("-").map(Number);
  return `${month}月${date}日`;
}

/** The day's note on this device, not in the trash, if there is one. */
async function dayNote(day: string): Promise<Note | undefined> {
  const own = await db().notes.get(journalNoteId(day));
  if (own && !own.purged && !own.deletedAt) return own;
  // One made again after the first was deleted for good (see openDay).
  return db()
    .notes.filter(
      (note) => !note.purged && !note.deletedAt && note.noteId.startsWith(`${journalNoteId(day)}-`),
    )
    .first();
}

/**
 * The note of a day, opened: made if there is none yet, in the folder of the
 * days' notes, named by its day, and starting from the template named
 * 今日のメモ if there is one. One in the trash is taken out of it. Its id is
 * the day's own (journalNoteId), so two devices that make it make one; one
 * deleted for good leaves that id spent, and the day's next note has an id
 * of its own after it.
 */
export async function openDay(day: string): Promise<string> {
  const folderId = await ensureJournalFolder();
  const found = await dayNote(day);
  if (found) return found.noteId;
  const own = await db().notes.get(journalNoteId(day));
  if (own && !own.purged && own.deletedAt) {
    await setNoteTrashed(own.noteId, false);
    return own.noteId;
  }
  const noteId = own?.purged ? `${journalNoteId(day)}-${uuidv7().slice(-8)}` : journalNoteId(day);
  await createNote({ folderId, title: dayTitle(day), noteId });
  const template = (await db().notes.where("folderId").equals(TEMPLATES_FOLDER_ID).toArray()).find(
    (note) => isTemplate(note) && note.title?.trim() === JOURNAL_TEMPLATE,
  );
  if (template) await fillBodyFromTemplate(noteId, template.noteId).catch(() => {});
  return noteId;
}

/** Today's note, opened (see openDay). */
export const openToday = (now = new Date()) => openDay(dayOf(now));

/** The days before and after this one that have a note, nearest first: null where there is none. */
export async function neighbourDays(
  day: string,
): Promise<{ before: string | null; after: string | null }> {
  const days = new Set<string>();
  await db()
    .notes.filter((note) => !note.purged && !note.deletedAt && note.noteId.startsWith(PREFIX))
    .each((note) => {
      const found = journalDay(note.noteId);
      if (found) days.add(found);
    });
  const sorted = [...days].sort();
  return {
    before: sorted.filter((other) => other < day).at(-1) ?? null,
    after: sorted.find((other) => other > day) ?? null,
  };
}
