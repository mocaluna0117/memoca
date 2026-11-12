import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ctx } from "@/lib/crypto/context";
import { importAesKey, open, randomBytes, seal } from "@/lib/crypto/primitives";
import { vault } from "@/lib/crypto/vault";
import { getMeta, resetLocalData } from "@/lib/db";
import { META } from "@/lib/db/meta";
import {
  DeviceUnlockCancelled,
  enrollDeviceUnlock,
  setDeviceUnlockForTests,
  unlockWithDeviceCheck,
} from "@/lib/vault/device-unlock";

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** The desktop app's side, as device_unlock.rs answers: one secret, made once. */
function desktopApp({ cancel = false } = {}) {
  let secret: Uint8Array | null = null;
  window.memocaShell = {
    hide() {},
    openExternal() {},
    platform: "macos",
    deviceUnlock: {
      kind: async () => "touchId",
      secret: async (create: boolean) => {
        if (cancel) throw "cancelled";
        if (!secret && create) secret = randomBytes(32);
        if (!secret) throw "no-secret";
        return base64(secret);
      },
    },
  };
  return { replaceSecret: () => (secret = randomBytes(32)) };
}

beforeEach(async () => {
  await resetLocalData();
  setDeviceUnlockForTests(null);
  vault.lock();
});

afterEach(() => {
  delete window.memocaShell;
  vault.lock();
});

describe("the vault opened by the desktop app's own check", () => {
  test("a copy kept here opens the same vault key, and nothing else is needed", async () => {
    desktopApp();
    const raw = randomBytes(32);
    // Something sealed with the vault key, to tell it is the same key after.
    const sealed = await seal(
      await importAesKey(raw.slice()),
      new Uint8Array([7]),
      ctx.noteKeyWrap("n1", 1),
    );
    await enrollDeviceUnlock(raw.slice());

    await unlockWithDeviceCheck();
    expect(vault.isUnlocked).toBe(true);
    // The key the vault holds: private to it, read here only to compare.
    const key = (vault as unknown as { require(): CryptoKey }).require();
    expect(Array.from(await open(key, sealed.ct, sealed.iv, ctx.noteKeyWrap("n1", 1)))).toEqual([
      7,
    ]);
  });

  test("an answer long in coming (the Mac's keychain asking): given up meanwhile, it opens nothing; asked for again, the app is not asked twice", async () => {
    desktopApp();
    await enrollDeviceUnlock(randomBytes(32));
    const kept = await window.memocaShell!.deviceUnlock!.secret(false);
    // The app's answer held until let go.
    let answer: (secret: string) => void = () => {};
    let asked = 0;
    window.memocaShell!.deviceUnlock!.secret = () => {
      asked += 1;
      return new Promise<string>((resolve) => {
        answer = resolve;
      });
    };

    let wanted = true;
    const first = unlockWithDeviceCheck(() => wanted);
    // Given up (the prompt cancelled), and asked for again while the first is unanswered.
    wanted = false;
    const second = unlockWithDeviceCheck();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(asked).toBe(1);
    expect(vault.isUnlocked).toBe(false);

    answer(kept);
    await expect(first).rejects.toBeInstanceOf(DeviceUnlockCancelled);
    await second;
    expect(vault.isUnlocked).toBe(true);

    // Answered, the next ask is a new one.
    vault.lock();
    window.memocaShell!.deviceUnlock!.secret = async () => {
      asked += 1;
      return kept;
    };
    await unlockWithDeviceCheck();
    expect(asked).toBe(2);
  });

  test("closed by the person, the vault stays closed and the copy stays", async () => {
    desktopApp();
    await enrollDeviceUnlock(randomBytes(32));
    desktopApp({ cancel: true });
    await expect(unlockWithDeviceCheck()).rejects.toBeInstanceOf(DeviceUnlockCancelled);
    expect(vault.isUnlocked).toBe(false);
    expect(await getMeta(META.deviceUnlock, null)).not.toBeNull();
  });

  test("a copy the computer's secret no longer opens is let go of, for the password", async () => {
    const app = desktopApp();
    await enrollDeviceUnlock(randomBytes(32));
    app.replaceSecret();
    await expect(unlockWithDeviceCheck()).rejects.toMatchObject({ name: "OperationError" });
    expect(vault.isUnlocked).toBe(false);
    expect(await getMeta(META.deviceUnlock, null)).toBeNull();
  });
});
