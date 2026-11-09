import { describe, expect, test } from "vitest";
import { bucketOf, dueAt, dueOf, formatDue, readDue } from "@/lib/quick/todo-due";

/** Monday, 9 November 2026, 10:30, here. */
const MONDAY = new Date(2026, 10, 9, 10, 30);

describe("a Todo's due", () => {
  test("is a day, and a time if one is given, read back as it was kept", () => {
    expect(readDue("2026-11-13")).toEqual({ day: new Date(2026, 10, 13), time: null });
    expect(readDue("2026-11-13T23:59")).toEqual({ day: new Date(2026, 10, 13), time: "23:59" });
    expect(dueOf(new Date(2026, 10, 13), "09:00")).toBe("2026-11-13T09:00");
    expect(dueOf(new Date(2026, 0, 5), null)).toBe("2026-01-05");
  });

  test("anything else is none", () => {
    for (const bad of ["", "11/13", "2026-02-30", "2026-11-13T24:00", "2026-11-13T9:00", null, undefined]) {
      expect(readDue(bad), String(bad)).toBeNull();
      expect(bucketOf(bad, MONDAY)).toBe("none");
    }
  });

  test("reads as its month, day and weekday, its time, and its year when not this year's", () => {
    expect(formatDue("2026-11-13", MONDAY)).toBe("11/13(金)");
    expect(formatDue("2026-11-30T12:00", MONDAY)).toBe("11/30(月) 12:00");
    expect(formatDue("2027-01-05", MONDAY)).toBe("2027/1/5(火)");
  });

  test("with no time, is late once its day is over; with one, once the time has come", () => {
    expect(dueAt("2026-11-09")).toBe(new Date(2026, 10, 9, 23, 59, 59, 999).getTime());
    expect(dueAt("2026-11-09T10:00")).toBe(new Date(2026, 10, 9, 10, 0).getTime());
    expect(dueAt(undefined)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("the heading an item goes under", () => {
  test("from 期限切れ to それ以降, a week going from Monday to Sunday", () => {
    const on = (due: string) => bucketOf(due, MONDAY);
    expect(on("2026-11-08")).toBe("overdue");
    // Today's, its time gone: late.
    expect(on("2026-11-09T10:00")).toBe("overdue");
    expect(on("2026-11-09T23:59")).toBe("today");
    expect(on("2026-11-09")).toBe("today");
    expect(on("2026-11-10")).toBe("tomorrow");
    expect(on("2026-11-11")).toBe("week");
    expect(on("2026-11-15T23:59")).toBe("week");
    expect(on("2026-11-16")).toBe("later");
  });

  test("on a Saturday, Sunday is tomorrow and the week has no more; on a Sunday, Monday is tomorrow", () => {
    const saturday = new Date(2026, 10, 14, 9, 0);
    expect(bucketOf("2026-11-15", saturday)).toBe("tomorrow");
    expect(bucketOf("2026-11-16", saturday)).toBe("later");
    const sunday = new Date(2026, 10, 15, 9, 0);
    expect(bucketOf("2026-11-16", sunday)).toBe("tomorrow");
    expect(bucketOf("2026-11-17", sunday)).toBe("later");
    // A week on is past this week, whatever day it is.
    expect(bucketOf("2026-11-22", sunday)).toBe("later");
    expect(bucketOf("2026-11-16", MONDAY)).toBe("later");
  });
});
