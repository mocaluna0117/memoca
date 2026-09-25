import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type CloseReason, prepareVault, vault } from "@/lib/crypto/vault";
import { FAST_ARGON } from "./helpers/seed";

const MINUTE = 60_000;

async function openVault() {
  (await prepareVault("パスワード", FAST_ARGON)).adopt();
}

/** Lets the close's own save passes (a few zero-length timers) run. */
async function settle() {
  await vi.advanceTimersByTimeAsync(2_000);
}

let closed: CloseReason[];
let stop: () => void;

beforeEach(async () => {
  await openVault();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vault.setAutoLockMinutes(1);
  closed = [];
  stop = vault.onClosed((reason) => closed.push(reason));
});

afterEach(() => {
  stop();
  vi.useRealTimers();
  vault.lock();
});

describe("closing after inactivity", () => {
  test("use keeps it open: the time counts from the last activity, not from opening", async () => {
    await vi.advanceTimersByTimeAsync(50_000);
    vault.touch();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(vault.isUnlocked).toBe(true);
    await vi.advanceTimersByTimeAsync(11_000);
    await settle();
    expect(vault.isUnlocked).toBe(false);
    expect(closed).toEqual(["idle"]);
  });

  test("a deadline that passed while the timer was not running closes on return", async () => {
    // A sleeping phone: the clock moves, but no timer fires.
    vi.setSystemTime(Date.now() + 2 * MINUTE);
    expect(vault.checkDeadline()).toBe(true);
    await settle();
    expect(vault.isUnlocked).toBe(false);
  });

  test("the first tap after such a sleep does not keep it open", async () => {
    vi.setSystemTime(Date.now() + 2 * MINUTE);
    vault.touch();
    await settle();
    expect(vault.isUnlocked).toBe(false);
  });

  test("work in progress holds it open, and the close happens when it is done", async () => {
    const release = vault.hold();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(vault.isUnlocked).toBe(true);
    release();
    await settle();
    expect(vault.isUnlocked).toBe(false);
    expect(closed).toEqual(["idle"]);
  });

  test("closing by hand during work waits for it, and says it was by hand", async () => {
    const release = vault.hold();
    await expect(vault.close()).resolves.toBe("deferred");
    expect(vault.isUnlocked).toBe(true);
    release();
    // Releasing twice changes nothing.
    release();
    await settle();
    expect(vault.isUnlocked).toBe(false);
    expect(closed).toEqual(["manual"]);
  });

  test("opening again starts a fresh countdown", async () => {
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    await settle();
    expect(vault.isUnlocked).toBe(false);
    vi.useRealTimers();
    await openVault();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vault.setAutoLockMinutes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vault.isUnlocked).toBe(true);
  });
});
