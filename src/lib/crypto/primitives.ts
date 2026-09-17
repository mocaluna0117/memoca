import { argon2id } from "hash-wasm";
import { toArrayBuffer } from "@/lib/bytes";

export const IV_BYTES = 12;
export const KEY_BYTES = 32;

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

/** Overwrites key material once it has been imported into WebCrypto. */
export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}

export async function importAesKey(
  raw: Uint8Array,
  extractable = false,
): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toArrayBuffer(raw), "AES-GCM", extractable, [
    "encrypt",
    "decrypt",
  ]);
}

const encoder = new TextEncoder();

/**
 * Every ciphertext is bound to what it is and where it belongs. Moving an
 * encrypted note body onto a different note, or replaying it at an older key
 * epoch, then fails to decrypt instead of quietly succeeding.
 */
export function aad(context: string): Uint8Array {
  return encoder.encode(context);
}

export async function seal(
  key: CryptoKey,
  plaintext: Uint8Array,
  context: string,
): Promise<{ ct: Uint8Array; iv: Uint8Array }> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad(context)) },
    key,
    toArrayBuffer(plaintext),
  );
  return { ct: new Uint8Array(ct), iv };
}

export async function open(
  key: CryptoKey,
  ct: Uint8Array,
  iv: Uint8Array,
  context: string,
): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: toArrayBuffer(aad(context)) },
    key,
    toArrayBuffer(ct),
  );
  return new Uint8Array(plain);
}

/** Stretches a high-entropy secret (a PRF output, a recovery key) into a key. */
export async function hkdfKey(
  secret: Uint8Array,
  salt: Uint8Array,
  info: string,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", toArrayBuffer(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(aad(info)),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export type ArgonParams = { m: number; t: number; p: number };

/**
 * Defaults chosen to take roughly one to two seconds on a mid-range phone.
 * hash-wasm runs single-threaded, so raising parallelism buys nothing here.
 * The parameters are stored with the vault and can be raised later without
 * invalidating anything.
 */
export const DEFAULT_ARGON: ArgonParams = { m: 65536, t: 3, p: 1 };

export async function argonKey(
  password: string,
  salt: Uint8Array,
  params: ArgonParams,
): Promise<CryptoKey> {
  const raw = await argon2id({
    password,
    salt,
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m,
    hashLength: KEY_BYTES,
    outputType: "binary",
  });
  const key = await importAesKey(raw);
  wipe(raw);
  return key;
}
