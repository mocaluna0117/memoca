import { fromBase32, toBase32 } from "@/lib/bytes";
import { KEY_BYTES } from "./primitives";

/**
 * Stored with a vault's recovery wrapping: 2 means the key was shown in full.
 * Anything older was shown cut short and cannot open the vault.
 */
export const RECOVERY_FORMAT = 2;

/** Base32 characters in a full 32-byte recovery key. */
export const RECOVERY_KEY_LENGTH = 52;

/**
 * How long the key used to be on screen. An old display bug cut it to 40 of
 * its 52 characters, so a key of exactly this length is one of those and can
 * never open anything.
 */
const LEGACY_DISPLAY_LENGTH = 40;

const GROUP = 4;

/**
 * The recovery key as a person should copy it: all 52 characters, in groups
 * of four. Throws rather than ever showing a key that would not read back.
 */
export function formatRecoveryKey(key: Uint8Array): string {
  if (key.byteLength !== KEY_BYTES) {
    throw new Error(`A recovery key is ${KEY_BYTES} bytes, not ${key.byteLength}.`);
  }
  const text = toBase32(key);
  const parsed = parseRecoveryKey(text);
  if (!parsed.ok || !sameBytes(parsed.key, key)) {
    throw new Error("The recovery key does not read back as itself.");
  }
  return text.match(new RegExp(`.{1,${GROUP}}`, "g"))!.join("-");
}

export type ParsedRecoveryKey =
  | { ok: true; key: Uint8Array }
  | { ok: false; reason: "legacy" | "length"; length: number };

/**
 * Reads a recovery key however it was typed or pasted.
 *
 * Case, spaces, hyphens and full-width characters do not matter, and the
 * digits people write for look-alike letters (0 for O, 1 for I, 8 for B) are
 * read as those letters, since base32 has no 0, 1 or 8.
 */
export function parseRecoveryKey(input: string): ParsedRecoveryKey {
  const clean = input
    .normalize("NFKC")
    .toUpperCase()
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/8/g, "B")
    .replace(/[^A-Z2-7]/g, "");
  if (clean.length === LEGACY_DISPLAY_LENGTH) {
    return { ok: false, reason: "legacy", length: clean.length };
  }
  if (clean.length !== RECOVERY_KEY_LENGTH) {
    return { ok: false, reason: "length", length: clean.length };
  }
  const key = fromBase32(clean);
  if (key.byteLength !== KEY_BYTES) {
    return { ok: false, reason: "length", length: clean.length };
  }
  return { ok: true, key };
}

/** How many key characters the input holds, for a live "n / 52" count. */
export function recoveryKeyCharacters(input: string): number {
  return input
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "").length;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);
}
