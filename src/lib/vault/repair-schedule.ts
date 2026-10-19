import type { SyncStatus } from "@/lib/sync/engine";

/** How long after a repair pass run on sync settling the next such pass may run. */
export const REPAIR_SETTLED_EVERY_MS = 10 * 60_000;

/** Nothing of this device's waits to be sent, and nothing of the server's to be taken in. */
export function settled(status: SyncStatus): boolean {
  return status.state === "idle" && !status.catchingUp && status.pending === 0;
}

/**
 * Whether a change of the sync status calls for a repair pass, and why: a
 * catch-up with the server is over ("catchUp"; what came in may need putting
 * right, every time), or sync has settled ("settled"; at most once every ten
 * minutes, since it settles again after every flush of a note being typed
 * in). `prev` is null for the first status seen, which counts as settling.
 */
export function repairDue(
  prev: SyncStatus | null,
  next: SyncStatus,
  lastSettledRunAt: number,
  now: number,
): "catchUp" | "settled" | null {
  if (prev?.catchingUp && !next.catchingUp) return "catchUp";
  const settling = (prev === null || !settled(prev)) && settled(next);
  if (settling && now - lastSettledRunAt >= REPAIR_SETTLED_EVERY_MS) return "settled";
  return null;
}
