"use client";

import { deviceLabel } from "@/lib/crypto/platform";
import { wipe } from "@/lib/crypto/primitives";
import { type VaultRecord, openVaultRaw, wrapForPasskey } from "@/lib/crypto/vault";
import { toArrayBuffer } from "@/lib/bytes";
import { rememberLocalPasskey } from "./local-passkeys";

type AddPasskey = (args: {
  credentialId: string;
  prfInput: ArrayBuffer;
  hkdfSalt: ArrayBuffer;
  ct: ArrayBuffer;
  iv: ArrayBuffer;
  label: string;
}) => Promise<{ status: string }>;

/**
 * Wraps the vault key for a new passkey and saves it.
 *
 * The wrapping is opened again with the same PRF output before it is sent,
 * so a passkey that could not actually open the vault is never registered.
 */
export async function savePasskey(
  add: AddPasskey,
  record: VaultRecord,
  passkey: { credentialId: string; prfInput: Uint8Array },
  output: Uint8Array,
  raw: Uint8Array,
): Promise<"ok" | "tooMany"> {
  const wrap = await wrapForPasskey(output, raw);
  const entry = {
    credentialId: passkey.credentialId,
    prfInput: toArrayBuffer(passkey.prfInput),
    ...wrap,
    label: deviceLabel(),
    createdAt: Date.now(),
  };
  const reopened = await openVaultRaw(record, { prf: { entry, output } });
  const same = reopened.byteLength === raw.byteLength && reopened.every((b, i) => b === raw[i]);
  wipe(reopened);
  if (!same) throw new Error("The new passkey does not open the vault.");

  const result = await add({
    credentialId: entry.credentialId,
    prfInput: entry.prfInput,
    hkdfSalt: entry.hkdfSalt,
    ct: entry.ct,
    iv: entry.iv,
    label: entry.label,
  });
  if (result.status === "tooMany") return "tooMany";
  if (result.status !== "ok") throw new Error(result.status);
  await rememberLocalPasskey(entry.credentialId);
  return "ok";
}
