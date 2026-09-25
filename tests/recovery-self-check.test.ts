import { describe, expect, test, vi } from "vitest";
import { randomBytes } from "@/lib/crypto/primitives";
import { issueRecoveryWrap, prepareVault, vault } from "@/lib/crypto/vault";
import { FAST_ARGON } from "./helpers/seed";

// Reintroduces the old display bug: the key as shown is cut short.
vi.mock("@/lib/crypto/recovery-key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/crypto/recovery-key")>();
  return {
    ...actual,
    formatRecoveryKey: (key: Uint8Array) => actual.formatRecoveryKey(key).slice(0, 49),
  };
});

describe("a recovery key that would not open the vault as shown", () => {
  test("stops a new vault from being made", async () => {
    await expect(prepareVault("パスワード", FAST_ARGON)).rejects.toThrow(/read back/);
    expect(vault.isUnlocked).toBe(false);
  });

  test("stops a replacement key from being saved", async () => {
    await expect(issueRecoveryWrap(randomBytes(32))).rejects.toThrow(/read back/);
  });
});
