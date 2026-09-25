import { describe, expect, test } from "vitest";
import { toBase32 } from "@/lib/bytes";
import { randomBytes } from "@/lib/crypto/primitives";
import {
  RECOVERY_KEY_LENGTH,
  formatRecoveryKey,
  parseRecoveryKey,
  recoveryKeyCharacters,
  recoveryKeyTail,
} from "@/lib/crypto/recovery-key";
import {
  issueRecoveryWrap,
  openVaultRaw,
  prepareVault,
  rewrapPasswordFromRaw,
  unlockWithPassword,
  unlockWithRecoveryKey,
  vault,
  verifyRecoveryKey,
  wrapForPasskey,
} from "@/lib/crypto/vault";
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

describe("replacing the recovery key", () => {
  test("a new key opens the vault as shown, and the old one no longer does", async () => {
    const prepared = await prepareVault("パスワード", FAST_ARGON);
    const record = { ...prepared.record, passkeys: [], version: 1 };
    const oldKey = prepared.recoveryKey.slice();

    const raw = await openVaultRaw(record, { password: "パスワード" });
    const { recWrap, recoveryKey } = await issueRecoveryWrap(raw);
    const next = { ...record, recWrap, version: 2 };

    const shown = parseRecoveryKey(formatRecoveryKey(recoveryKey));
    expect(shown.ok && (await verifyRecoveryKey(next, shown.key))).toBe(true);
    expect(await verifyRecoveryKey(next, oldKey)).toBe(false);
    // Checking a key never opens the vault.
    expect(vault.isUnlocked).toBe(false);
  });

  test("a forgotten password is replaced with the recovery key alone", async () => {
    const prepared = await prepareVault("わすれたパスワード", FAST_ARGON);
    const record = { ...prepared.record, passkeys: [], version: 1 };

    const raw = await openVaultRaw(record, { recoveryKey: prepared.recoveryKey });
    const next = { ...record, ...(await rewrapPasswordFromRaw(raw, "あたらしい", FAST_ARGON)) };

    await expect(unlockWithPassword(next, "わすれたパスワード")).rejects.toThrow();
    await unlockWithPassword(next, "あたらしい");
    expect(vault.isUnlocked).toBe(true);
    vault.lock();
  });

  test("a passkey's PRF output gives the same vault key as the password", async () => {
    const prepared = await prepareVault("パスワード", FAST_ARGON);
    const record = { ...prepared.record, passkeys: [], version: 1 };
    const raw = await openVaultRaw(record, { password: "パスワード" });

    const output = randomBytes(32);
    const wrap = await wrapForPasskey(output, raw);
    const entry = {
      credentialId: "cred",
      prfInput: new Uint8Array(32).buffer,
      label: "Mac",
      createdAt: 0,
      ...wrap,
    };
    const viaPasskey = await openVaultRaw(record, { prf: { entry, output } });
    expect(Array.from(viaPasskey)).toEqual(Array.from(raw));
  });

  test("the last four characters are compared however they are typed", () => {
    const shown = formatRecoveryKey(randomBytes(32));
    const tail = shown.replace(/-/g, "").slice(-4);
    expect(recoveryKeyTail(shown)).toBe(tail);
    expect(recoveryKeyTail(` ${tail.toLowerCase()} `)).toBe(tail);
  });
});
