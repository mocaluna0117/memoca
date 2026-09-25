import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { prepareVault, vault } from "@/lib/crypto/vault";
import { useVaultGate } from "@/lib/store/vault-gate";
import { FAST_ARGON } from "./helpers/seed";

beforeEach(() => {
  useVaultGate.setState({ request: null });
});

afterEach(() => {
  vault.lock();
  vi.restoreAllMocks();
});


describe("asking for the vault", () => {
  test("resolves at once when it is open and there is nothing to confirm", async () => {
    (await prepareVault("パスワード", FAST_ARGON)).adopt();
    await expect(
      useVaultGate.getState().requestVault({ kind: "lockNote", title: null }),
    ).resolves.toEqual({ ok: true });
    expect(useVaultGate.getState().request).toBeNull();
  });

  test("still asks for a yes to take a lock off, with the vault open", async () => {
    (await prepareVault("パスワード", FAST_ARGON)).adopt();
    const answer = useVaultGate.getState().requestVault({ kind: "unlockNote", title: null });
    expect(useVaultGate.getState().request?.purpose.kind).toBe("unlockNote");
    useVaultGate.getState().finish({ ok: false, reason: "cancelled" });
    await expect(answer).resolves.toEqual({ ok: false, reason: "cancelled" });
  });

  test("resolves exactly once, however many times it is finished", async () => {
    const answer = useVaultGate.getState().requestVault({ kind: "open", from: "general" });
    const request = useVaultGate.getState().request!;
    useVaultGate.getState().finish({ ok: true });
    request.resolve({ ok: false, reason: "cancelled" });
    useVaultGate.getState().finish({ ok: false, reason: "cancelled" });
    await expect(answer).resolves.toEqual({ ok: true });
  });

  test("a new request ends the one before it as cancelled", async () => {
    const first = useVaultGate.getState().requestVault({ kind: "open", from: "note" });
    const second = useVaultGate.getState().requestVault({ kind: "lockNote", title: null });
    await expect(first).resolves.toEqual({ ok: false, reason: "cancelled" });
    expect(useVaultGate.getState().request?.purpose.kind).toBe("lockNote");
    useVaultGate.getState().finish({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
  });
});

