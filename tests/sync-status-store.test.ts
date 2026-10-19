import { describe, expect, test, vi } from "vitest";
import type { SyncStatus } from "@/lib/sync/engine";
import { createStatusStore, sameStatus } from "@/lib/sync/status-store";

const idle: SyncStatus = {
  state: "idle",
  pending: 0,
  lastSyncAt: null,
  catchingUp: false,
  quotaFull: false,
};

describe("the sync status store", () => {
  test("a status that says the same does not notify, and the snapshot stays", () => {
    const store = createStatusStore(idle);
    const listener = vi.fn();
    store.subscribe(listener);

    store.set({ ...idle });
    expect(listener).not.toHaveBeenCalled();
    expect(store.get()).toBe(idle);
  });

  test("a changed field notifies once, with the new snapshot to read", () => {
    const store = createStatusStore(idle);
    const listener = vi.fn();
    store.subscribe(listener);

    const syncing: SyncStatus = { ...idle, state: "syncing" };
    store.set(syncing);
    expect(listener).toHaveBeenCalledOnce();
    expect(store.get()).toBe(syncing);

    // Each field counts, null ones included.
    store.set({ ...syncing, lastSyncAt: 1 });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.get().lastSyncAt).toBe(1);
  });

  test("unsubscribed, a listener hears no more", () => {
    const store = createStatusStore(idle);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();

    store.set({ ...idle, pending: 2 });
    expect(listener).not.toHaveBeenCalled();
    expect(store.get().pending).toBe(2);
  });

  test("statuses are the same by their fields, whatever object holds them", () => {
    expect(sameStatus(idle, { ...idle })).toBe(true);
    expect(sameStatus(idle, { ...idle, quotaFull: true })).toBe(false);
    expect(sameStatus(idle, { ...idle, catchingUp: true })).toBe(false);
  });
});
