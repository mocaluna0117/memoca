import { describe, expect, test } from "vitest";
import { toBase32 } from "@/lib/bytes";
import { randomBytes } from "@/lib/crypto/primitives";
import {
  RECOVERY_KEY_LENGTH,
  formatRecoveryKey,
  parseRecoveryKey,
  recoveryKeyCharacters,
} from "@/lib/crypto/recovery-key";
import { prepareVault, unlockWithRecoveryKey, vault } from "@/lib/crypto/vault";
import { FAST_ARGON } from "./helpers/seed";

const fullWidth = (text: string) =>
  text.replace(/[A-Za-z0-9-]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));

describe("recovery key", () => {
  test("the key exactly as shown opens the vault", async () => {
    const prepared = await prepareVault("パスワード", FAST_ARGON);
    const shown = formatRecoveryKey(prepared.recoveryKey);

    const parsed = parseRecoveryKey(shown);
    expect(parsed.ok).toBe(true);
    await unlockWithRecoveryKey(
      { ...prepared.record, passkeys: [], version: 1 },
      parsed.ok ? parsed.key : new Uint8Array(),
    );
    expect(vault.isUnlocked).toBe(true);
    vault.lock();
  });

  test("it is shown in full, in 13 groups of four", () => {
    const shown = formatRecoveryKey(randomBytes(32));
    const groups = shown.split("-");
    expect(groups).toHaveLength(13);
    expect(groups.every((group) => group.length === 4)).toBe(true);
    expect(groups.join("")).toHaveLength(RECOVERY_KEY_LENGTH);
  });

  test("however it is typed, it reads back as the same key", () => {
    const key = randomBytes(32);
    const shown = formatRecoveryKey(key);
    const variants = [
      shown.toLowerCase(),
      shown.replace(/-/g, " "),
      shown.replace(/-/g, ""),
      ` ${shown.replace(/-/g, "\n")} `,
      fullWidth(shown),
      // Base32 has no 0, 1 or 8, so those are the look-alike letters.
      shown.replace(/O/g, "0").replace(/I/g, "1").replace(/B/g, "8"),
    ];
    for (const typed of variants) {
      const parsed = parseRecoveryKey(typed);
      expect(parsed.ok, typed).toBe(true);
      if (parsed.ok) expect(Array.from(parsed.key)).toEqual(Array.from(key));
    }
  });

  test("a key from the old, cut-short display is recognised as such", () => {
    const old = toBase32(randomBytes(32)).slice(0, 40).match(/.{1,5}/g)!.join("-");
    expect(parseRecoveryKey(old)).toEqual({ ok: false, reason: "legacy", length: 40 });
  });

  test("a key with a character missing or extra says how long it should be", () => {
    const text = formatRecoveryKey(randomBytes(32)).replace(/-/g, "");
    expect(parseRecoveryKey(text.slice(0, 51))).toEqual({ ok: false, reason: "length", length: 51 });
    expect(parseRecoveryKey(`${text}A`)).toEqual({ ok: false, reason: "length", length: 53 });
    expect(recoveryKeyCharacters(fullWidth(text.slice(0, 10)))).toBe(10);
  });

  test("anything but a 32-byte key is refused rather than shown", () => {
    expect(() => formatRecoveryKey(randomBytes(25))).toThrow();
  });
});
