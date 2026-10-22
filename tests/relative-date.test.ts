import { describe, expect, test } from "vitest";
import { relativeDate } from "@/lib/relative-date";

describe("relativeDate", () => {
  const now = new Date(2026, 9, 23, 15, 30).getTime();

  test("within the hour, in words", () => {
    expect(relativeDate(now - 10_000, now)).toBe("たった今");
    expect(relativeDate(now - 5 * 60_000, now)).toBe("5 分前");
  });

  test("earlier, as toLocale…String said it", () => {
    const today = new Date(2026, 9, 23, 9, 5);
    expect(relativeDate(today.getTime(), now)).toBe(
      today.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }),
    );
    const before = new Date(2026, 2, 4, 23, 59);
    expect(relativeDate(before.getTime(), now)).toBe(
      before.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" }),
    );
  });
});
