import type { SyncStatus } from "./engine";

const FIELDS = [
  "state",
  "pending",
  "lastSyncAt",
  "catchingUp",
  "quotaFull",
  "heldForVault",
] as const satisfies readonly (keyof SyncStatus)[];

/** Whether two statuses say the same, field by field. */
export function sameStatus(a: SyncStatus, b: SyncStatus): boolean {
  return FIELDS.every((field) => a[field] === b[field]);
}

export type StatusStore = {
  get: () => SyncStatus;
  set: (next: SyncStatus) => void;
  subscribe: (listener: () => void) => () => void;
};

/**
 * Where the sync status is kept for those who show it, outside React's
 * context: one changed by every flush of a note being typed in, the
 * context's value would be made again each time, and everything reading
 * anything from it drawn again with it.
 *
 * A status that says nothing new is dropped, the snapshot kept as it is:
 * useSyncExternalStore draws again on a new snapshot, not a new status.
 */
export function createStatusStore(initial: SyncStatus): StatusStore {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (next) => {
      if (sameStatus(current, next)) return;
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
