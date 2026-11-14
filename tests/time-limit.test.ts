import { describe, expect, test, vi } from "vitest";
import { TookTooLong, within } from "@/lib/time-limit";

describe("a network step given a time", () => {
  test("its answer when it comes in time", async () => {
    await expect(within(Promise.resolve(3), 1000, "x")).resolves.toBe(3);
  });

  test("TookTooLong when it never answers, so what waits on it can go on", async () => {
    vi.useFakeTimers();
    const never = within(new Promise(() => {}), 30_000, "attachment address");
    const told = expect(never).rejects.toBeInstanceOf(TookTooLong);
    await vi.advanceTimersByTimeAsync(30_000);
    await told;
    vi.useRealTimers();
  });
});
