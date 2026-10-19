import type { SyncStatus } from "@/lib/sync/engine";

/** How long after a repair pass run on sync settling the next such pass may run. */
export const REPAIR_SETTLED_EVERY_MS = 10 * 60_000;

/** What is remembered of the passes between changes of the sync status. */
export type RepairSchedule = {
  /** When a pass last ran on sync settling (0: never). */
  lastSettledRunAt: number;
  /** A catch-up with the server is over, and the pass it calls for has not run yet. */
  catchUpOwed: boolean;
};

export const NO_PASS_YET: RepairSchedule = { lastSettledRunAt: 0, catchUpOwed: false };

/** Nothing of this device's waits to be sent, and nothing of the server's to be taken in. */
export function settled(status: SyncStatus): boolean {
  return status.state === "idle" && !status.catchingUp && status.pending === 0;
}

/**
 * Whether a change of the sync status calls for a repair pass, and why, with
 * what to remember. A catch-up with the server over ("catchUp"): what came in
 * may need putting right, every time. The engine says so as the last page
 * starts to be taken in, so the pass waits for sync to settle, with that
 * page in. Sync settled ("settled"): at most once every ten minutes, since
 * it settles again after every flush of a note being typed in. `prev` is
 * null for the first status seen, which counts as settling, or as a
 * catch-up under way.
 */
export function repairDue(
  prev: SyncStatus | null,
  next: SyncStatus,
  schedule: RepairSchedule,
  now: number,
): { run: "catchUp" | "settled" | null; schedule: RepairSchedule } {
  const owed =
    schedule.catchUpOwed || (prev ? prev.catchingUp && !next.catchingUp : next.catchingUp);
  if (!settled(next)) {
    return {
      run: null,
      schedule: owed === schedule.catchUpOwed ? schedule : { ...schedule, catchUpOwed: owed },
    };
  }
  if (owed) return { run: "catchUp", schedule: { ...schedule, catchUpOwed: false } };
  const settling = prev === null || !settled(prev);
  if (settling && now - schedule.lastSettledRunAt >= REPAIR_SETTLED_EVERY_MS) {
    return { run: "settled", schedule };
  }
  return { run: null, schedule };
}
