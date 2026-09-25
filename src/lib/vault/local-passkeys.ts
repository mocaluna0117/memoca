"use client";

import { useSyncExternalStore } from "react";
import { platformAuthenticatorAvailable } from "@/lib/crypto/passkey";
import { getMeta, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";

/**
 * Passkeys known to live on this device: ones registered or used here.
 *
 * Kept in memory as well as on disk, because the passkey prompt has to start
 * inside the tap that asked for it, with no storage read in between.
 */
let known: string[] = [];
let loaded: Promise<void> | null = null;
const knownListeners = new Set<() => void>();

function setKnown(next: string[]) {
  known = next;
  for (const listener of knownListeners) listener();
}

export function loadLocalPasskeys(): Promise<void> {
  loaded ??= getMeta<string[]>(META.passkeyLocal, []).then((ids) => {
    setKnown(Array.from(new Set([...known, ...ids])));
  });
  return loaded;
}

export function localPasskeyIds(): string[] {
  return known;
}

export function useLocalPasskeyIds(): string[] {
  return useSyncExternalStore(
    (listener) => {
      knownListeners.add(listener);
      return () => knownListeners.delete(listener);
    },
    () => known,
    () => EMPTY,
  );
}
const EMPTY: string[] = [];

export async function rememberLocalPasskey(credentialId: string): Promise<void> {
  if (known.includes(credentialId)) return;
  setKnown([...known, credentialId]);
  await setMeta(META.passkeyLocal, known);
}

export async function forgetLocalPasskey(credentialId: string): Promise<void> {
  if (!known.includes(credentialId)) return;
  setKnown(known.filter((id) => id !== credentialId));
  await setMeta(META.passkeyLocal, known);
}

/**
 * Whether this device has a platform authenticator (Face ID, Touch ID and so
 * on). The browser only answers asynchronously, so it is asked once at start
 * and kept, for the same reason as above: a tap cannot wait for it.
 */
let platform: boolean | null = null;
const platformListeners = new Set<() => void>();

export function loadPlatformSupport(): void {
  if (platform !== null) return;
  void platformAuthenticatorAvailable().then((available) => {
    platform = available;
    for (const listener of platformListeners) listener();
  });
}

export function platformPasskeyAvailable(): boolean {
  return platform === true;
}

export function usePlatformPasskey(): boolean {
  return useSyncExternalStore(
    (listener) => {
      platformListeners.add(listener);
      return () => platformListeners.delete(listener);
    },
    () => platform === true,
    () => false,
  );
}

/** For tests: forget everything in memory. */
export function resetLocalPasskeysForTests(): void {
  setKnown([]);
  loaded = null;
  platform = null;
}

/** For tests: pretend the platform authenticator question was answered. */
export function setPlatformSupportForTests(available: boolean): void {
  platform = available;
}
