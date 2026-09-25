"use client";

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

export function loadLocalPasskeys(): Promise<void> {
  loaded ??= getMeta<string[]>(META.passkeyLocal, []).then((ids) => {
    known = Array.from(new Set([...known, ...ids]));
  });
  return loaded;
}

export function localPasskeyIds(): string[] {
  return known;
}

export async function rememberLocalPasskey(credentialId: string): Promise<void> {
  if (known.includes(credentialId)) return;
  known = [...known, credentialId];
  await setMeta(META.passkeyLocal, known);
}

/** For tests: forget everything in memory. */
export function resetLocalPasskeysForTests(): void {
  known = [];
  loaded = null;
}
