"use client";

import { useSyncExternalStore } from "react";
import {
  type DeviceWrap,
  type VaultRecord,
  openVaultRaw,
  unlockWithDevice,
  wrapForDevice,
} from "@/lib/crypto/vault";
import { wipe } from "@/lib/crypto/primitives";
import { getMeta, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import type { DeviceUnlockKind } from "@/lib/quick/shell";

/**
 * The vault opened by the computer's own check, in the desktop app: Touch ID
 * on a Mac, Windows Hello on Windows (desktop/src-tauri/src/device_unlock.rs).
 * The app hands over a secret of the computer's once the person has proved
 * themselves; a copy of the vault key wrapped under it is kept on this
 * device alone, never sent anywhere. Not a passkey: the desktop app cannot
 * have those (docs/DESKTOP.md).
 */

/** What the computer can do, and whether this device keeps a copy to open. */
export type DeviceUnlockState = {
  kind: DeviceUnlockKind | null;
  enrolled: boolean;
};

let state: DeviceUnlockState = { kind: null, enrolled: false };
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: Partial<DeviceUnlockState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

/** The secret as the app sends it, base64. */
function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

const shell = () => (typeof window === "undefined" ? undefined : window.memocaShell?.deviceUnlock);

/** Finds out, once, what the desktop app offers and what this device keeps. */
export function loadDeviceUnlock(): Promise<void> {
  loaded ??= (async () => {
    const bridge = shell();
    if (!bridge) return;
    const [kind, wrap] = await Promise.all([
      bridge.kind().catch(() => null),
      getMeta<DeviceWrap | null>(META.deviceUnlock, null),
    ]);
    set({ kind, enrolled: kind !== null && wrap !== null });
  })();
  return loaded;
}

export function useDeviceUnlock(): DeviceUnlockState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      void loadDeviceUnlock();
      return () => listeners.delete(listener);
    },
    () => state,
    () => state,
  );
}

/** The check's name, as the person knows it. */
export function deviceUnlockLabel(kind: DeviceUnlockKind): string {
  return kind === "touchId" ? "Touch ID" : "Windows Hello";
}

/** The person said no (closed the system's sheet): nothing to say about it. */
export class DeviceUnlockCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "DeviceUnlockCancelled";
  }
}

async function secret(create: boolean): Promise<Uint8Array> {
  const bridge = shell();
  if (!bridge) throw new Error("unsupported");
  try {
    return fromBase64(await bridge.secret(create));
  } catch (cause) {
    if (String(cause).includes("cancelled")) throw new DeviceUnlockCancelled();
    throw cause;
  }
}

/**
 * Keeps a copy of the vault key on this device, opened by the computer's
 * check from now on. `raw` is the vault key, from the password just typed.
 */
export async function enrollDeviceUnlock(raw: Uint8Array): Promise<void> {
  const key = await secret(true);
  try {
    await setMeta(META.deviceUnlock, await wrapForDevice(key, raw));
  } finally {
    wipe(key);
  }
  set({ enrolled: true });
}

/** The same, from the password: for Settings, with the vault closed or open. */
export async function enrollDeviceUnlockWithPassword(
  record: VaultRecord,
  password: string,
): Promise<void> {
  const raw = await openVaultRaw(record, { password });
  try {
    await enrollDeviceUnlock(raw);
  } finally {
    wipe(raw);
  }
}

/**
 * Opens the vault with the computer's check. A copy the secret no longer
 * opens (the vault made again, say) is let go of, and the password asked
 * for instead.
 */
export async function unlockWithDeviceCheck(): Promise<void> {
  const wrap = await getMeta<DeviceWrap | null>(META.deviceUnlock, null);
  if (!wrap) throw new Error("not-enrolled");
  const key = await secret(false);
  try {
    await unlockWithDevice(wrap, key);
  } catch (cause) {
    if ((cause as { name?: string } | null)?.name === "OperationError") await forgetDeviceUnlock();
    throw cause;
  } finally {
    wipe(key);
  }
}

/** Stops opening with the computer's check here: the copy on this device goes. */
export async function forgetDeviceUnlock(): Promise<void> {
  await setMeta(META.deviceUnlock, null);
  set({ enrolled: false });
}

/** For tests: as if the desktop app offered `kind`, and this device kept a copy or not. */
export function setDeviceUnlockForTests(next: DeviceUnlockState | null): void {
  loaded = next ? Promise.resolve() : null;
  set(next ?? { kind: null, enrolled: false });
}
