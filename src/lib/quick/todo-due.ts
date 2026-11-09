/**
 * The Todo's dues: a day, and a time if one is given, by this device's
 * clock and time zone ("2026-11-13", "2026-11-13T23:59"), kept by each
 * item's block id in a map of the Todo's own document (DUE_MAP), synced as
 * its items are. How they read, which of the list's headings each goes
 * under, and their order.
 */

/** The name of the map, in the Todo's document, of each item's due by its block id. */
export const DUE_MAP = "todoDue";

/** What a due is set as: this device's own, stored and sent as any edit. */
export const TODO_DUE = Symbol("memoca:todo-due");

/** A due as it is kept: "2026-11-13", or "2026-11-13T23:59". */
export type Due = string;

const DUE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const pad = (n: number) => String(n).padStart(2, "0");

/** A day as a due keeps it: 2026-11-13. */
export function dayOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A due read: its day (at midnight, here), and its time ("23:59"), if it has one. Null for anything else. */
export function readDue(due: string | null | undefined): { day: Date; time: string | null } | null {
  const match = due ? DUE.exec(due) : null;
  if (!match) return null;
  const [, year, month, date, hours, minutes] = match;
  const day = new Date(Number(year), Number(month) - 1, Number(date));
  if (day.getMonth() !== Number(month) - 1) return null;
  if (hours !== undefined && (Number(hours) > 23 || Number(minutes) > 59)) return null;
  return { day, time: hours === undefined ? null : `${hours}:${minutes}` };
}

/** A due of a day, and a time if there is one. */
export function dueOf(day: Date, time: string | null): Due {
  return time ? `${dayOf(day)}T${time}` : dayOf(day);
}

/**
 * When a due is past: its time, or, with none, the end of its day (it is
 * not late until that day is over). Infinity for none, to sort after all.
 */
export function dueAt(due: string | null | undefined): number {
  const read = readDue(due);
  if (!read) return Number.POSITIVE_INFINITY;
  const at = new Date(read.day);
  if (read.time) {
    const [hours, minutes] = read.time.split(":").map(Number) as [number, number];
    at.setHours(hours, minutes, 0, 0);
  } else {
    at.setHours(23, 59, 59, 999);
  }
  return at.getTime();
}

/** A due as it is shown: "11/13(木)", "11/13(木) 23:59", and with its year when it is not this year's. */
export function formatDue(due: string, now: Date): string {
  const read = readDue(due);
  if (!read) return "";
  const { day, time } = read;
  const date = `${day.getMonth() + 1}/${day.getDate()}(${WEEKDAYS[day.getDay()]})`;
  const dated = day.getFullYear() === now.getFullYear() ? date : `${day.getFullYear()}/${date}`;
  return time ? `${dated} ${time}` : dated;
}

/** The list's headings, in the order they come. */
export const BUCKETS = ["overdue", "today", "tomorrow", "week", "later", "none"] as const;
export type Bucket = (typeof BUCKETS)[number];

export const BUCKET_LABEL: Record<Bucket, string> = {
  overdue: "期限切れ",
  today: "今日",
  tomorrow: "明日",
  week: "今週",
  later: "それ以降",
  none: "期日なし",
};

/** Midnight of a day, so many days after `date`'s. */
function daysAfter(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * The heading an item goes under, by its due and the time now: 期限切れ
 * (past: its time, or, with none, its day), 今日, 明日, 今週 (to this
 * week's Sunday, a week from Monday), それ以降; 期日なし with none.
 */
export function bucketOf(due: string | null | undefined, now: Date): Bucket {
  const read = readDue(due);
  if (!read) return "none";
  if (dueAt(due) < now.getTime()) return "overdue";
  const day = read.day.getTime();
  const today = daysAfter(now, 0).getTime();
  if (day <= today) return "today";
  if (day === daysAfter(now, 1).getTime()) return "tomorrow";
  // Sunday is the week's last day: 0 days to it on a Sunday, 6 on a Monday.
  const toSunday = (7 - now.getDay()) % 7;
  if (day <= daysAfter(now, toSunday).getTime()) return "week";
  return "later";
}
