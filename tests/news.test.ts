import { beforeEach, describe, expect, test } from "vitest";
import { markNewsSeen, unread } from "@/lib/hooks/use-news";
import { NEWS } from "@/lib/news";

describe("the お知らせ", () => {
  test("each its own id, newest first, on a real day, with something to say", () => {
    expect(new Set(NEWS.map((item) => item.id)).size).toBe(NEWS.length);
    const dates = NEWS.map((item) => item.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    for (const item of NEWS) {
      expect(item.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(item.date))).toBe(false);
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.details.length).toBeGreaterThan(0);
    }
  });
});

describe("those not seen on this device", () => {
  beforeEach(() => localStorage.clear());

  /** Noon of a day here, as an account made then. */
  const madeOn = (day: string) => new Date(`${day}T12:00:00`).getTime();
  const after = (day: string) => NEWS.filter((item) => item.date > day).length;

  test("with none seen here, those after the day the account was made", () => {
    expect(unread(madeOn("2026-01-01"))).toBe(NEWS.length);
    expect(unread(madeOn("2026-09-28"))).toBe(after("2026-09-28"));
    expect(after("2026-09-28")).toBeGreaterThan(0);
    expect(after("2026-09-28")).toBeLessThan(NEWS.length);
    // Made on the day of the newest, or later: nothing new to them.
    expect(unread(madeOn(NEWS[0]!.date))).toBe(0);
    // Not known yet when: none, not all.
    expect(unread(null)).toBe(0);
  });

  test("once seen, those after the newest seen, however old the account", () => {
    localStorage.setItem("memoca:news-seen", NEWS[2]!.id);
    expect(unread(madeOn("2026-01-01"))).toBe(2);
    expect(unread(madeOn("2030-01-01"))).toBe(2);
    markNewsSeen();
    expect(unread(madeOn("2026-01-01"))).toBe(0);
    // One seen that is no longer there: as if none were.
    localStorage.setItem("memoca:news-seen", "gone");
    expect(unread(madeOn("2026-09-28"))).toBe(after("2026-09-28"));
  });
});
