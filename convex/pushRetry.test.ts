import { describe, expect, test } from "vitest";
import { againAfterMs, worthAgain } from "./lib/pushRetry";

describe("a reminder its push service did not take", () => {
  test("is tried again when the service was busy, failing, or not reached", () => {
    expect(worthAgain(undefined)).toBe(true);
    expect(worthAgain(429)).toBe(true);
    expect(worthAgain(503)).toBe(true);
  });

  test("not when the device is gone or the request refused for good", () => {
    expect(worthAgain(410)).toBe(false);
    expect(worthAgain(400)).toBe(false);
    expect(worthAgain(413)).toBe(false);
  });

  test("a minute later, then two, then three", () => {
    expect([1, 2, 3].map(againAfterMs)).toEqual([60_000, 120_000, 180_000]);
  });
});
