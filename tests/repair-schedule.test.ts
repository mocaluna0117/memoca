import { describe, expect, test } from "vitest";
import type { SyncStatus } from "@/lib/sync/engine";
import {
  NO_PASS_YET,
  REPAIR_SETTLED_EVERY_MS,
  type RepairSchedule,
  repairDue,
  settled,
} from "@/lib/vault/repair-schedule";

const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  state: "idle",
  pending: 0,
  lastSyncAt: null,
  catchingUp: false,
  quotaFull: false,
  heldForVault: false,
  ...over,
});

const idle = status();
/** An edit of ours on its way to the server. */
const sending = status({ pending: 1 });
const catchingUp = status({ state: "syncing", catchingUp: true });
/** The last page of a catch-up being taken in. */
const lastPage = status({ state: "syncing" });
const NOW = 1_700_000_000_000;
/** A pass run on sync settling at `at`. */
const ran = (at: number): RepairSchedule => ({ lastSettledRunAt: at, catchUpOwed: false });

describe("whether a change of the sync status calls for a repair pass", () => {
  test("sync settling: a pass, and not another within ten minutes", () => {
    expect(repairDue(sending, idle, NO_PASS_YET, NOW).run).toBe("settled");
    expect(repairDue(sending, idle, ran(NOW - 60_000), NOW).run).toBeNull();
    expect(repairDue(sending, idle, ran(NOW - REPAIR_SETTLED_EVERY_MS + 1), NOW).run).toBeNull();
    expect(repairDue(sending, idle, ran(NOW - REPAIR_SETTLED_EVERY_MS), NOW).run).toBe("settled");
  });

  test("the first status seen counts as settling, if settled", () => {
    expect(repairDue(null, idle, NO_PASS_YET, NOW).run).toBe("settled");
    expect(repairDue(null, sending, NO_PASS_YET, NOW).run).toBeNull();
  });

  test("the end of a catch-up: a pass once sync settles, however recent the last", () => {
    // Said as the last page starts to be taken in: owed until sync settles.
    const owed = repairDue(catchingUp, lastPage, ran(NOW), NOW);
    expect(owed.run).toBeNull();
    expect(owed.schedule.catchUpOwed).toBe(true);
    const paid = repairDue(lastPage, idle, owed.schedule, NOW);
    expect(paid.run).toBe("catchUp");
    expect(paid.schedule.catchUpOwed).toBe(false);
    // Settled at once: paid at once.
    expect(repairDue(catchingUp, idle, ran(NOW), NOW).run).toBe("catchUp");
    // Started while catching up: owed from the start.
    const fromStart = repairDue(null, catchingUp, NO_PASS_YET, NOW);
    expect(fromStart.run).toBeNull();
    expect(fromStart.schedule.catchUpOwed).toBe(true);
    expect(repairDue(catchingUp, idle, fromStart.schedule, NOW).run).toBe("catchUp");
  });

  test("no edge: nothing, and nothing remembered", () => {
    expect(repairDue(idle, idle, NO_PASS_YET, NOW)).toEqual({ run: null, schedule: NO_PASS_YET });
    expect(repairDue(idle, status({ lastSyncAt: NOW }), NO_PASS_YET, NOW).run).toBeNull();
    expect(repairDue(idle, sending, NO_PASS_YET, NOW).run).toBeNull();
    expect(repairDue(sending, status({ pending: 2 }), NO_PASS_YET, NOW).run).toBeNull();
    expect(repairDue(status({ catchingUp: true }), catchingUp, NO_PASS_YET, NOW)).toEqual({
      run: null,
      schedule: NO_PASS_YET,
    });
  });

  test("settled is idle, caught up, with nothing waiting to be sent", () => {
    expect(settled(idle)).toBe(true);
    expect(settled(sending)).toBe(false);
    expect(settled(catchingUp)).toBe(false);
    expect(settled(status({ state: "offline" }))).toBe(false);
    expect(settled(status({ quotaFull: true }))).toBe(true);
  });
});
