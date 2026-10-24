// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { INTERVAL_MS, trackProgress } from "@/lib/export/progress";

describe("how far a PDF has come, as a percent", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  /** Progress on the faked clock, and every percent it has said. */
  const tracked = () => {
    const said: number[] = [];
    const progress = trackProgress((percent) => said.push(percent), {
      clock: {
        now: () => Date.now(),
        setTimeout: (run, ms) => setTimeout(run, ms),
        clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      },
    });
    return { said, progress };
  };

  test("never goes back, and says 100 only once finished, however far its steps have come", () => {
    const { said, progress } = tracked();
    progress.whole.to(0.5);
    vi.advanceTimersByTime(INTERVAL_MS);
    progress.whole.to(0.3);
    vi.advanceTimersByTime(INTERVAL_MS);
    progress.whole.to(1);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(said).toEqual([50, 99]);
    progress.finish();
    expect(said).toEqual([50, 99, 100]);
  });

  test("says a percent at most every 100 ms: the latest, once that has passed", () => {
    const { said, progress } = tracked();
    progress.whole.to(0.1);
    expect(said).toEqual([10]);
    vi.advanceTimersByTime(10);
    progress.whole.to(0.2);
    vi.advanceTimersByTime(10);
    progress.whole.to(0.3);
    expect(said).toEqual([10]);
    vi.advanceTimersByTime(INTERVAL_MS - 21);
    expect(said).toEqual([10]);
    vi.advanceTimersByTime(1);
    expect(said).toEqual([10, 30]);
    // Nothing more was waiting.
    vi.advanceTimersByTime(1_000);
    expect(said).toEqual([10, 30]);
    // A step long after is said at once.
    progress.whole.to(0.4);
    expect(said).toEqual([10, 30, 40]);
  });

  test("says nothing until the whole percent changes", () => {
    const { said, progress } = tracked();
    progress.whole.to(0.004);
    progress.whole.to(0.101);
    vi.advanceTimersByTime(500);
    progress.whole.to(0.109);
    vi.advanceTimersByTime(500);
    expect(said).toEqual([10]);
  });

  test("shares the whole between steps by their weights, as several notes would be by their length", () => {
    const { said, progress } = tracked();
    // A short note, then one three times as long.
    const [short, long] = progress.whole.split(1, 3);
    short.to(1);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(said.at(-1)).toBe(25);
    long.to(0.5);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(said.at(-1)).toBe(62);
    // Each step split again: the long note's pages, the second half of it.
    const [, , third, fourth] = long.split(1, 1, 1, 1);
    third.to(1);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(said.at(-1)).toBe(81);
    fourth.to(0.5);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(said.at(-1)).toBe(90);
    fourth.to(1);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(said.at(-1)).toBe(99);
    expect(said).toEqual([...said].sort((a, b) => a - b));
  });

  test("a step reported again, or one before it, takes nothing back", () => {
    const { said, progress } = tracked();
    const [first, second] = progress.whole.split(1, 1);
    second.to(0.5);
    vi.advanceTimersByTime(INTERVAL_MS);
    first.to(0.5);
    second.to(0.2);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(said).toEqual([75]);
  });

  test("a fraction out of range is kept within its step; one not a number, or a step of no weight, moves nothing", () => {
    const { said, progress } = tracked();
    const [none, first, second] = progress.whole.split(0, 1, 1);
    none.to(1);
    first.to(Number.NaN);
    first.to(-3);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(said).toEqual([]);
    first.to(7);
    vi.advanceTimersByTime(INTERVAL_MS);
    second.to(Infinity);
    vi.advanceTimersByTime(INTERVAL_MS);
    expect(said).toEqual([50, 99]);
  });

  test("finished, it says 100 at once, and a percent still waiting never comes after it", () => {
    const { said, progress } = tracked();
    progress.whole.to(0.1);
    vi.advanceTimersByTime(10);
    progress.whole.to(0.6);
    progress.finish();
    expect(said).toEqual([10, 100]);
    vi.advanceTimersByTime(1_000);
    progress.whole.to(0.7);
    progress.finish();
    vi.advanceTimersByTime(1_000);
    expect(said).toEqual([10, 100]);
  });

  test("stopped short (failed or cancelled), it says nothing more, not even what was waiting", () => {
    const { said, progress } = tracked();
    progress.whole.to(0.1);
    vi.advanceTimersByTime(10);
    progress.whole.to(0.6);
    progress.stop();
    vi.advanceTimersByTime(1_000);
    progress.whole.to(0.9);
    progress.finish();
    vi.advanceTimersByTime(1_000);
    expect(said).toEqual([10]);
  });
});
