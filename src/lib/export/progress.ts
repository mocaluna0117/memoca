/**
 * How far a long task has come, as the whole percent the person is shown:
 * from the steps it is made of, each weighted by how long it takes.
 *
 * It never goes back, and it says 100 only when it is told the task is
 * finished, however far its steps have come. It says a new percent at most
 * once every {@link INTERVAL_MS} (the latest one, once that has passed), and
 * only when the whole number has changed: what is drawn for it is drawn no
 * more often than that.
 */

/** The least time between two percents said. */
export const INTERVAL_MS = 100;

/** A step of the task, or the task itself. */
export type ProgressPart = {
  /** This step is `fraction` done, from 0 to 1. Less than it was already is let go. */
  to(fraction: number): void;
  /**
   * This step as steps done one after another, each as large a share of it
   * as its weight is of all of them: the pages of a note, say, or several
   * notes by how long each is.
   */
  split(...weights: number[]): ProgressPart[];
};

export type Progress = {
  /** The whole task. */
  whole: ProgressPart;
  /** The task is done: says 100, at once. Nothing is said after. */
  finish(): void;
  /** The task has stopped short (failed or cancelled): nothing more is said. */
  stop(): void;
};

type Clock = {
  now: () => number;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
};

const realClock: Clock = {
  now: () => performance.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** Tracks a task's progress, saying each new percent to `onPercent`. */
export function trackProgress(
  onPercent: (percent: number) => void,
  { interval = INTERVAL_MS, clock = realClock }: { interval?: number; clock?: Clock } = {},
): Progress {
  /** How far, as a fraction of the whole. */
  let reached = 0;
  /** The percent last said, and when. */
  let said = 0;
  let saidAt = -Infinity;
  let timer: unknown = null;
  let over = false;

  /** Short of 100 until finished: a task whose steps are all done may still have its file to write. */
  const percent = () => Math.min(99, Math.floor(reached * 100));

  const say = () => {
    timer = null;
    if (over || percent() <= said) return;
    said = percent();
    saidAt = clock.now();
    onPercent(said);
  };

  const reach = (fraction: number) => {
    if (over || !(fraction > reached)) return;
    reached = Math.min(1, fraction);
    if (percent() <= said || timer !== null) return;
    const wait = saidAt + interval - clock.now();
    if (wait <= 0) say();
    else timer = clock.setTimeout(say, wait);
  };

  const part = (start: number, size: number): ProgressPart => ({
    to: (fraction) => {
      if (Number.isNaN(fraction)) return;
      reach(start + size * Math.min(1, Math.max(0, fraction)));
    },
    split: (...weights) => {
      const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
      let at = start;
      return weights.map((weight) => {
        const share = total > 0 ? (size * Math.max(0, weight)) / total : 0;
        const child = part(at, share);
        at += share;
        return child;
      });
    },
  });

  const end = () => {
    over = true;
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };

  return {
    whole: part(0, 1),
    finish: () => {
      if (over) return;
      end();
      said = 100;
      onPercent(100);
    },
    stop: end,
  };
}
