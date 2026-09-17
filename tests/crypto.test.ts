import { describe, expect, test } from "vitest";
import { toBytes } from "@/lib/bytes";
import { ctx } from "@/lib/crypto/context";
import {
  DEFAULT_ARGON,
  importAesKey,
  open,
  randomBytes,
  seal,
} from "@/lib/crypto/primitives";
import {
  createVault,
  extractVaultRaw,
  rewrapWithPassword,
  unlockWithPassword,
  unlockWithRecoveryKey,
  vault,
} from "@/lib/crypto/vault";

/** Argon2id at production settings is too slow for a test suite. */
const FAST_ARGON = { m: 1024, t: 1, p: 1 };

const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array) => new TextDecoder().decode(b);

describe("authenticated encryption", () => {
  test("a sealed value comes back unchanged", async () => {
    const key = await importAesKey(randomBytes(32));
    const { ct, iv } = await seal(key, text("秘密のメモ本文"), ctx.yjsUpdate("n1", 1));
    expect(read(await open(key, ct, iv, ctx.yjsUpdate("n1", 1)))).toBe("秘密のメモ本文");
  });

  test("moving a ciphertext to another note fails to decrypt", async () => {
    const key = await importAesKey(randomBytes(32));
    const { ct, iv } = await seal(key, text("note one"), ctx.yjsUpdate("n1", 1));
    await expect(open(key, ct, iv, ctx.yjsUpdate("n2", 1))).rejects.toThrow();
  });

  test("replaying a ciphertext at an older key epoch fails", async () => {
    const key = await importAesKey(randomBytes(32));
    const { ct, iv } = await seal(key, text("epoch two"), ctx.yjsUpdate("n1", 2));
    await expect(open(key, ct, iv, ctx.yjsUpdate("n1", 1))).rejects.toThrow();
  });

  test("a snapshot cannot be opened as an incremental update", async () => {
    // These are sealed in different places and opened in one; naming the wrong
    // context has to fail loudly rather than silently return the wrong bytes.
    const key = await importAesKey(randomBytes(32));
    const snapshot = await seal(key, text("merged document"), ctx.yjsSnapshot("n1", 1));
    await expect(
      open(key, snapshot.ct, snapshot.iv, ctx.yjsUpdate("n1", 1)),
    ).rejects.toThrow();
    expect(ctx.yjsSnapshot("n1", 1)).not.toBe(ctx.yjsUpdate("n1", 1));
  });

  test("a flipped bit is detected", async () => {
    const key = await importAesKey(randomBytes(32));
    const { ct, iv } = await seal(key, text("改ざん検知"), ctx.noteTitle("n1", 0));
    ct[0] ^= 0x01;
    await expect(open(key, ct, iv, ctx.noteTitle("n1", 0))).rejects.toThrow();
  });
});

describe("vault", () => {
  test("the password and the recovery key each open the same vault", async () => {
    const { record, recoveryKey } = await createVault("とても長いパスフレーズ", FAST_ARGON);
    const full = { ...record, passkeys: [], version: 1 };

    const noteId = "note-1";
    const { key, wrapped } = await vault.createNoteKey(noteId, 1);
    const sealed = await seal(key, text("本文"), ctx.yjsUpdate(noteId, 1));

    vault.lock();
    expect(vault.isUnlocked).toBe(false);

    await unlockWithPassword(full, "とても長いパスフレーズ");
    const viaPassword = await vault.noteKey(noteId, 1, wrapped);
    expect(read(await open(viaPassword, sealed.ct, sealed.iv, ctx.yjsUpdate(noteId, 1)))).toBe(
      "本文",
    );

    vault.lock();
    await unlockWithRecoveryKey(full, recoveryKey);
    const viaRecovery = await vault.noteKey(noteId, 1, wrapped);
    expect(read(await open(viaRecovery, sealed.ct, sealed.iv, ctx.yjsUpdate(noteId, 1)))).toBe(
      "本文",
    );
    vault.lock();
  });

  test("the wrong password is refused", async () => {
    const { record } = await createVault("正しいパスワード", FAST_ARGON);
    vault.lock();
    await expect(
      unlockWithPassword({ ...record, passkeys: [], version: 1 }, "ちがうパスワード"),
    ).rejects.toThrow();
    expect(vault.isUnlocked).toBe(false);
  });

  test("changing the password keeps existing notes readable", async () => {
    const { record } = await createVault("ふるいパスワード", FAST_ARGON);
    const { key, wrapped } = await vault.createNoteKey("n1", 1);
    const sealed = await seal(key, text("変わらない本文"), ctx.yjsUpdate("n1", 1));

    const full = { ...record, passkeys: [], version: 1 };
    const next = await rewrapWithPassword(
      full,
      "ふるいパスワード",
      "あたらしいパスワード",
      FAST_ARGON,
    );

    vault.lock();
    await unlockWithPassword({ ...full, ...next }, "あたらしいパスワード");
    const key2 = await vault.noteKey("n1", 1, wrapped);
    expect(read(await open(key2, sealed.ct, sealed.iv, ctx.yjsUpdate("n1", 1)))).toBe(
      "変わらない本文",
    );
    vault.lock();
  });

  test("locking clears the key and further use throws", async () => {
    await createVault("パスワード", FAST_ARGON);
    expect(vault.isUnlocked).toBe(true);
    vault.lock();
    await expect(vault.createNoteKey("n1", 1)).rejects.toThrow();
  });

  test("the recovery key reproduces the same vault key as the password", async () => {
    const { record, recoveryKey } = await createVault("パスワード", FAST_ARGON);
    const full = { ...record, passkeys: [], version: 1 };
    const viaPassword = await extractVaultRaw(full, { password: "パスワード" });
    const viaRecovery = await extractVaultRaw(full, { recoveryKey });
    expect(toBytes(viaPassword)).toEqual(toBytes(viaRecovery));
    vault.lock();
  });
});

describe("argon parameters", () => {
  test("the shipped defaults are at or above the OWASP floor", () => {
    expect(DEFAULT_ARGON.m).toBeGreaterThanOrEqual(19456);
    expect(DEFAULT_ARGON.t).toBeGreaterThanOrEqual(2);
  });
});
