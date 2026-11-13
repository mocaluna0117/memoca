import * as Y from "yjs";
import { dueAt, formatDue, readDue } from "@/lib/quick/todo-due";
import { bodyFragment } from "@/lib/sync/ydoc";

/**
 * The Todo's reminders: when each item with a due is told of, by the times
 * chosen for the account (and, for an item, its own), worked out on the
 * device that changes the Todo and sent to the server whole
 * (convex/reminders.ts), which sends each to every device of the account at
 * its time. The times chosen are kept in the Todo's own document (NOTIFY_MAP),
 * synced as its items are: chosen on one device, they are every device's.
 */

/** The name of the map, in the Todo's document, of the times its items are told of. */
export const NOTIFY_MAP = "todoNotify";
/** The account's times, comma-separated ("" for none): all of them where none were chosen. */
export const DEFAULT_KEY = "default";
/** "1" once a device of the account asked for the reminders: they are worked out and sent from then on. */
export const ON_KEY = "on";
/** An item's own: none at all. Any other value is its times, comma-separated; none kept, the account's. */
export const NONE = "none";

export const TIMINGS = ["eve", "morning", "hourBefore", "atTime"] as const;
export type Timing = (typeof TIMINGS)[number];

export const TIMING_LABEL: Record<Timing, string> = {
  eve: "前日の夜 21:00",
  morning: "当日の朝 9:00",
  hourBefore: "1 時間前",
  atTime: "期日の時刻ちょうど",
};

/** Shorter, for the chips of an item's own. */
export const TIMING_CHIP: Record<Timing, string> = {
  eve: "前日 21:00",
  morning: "当日 9:00",
  hourBefore: "1 時間前",
  atTime: "時刻ちょうど",
};

/** Only for an item with a time: one with a day alone has no hour to be before. */
export const NEEDS_TIME: ReadonlySet<Timing> = new Set(["hourBefore", "atTime"]);

const isTiming = (value: string): value is Timing => (TIMINGS as readonly string[]).includes(value);

/** Times as they are kept: in their order, each once. */
export const writeTimings = (timings: Iterable<Timing>): string => {
  const chosen = new Set(timings);
  return TIMINGS.filter((each) => chosen.has(each)).join(",");
};

const readTimings = (value: string): Timing[] => {
  const chosen = new Set(value.split(",").filter(isTiming));
  return TIMINGS.filter((each) => chosen.has(each));
};

/** The account's times: all of them, until any are chosen. */
export function defaultTimings(notify: ReadonlyMap<string, string>): Timing[] {
  const kept = notify.get(DEFAULT_KEY);
  return kept === undefined ? [...TIMINGS] : readTimings(kept);
}

/** An item's own times, "none", or null where it has the account's. */
export function ownTimings(notify: ReadonlyMap<string, string>, id: string): Timing[] | typeof NONE | null {
  const kept = notify.get(id);
  if (kept === undefined) return null;
  if (kept === NONE) return NONE;
  const timings = readTimings(kept);
  return timings.length === 0 ? NONE : timings;
}

/** The times an item is told of: its own, or the account's. */
export function timingsOf(notify: ReadonlyMap<string, string>, id: string): Timing[] {
  const own = ownTimings(notify, id);
  if (own === NONE) return [];
  return own ?? defaultTimings(notify);
}

/** A reminder as it is sent: the item's block id and which of the times it is, when, and what it says. */
export type Reminder = { key: string; at: number; title: string; body: string };

/** An item of the Todo, as it is told of: the first line of its text, and whether it is done. */
export type TodoItem = { text: string; done: boolean };

/** The most an account keeps to come (as convex/reminders.ts takes): the soonest. */
export const MAX_REMINDERS = 500;
const MAX_TITLE = 200;

const HOUR = 60 * 60 * 1000;

/** A day's time, here: 21:00 the day before, 9:00 on it. */
function onDay(day: Date, days: number, hours: number): number {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + days, hours, 0, 0, 0).getTime();
}

const LEAD: Record<Timing, string> = {
  eve: "明日が期日です",
  morning: "今日が期日です",
  hourBefore: "あと 1 時間で期日です",
  atTime: "期日の時刻です",
};

/**
 * Each item's reminders to come, by its due and its times (the account's,
 * or its own): 前日の夜 21:00, 当日の朝 9:00, and, for one with a time, an hour
 * before it and at it. None for an item done, a time past, or one after the
 * due itself (9:00 for a due of 8:00); two at the same moment are one (the
 * later of the times). The
 * soonest MAX_REMINDERS, soonest first.
 */
export function remindersOf({
  items,
  dues,
  notify,
  now,
}: {
  items: ReadonlyMap<string, TodoItem>;
  dues: ReadonlyMap<string, string>;
  notify: ReadonlyMap<string, string>;
  now: number;
}): Reminder[] {
  const reminders: Reminder[] = [];
  for (const [id, due] of dues) {
    const item = items.get(id);
    const read = readDue(due);
    if (!item || item.done || !read) continue;
    const timings = timingsOf(notify, id);
    if (timings.length === 0) continue;
    const end = dueAt(due);
    // Nothing written in it: nothing to tell of. An item made by Enter in
    // one with a due has that day's 23:59 from the start, written in or not.
    const title = item.text.trim().slice(0, MAX_TITLE);
    if (title === "") continue;
    const shown = formatDue(due, new Date(now));
    const seen = new Set<number>();
    // Two at one moment: the nearer the due's, which says more (an hour
    // before 10:00 rather than the morning's 9:00).
    for (const timing of [...timings].reverse()) {
      if (NEEDS_TIME.has(timing) && !read.time) continue;
      const at =
        timing === "eve"
          ? onDay(read.day, -1, 21)
          : timing === "morning"
            ? onDay(read.day, 0, 9)
            : timing === "hourBefore"
              ? end - HOUR
              : end;
      if (at <= now || at > end || seen.has(at)) continue;
      seen.add(at);
      reminders.push({ key: `${id}:${timing}`, at, title, body: `${LEAD[timing]}（${shown}）` });
    }
  }
  return reminders.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key)).slice(0, MAX_REMINDERS);
}

/** The text of a line: what is written, links' too, without their marks. */
function lineText(element: Y.XmlElement): string {
  let text = "";
  for (const child of element.toArray()) {
    if (!(child instanceof Y.XmlText)) continue;
    for (const chunk of child.toDelta() as { insert?: unknown }[]) {
      if (typeof chunk.insert === "string") text += chunk.insert;
    }
  }
  return text.split("\n")[0] ?? "";
}

/** The Todo's items by their block id, read from its document: their text, and whether each is done. */
export function todoItemsOf(doc: Y.Doc): Map<string, TodoItem> {
  const items = new Map<string, TodoItem>();
  const walk = (node: Y.XmlElement | Y.XmlFragment) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === "blockContainer") {
        const id = child.getAttribute("id");
        const content = child.toArray().find((each): each is Y.XmlElement => each instanceof Y.XmlElement);
        if (id && content?.nodeName === "checkListItem") {
          const checked = content.getAttribute("checked") as unknown;
          items.set(id, { text: lineText(content), done: checked === true || checked === "true" });
        }
      }
      walk(child);
    }
  };
  walk(bodyFragment(doc));
  return items;
}

/** The map's entries, as they are now. */
export const entriesOf = (map: Y.Map<string>): Map<string, string> =>
  new Map(Object.entries(map.toJSON() as Record<string, string>));

/** The Todo's reminders to come, read from its document as it is now. */
export function remindersIn(doc: Y.Doc, dueMap: string, now: number): Reminder[] {
  return remindersOf({
    items: todoItemsOf(doc),
    dues: entriesOf(doc.getMap<string>(dueMap)),
    notify: entriesOf(doc.getMap<string>(NOTIFY_MAP)),
    now,
  });
}
