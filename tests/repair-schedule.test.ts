import { describe, expect, test } from "vitest";
import type { SyncStatus } from "@/lib/sync/engine";
import { REPAIR_SETTLED_EVERY_MS, repairDue, settled } from "@/lib/vault/repair-schedule";

const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  state: "idle",
  pending: 0,
  lastSyncAt: null,
  catchingUp: false,
  quotaFull: false,
  ...over,
});

const idle = status();
/** An edit of ours on its way to the server. */
const sending = status({ pending: 1 });
const catchingUp = status({ state: "syncing", catchingUp: true });
const NOW = 1_700_000_000_000;

describe("whether a change of the sync status calls for a repair pass", () => {
  test("sync settling: a pass, and not another within ten minutes", () => {
    expect(repairDue(sending, idle, 0, NOW)).toBe("settled");
    expect(repairDue(sending, idle, NOW - 60_000, NOW)).toBeNull();
    expect(repairDue(sending, idle, NOW - REPAIR_SETTLED_EVERY_MS + 1, NOW)).toBeNull();
    expect(repairDue(sending, idle, NOW - REPAIR_SETTLED_EVERY_MS, NOW)).toBe("settled");
  });

  test("the first status seen counts as settling, if settled", () => {
    expect(repairDue(null, idle, 0, NOW)).toBe("settled");
    expect(repairDue(null, sending, 0, NOW)).toBeNull();
  });

  test("the end of a catch-up: a pass every time, however recent the last", () => {
    expect(repairDue(catchingUp, status({ state: "syncing" }), NOW, NOW)).toBe("catchUp");
    expect(repairDue(catchingUp, idle, NOW, NOW)).toBe("catchUp");
    expect(repairDue(catchingUp, idle, 0, NOW)).toBe("catchUp");
  });

  test("no edge: nothing", () => {
    expect(repairDue(idle, idle, 0, NOW)).toBeNull();
    expect(repairDue(idle, status({ lastSyncAt: NOW }), 0, NOW)).toBeNull();
    expect(repairDue(idle, sending, 0, NOW)).toBeNull();
    expect(repairDue(sending, status({ pending: 2 }), 0, NOW)).toBeNull();
    expect(repairDue(status({ catchingUp: true }), catchingUp, 0, NOW)).toBeNull();
  });

  test("settled is idle, caught up, with nothing waiting to be sent", () => {
    expect(settled(idle)).toBe(true);
    expect(settled(sending)).toBe(false);
    expect(settled(catchingUp)).toBe(false);
    expect(settled(status({ state: "offline" }))).toBe(false);
    expect(settled(status({ quotaFull: true }))).toBe(true);
  });
});
