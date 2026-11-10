import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  DEFAULT_KEY,
  NONE,
  defaultTimings,
  ownTimings,
  remindersIn,
  remindersOf,
  timingsOf,
  todoItemsOf,
  writeTimings,
} from "@/lib/notify/reminders";
import { DUE_MAP } from "@/lib/quick/todo-due";
import { bodyFragment } from "@/lib/sync/ydoc";

/** 2026-11-10 (火) 12:00, here. */
const NOW = new Date(2026, 10, 10, 12, 0).getTime();
const at = (day: number, hours: number, minutes = 0) => new Date(2026, 10, day, hours, minutes).getTime();

const item = (text: string, done = false) => ({ text, done });
const items = (entries: Record<string, { text: string; done: boolean }>) => new Map(Object.entries(entries));
const map = (entries: Record<string, string> = {}) => new Map(Object.entries(entries));

describe("the Todo's reminders, worked out from its dues", () => {
  test("a due with a time: the evening before, its morning, an hour before and at it", () => {
    const reminders = remindersOf({
      items: items({ a: item("牛乳を買う") }),
      dues: map({ a: "2026-11-12T18:00" }),
      notify: map(),
      now: NOW,
    });
    expect(reminders.map((each) => [each.key, each.at])).toEqual([
      ["a:eve", at(11, 21)],
      ["a:morning", at(12, 9)],
      ["a:hourBefore", at(12, 17)],
      ["a:atTime", at(12, 18)],
    ]);
    expect(reminders[0]).toMatchObject({ title: "牛乳を買う", body: "明日が期日です（11/12(木) 18:00）" });
    expect(reminders[3]!.body).toBe("期日の時刻です（11/12(木) 18:00）");
  });

  test("a day alone: the evening before and its morning, none by the hour", () => {
    const reminders = remindersOf({
      items: items({ a: item("提出") }),
      dues: map({ a: "2026-11-12" }),
      notify: map(),
      now: NOW,
    });
    expect(reminders.map((each) => each.key)).toEqual(["a:eve", "a:morning"]);
  });

  test("none past, none after the due, and one at a moment two fall on", () => {
    const reminders = remindersOf({
      items: items({ today: item("今日の夕方"), early: item("朝早く"), ten: item("10 時") }),
      dues: map({ today: "2026-11-10T18:00", early: "2026-11-11T08:00", ten: "2026-11-11T10:00" }),
      notify: map(),
      now: NOW,
    });
    expect(reminders.map((each) => each.key)).toEqual([
      // Today's: its evening before and morning are past.
      "today:hourBefore",
      "today:atTime",
      // 21:00 tonight for both of tomorrow's.
      "early:eve",
      "ten:eve",
      // 8:00: an hour before it, and at it; 9:00 is after it.
      "early:hourBefore",
      "early:atTime",
      // 10:00: the hour before is 9:00, the morning's too: one, the hour's.
      "ten:hourBefore",
      "ten:atTime",
    ]);
  });

  test("an item done, one with no due, and one gone from the list: none", () => {
    const reminders = remindersOf({
      items: items({ done: item("済み", true), plain: item("期日なし") }),
      dues: map({ done: "2026-11-12", gone: "2026-11-12", broken: "あした" }),
      notify: map(),
      now: NOW,
    });
    expect(reminders).toEqual([]);
  });

  test("the account's times, and an item's own: none, or some", () => {
    const notify = map({ [DEFAULT_KEY]: writeTimings(["morning"]), b: NONE, c: writeTimings(["atTime", "eve"]) });
    expect(defaultTimings(notify)).toEqual(["morning"]);
    expect(ownTimings(notify, "a")).toBeNull();
    expect(ownTimings(notify, "b")).toBe(NONE);
    expect(timingsOf(notify, "c")).toEqual(["eve", "atTime"]);
    const reminders = remindersOf({
      items: items({ a: item("A"), b: item("B"), c: item("C") }),
      dues: map({ a: "2026-11-12T18:00", b: "2026-11-12T18:00", c: "2026-11-12T18:00" }),
      notify,
      now: NOW,
    });
    expect(reminders.map((each) => each.key)).toEqual(["c:eve", "a:morning", "c:atTime"]);
    // None chosen for the account: an item's own still are.
    expect(
      remindersOf({ items: items({ a: item("A"), c: item("C") }), dues: map({ a: "2026-11-12", c: "2026-11-12" }), notify: map({ [DEFAULT_KEY]: "", c: "eve" }), now: NOW }).map(
        (each) => each.key,
      ),
    ).toEqual(["c:eve"]);
  });

  test("the soonest 500, a long text cut, an empty one called Todo", () => {
    const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`i${i}`, item(i === 0 ? "   " : "あ".repeat(300))]));
    const dues = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`i${i}`, "2026-11-12T18:00"]));
    const reminders = remindersOf({ items: items(many), dues: map(dues), notify: map(), now: NOW });
    expect(reminders).toHaveLength(500);
    expect(reminders.every((each) => each.title.length <= 200)).toBe(true);
    expect(reminders.find((each) => each.key === "i0:eve")?.title).toBe("Todo");
    // The soonest kept: every evening's and morning's (600) do not all fit, the hours' none.
    expect(reminders.some((each) => each.key.endsWith(":atTime"))).toBe(false);
  });
});

describe("the Todo's items, read from its document", () => {
  const block = (id: string, type: string, text: string, attrs: Record<string, unknown> = {}) => {
    const container = new Y.XmlElement("blockContainer");
    container.setAttribute("id", id);
    const content = new Y.XmlElement(type);
    for (const [name, value] of Object.entries(attrs)) content.setAttribute(name, value as string);
    const line = new Y.XmlText();
    content.insert(0, [line]);
    container.insert(0, [content]);
    return { container, line, text };
  };

  test("each item's first line and whether it is done; details are no items", () => {
    const doc = new Y.Doc();
    const group = new Y.XmlElement("blockGroup");
    bodyFragment(doc).insert(0, [group]);
    const a = block("a", "checkListItem", "牛乳を", { checked: false as unknown as string });
    const b = block("b", "checkListItem", "済んだ", { checked: true as unknown as string });
    const detail = block("d", "paragraph", "https://example.com");
    group.insert(0, [a.container, b.container, detail.container]);
    a.line.insert(0, "牛乳を");
    a.line.insert(3, "買う", { bold: true });
    b.line.insert(0, "済んだ");
    detail.line.insert(0, "https://example.com");
    expect(todoItemsOf(doc)).toEqual(
      new Map([
        ["a", { text: "牛乳を買う", done: false }],
        ["b", { text: "済んだ", done: true }],
      ]),
    );
    doc.getMap<string>(DUE_MAP).set("a", "2026-11-12");
    doc.getMap<string>(DUE_MAP).set("b", "2026-11-12");
    expect(remindersIn(doc, DUE_MAP, NOW).map((each) => each.key)).toEqual(["a:eve", "a:morning"]);
  });
});
