import { describe, expect, test } from "vitest";
import { FIRST_KEY, between } from "@/lib/sortkey";

describe("sort keys", () => {
  test("a key always fits between two neighbours", () => {
    let low = between(null, null);
    let high = between(low, null);
    for (let i = 0; i < 200; i += 1) {
      const mid = between(low, high);
      expect(low < mid).toBe(true);
      expect(mid < high).toBe(true);
      // Alternate which side we squeeze, which is what repeated drags do.
      if (i % 2 === 0) high = mid;
      else low = mid;
    }
  });

  test("appending keeps ascending order", () => {
    const keys: string[] = [];
    let last: string | null = null;
    for (let i = 0; i < 100; i += 1) {
      last = between(last, null);
      keys.push(last);
    }
    expect([...keys].sort()).toEqual(keys);
  });

  test("prepending keeps ascending order", () => {
    const keys: string[] = [];
    let first: string | null = null;
    for (let i = 0; i < 100; i += 1) {
      first = between(null, first);
      keys.unshift(first);
    }
    expect([...keys].sort()).toEqual(keys);
  });

  test("the first key is stable and usable", () => {
    expect(FIRST_KEY).toBe(between(null, null));
    expect(() => between(FIRST_KEY, null)).not.toThrow();
    expect(() => between(null, FIRST_KEY)).not.toThrow();
  });
});
