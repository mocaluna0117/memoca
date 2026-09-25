"use client";

import type { FunctionReturnType } from "convex/server";
import { create } from "zustand";
import type { api } from "@convex/_generated/api";
import type { VaultRecord } from "@/lib/crypto/vault";
import { db, getMeta, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";

export type StoredVaultRecord = VaultRecord & {
  recoveryFormat: number | null;
  recoveryCheckedAt: number | null;
};

type Cached = { userKey: string; record: StoredVaultRecord };

type VaultRecordState = {
  /**
   * "unknown" until either the device's copy or the server says otherwise.
   * "none" only ever comes from the server: a device that has simply never
   * seen the vault must not be taken for an account without one, or it would
   * offer to create a second vault.
   */
  availability: "unknown" | "none" | "exists";
  record: StoredVaultRecord | null;
  source: "cache" | "server" | null;
  userKey: string | null;
};

/**
 * The vault record (wrapped keys and salts), kept on the device.
 *
 * Opening the vault needs only this record and the password, a passkey or the
 * recovery key, so keeping it here is what lets locked notes open with no
 * network. It holds nothing the server does not already have in the clear.
 */
export const useVaultRecord = create<VaultRecordState>(() => ({
  availability: "unknown",
  record: null,
  source: null,
  userKey: null,
}));

/** Loads this account's copy from the device, unless the server answered first. */
export async function hydrateVaultRecord(userKey: string): Promise<void> {
  const cached = await getMeta<Cached | null>(META.vaultRecord, null);
  const state = useVaultRecord.getState();
  if (state.userKey === userKey && state.source === "server") return;
  if (cached && cached.userKey === userKey) {
    useVaultRecord.setState({
      availability: "exists",
      record: cached.record,
      source: "cache",
      userKey,
    });
    return;
  }
  useVaultRecord.setState({ availability: "unknown", record: null, source: null, userKey });
}

/**
 * Takes the server's answer as the truth, and keeps a copy of it. The state
 * changes at once; the returned promise settles when the copy is stored.
 */
export async function acceptServerRecord(
  userKey: string,
  result: FunctionReturnType<typeof api.vault.record>,
): Promise<void> {
  if (result.state === "signedOut") return;
  if (result.state === "none") {
    useVaultRecord.setState({ availability: "none", record: null, source: "server", userKey });
    await db().meta.delete(META.vaultRecord);
    return;
  }
  const record: StoredVaultRecord = {
    argon: result.record.argon,
    saltPw: result.record.saltPw,
    pwWrap: result.record.pwWrap,
    recWrap: result.record.recWrap,
    passkeys: result.record.passkeys,
    version: result.record.version,
    recoveryFormat: result.record.recoveryFormat,
    recoveryCheckedAt: result.record.recoveryCheckedAt,
  };
  useVaultRecord.setState({ availability: "exists", record, source: "server", userKey });
  await setMeta(META.vaultRecord, { userKey, record } satisfies Cached);
}
