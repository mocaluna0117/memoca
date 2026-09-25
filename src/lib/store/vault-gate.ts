"use client";

import { create } from "zustand";
import { startPasskey } from "@/lib/crypto/passkey";
import { vault } from "@/lib/crypto/vault";
import { localPasskeyIds, platformPasskeyAvailable } from "@/lib/vault/local-passkeys";
import { type VaultPurpose, needsConfirmation, needsServer } from "@/lib/vault/purpose";
import { useVaultRecord } from "@/lib/vault/record";

export type VaultResult = { ok: true } | { ok: false; reason: "cancelled" };

/**
 * Whether a tap that asks for the vault may start Face ID / Touch ID itself.
 * A switch rather than a rule, because WebKit only shows the sheet while the
 * tap still counts, and that is only certain on a real device.
 */
export const AUTO_START_PASSKEY = true;

export type AutoPasskey = {
  attempt: ReturnType<typeof startPasskey>;
  controller: AbortController;
};

export type VaultRequest = {
  id: number;
  purpose: VaultPurpose;
  /** Where focus goes when the prompt closes. */
  returnFocus: HTMLElement | null;
  /** A passkey sheet already started by the tap that asked. */
  auto: AutoPasskey | null;
  resolve: (result: VaultResult) => void;
};

type VaultGateState = {
  request: VaultRequest | null;
  /**
   * Asks for the vault for a stated purpose and resolves once there is an
   * answer. With the vault open and nothing to confirm, it resolves at once
   * and nothing is shown. `gesture` means the call is inside a tap.
   */
  requestVault: (
    purpose: VaultPurpose,
    opts?: { gesture?: boolean; returnFocus?: HTMLElement | null },
  ) => Promise<VaultResult>;
  /** Ends the current request with this result and closes the prompt. */
  finish: (result: VaultResult) => void;
};

let nextId = 1;

/** Starts the passkey sheet now, inside the tap, when everything allows it. */
function autoStart(purpose: VaultPurpose): AutoPasskey | null {
  if (!AUTO_START_PASSKEY) return null;
  if (purpose.kind !== "open" && purpose.kind !== "lockNote" && purpose.kind !== "createInLocked") {
    return null;
  }
  if (needsServer(purpose) && typeof navigator !== "undefined" && !navigator.onLine) return null;
  const record = useVaultRecord.getState().record;
  if (!record || record.passkeys.length === 0 || !platformPasskeyAvailable()) return null;
  // Only a passkey known to be on this device: starting a sheet that ends in
  // "use another device" would be worse than asking first.
  const local = localPasskeyIds();
  if (!record.passkeys.some((entry) => local.includes(entry.credentialId))) return null;
  const controller = new AbortController();
  const attempt = startPasskey(record.passkeys, local, { signal: controller.signal });
  // Handled by the prompt; this keeps an early failure from being unhandled.
  attempt.catch(() => undefined);
  return { attempt, controller };
}

export const useVaultGate = create<VaultGateState>((set, get) => ({
  request: null,
  requestVault: (purpose, opts = {}) => {
    if (vault.isUnlocked && !needsConfirmation(purpose)) {
      return Promise.resolve({ ok: true });
    }
    // Only one prompt at a time; an older request is simply not continued.
    get().request?.auto?.controller.abort();
    get().request?.resolve({ ok: false, reason: "cancelled" });

    const returnFocus =
      opts.returnFocus ??
      (typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    const auto = opts.gesture && !vault.isUnlocked ? autoStart(purpose) : null;

    return new Promise<VaultResult>((resolve) => {
      let settled = false;
      const once = (result: VaultResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      set({ request: { id: nextId++, purpose, returnFocus, auto, resolve: once } });
    });
  },
  finish: (result) => {
    const request = get().request;
    if (!request) return;
    if (!result.ok) request.auto?.controller.abort();
    set({ request: null });
    request.resolve(result);
  },
}));

/** Shorthand for callers outside React. */
export const requestVault: VaultGateState["requestVault"] = (purpose, opts) =>
  useVaultGate.getState().requestVault(purpose, opts);
