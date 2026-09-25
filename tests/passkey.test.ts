import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "fake-indexeddb/auto";
import {
  PasskeyAlreadyRegisteredError,
  PasskeyCancelledError,
  PasskeyNeedsRetryError,
  PrfUnsupportedError,
  buildAssertionOptions,
  createPasskey,
  passkeyBytes,
  startPasskey,
} from "@/lib/crypto/passkey";
import { randomBytes } from "@/lib/crypto/primitives";
import { openVaultRaw, prepareVault } from "@/lib/crypto/vault";
import { savePasskey } from "@/lib/vault/enroll";
import { localPasskeyIds, resetLocalPasskeysForTests } from "@/lib/vault/local-passkeys";
import { FAST_ARGON } from "./helpers/seed";

const id = (n: number) => passkeyBytes.toBase64Url(new Uint8Array([n, n, n]).buffer);
const entry = (n: number) => ({ credentialId: id(n), prfInput: new Uint8Array([n]).buffer });

type Options = CredentialRequestOptions & {
  publicKey: PublicKeyCredentialRequestOptions & { hints?: string[] };
};

let get: ReturnType<typeof vi.fn>;
let createFn: ReturnType<typeof vi.fn>;

/** What a platform authenticator returns for the given credential. */
function assertion(n: number, withPrf = true) {
  return {
    rawId: new Uint8Array([n, n, n]).buffer,
    getClientExtensionResults: () =>
      withPrf ? { prf: { results: { first: new Uint8Array(32).fill(n).buffer } } } : {},
  };
}

beforeEach(() => {
  get = vi.fn();
  createFn = vi.fn();
  Object.defineProperty(navigator, "credentials", {
    value: { get, create: createFn },
    configurable: true,
  });
  resetLocalPasskeysForTests();
});

afterEach(() => vi.restoreAllMocks());

describe("unlocking with a passkey", () => {
  test("one tap asks the system exactly once, before anything is awaited", async () => {
    get.mockResolvedValue(assertion(1));
    const pending = startPasskey([entry(1), entry(2)], []);
    // Called synchronously, so the tap still counts as the reason for it.
    expect(get).toHaveBeenCalledTimes(1);
    await pending;
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("offers only this device's passkeys, internal transport, client-device hint", () => {
    const { options, candidates } = buildAssertionOptions([entry(1), entry(2), entry(3)], [id(2)]);
    expect(candidates.map((c) => c.credentialId)).toEqual([id(2)]);
    expect(options.allowCredentials).toHaveLength(1);
    expect(options.allowCredentials![0]!.transports).toEqual(["internal"]);
    expect(options.hints).toEqual(["client-device"]);
  });

  test("offers every passkey in one request when none is known to be here", () => {
    const { options, candidates } = buildAssertionOptions([entry(1), entry(2)], [id(9)]);
    expect(candidates).toHaveLength(2);
    expect(options.allowCredentials).toHaveLength(2);
    const prf = (options.extensions as { prf: { evalByCredential: Record<string, unknown> } })
      .prf;
    expect(Object.keys(prf.evalByCredential).sort()).toEqual([id(1), id(2)].sort());
  });

  test("a single passkey uses plain eval", () => {
    const { options } = buildAssertionOptions([entry(1)], []);
    const prf = (options.extensions as { prf: { eval?: unknown; evalByCredential?: unknown } })
      .prf;
    expect(prf.eval).toBeDefined();
    expect(prf.evalByCredential).toBeUndefined();
  });

  test("returns the passkey that was used, with its PRF output", async () => {
    get.mockResolvedValue(assertion(2));
    const { entry: used, output } = await startPasskey([entry(1), entry(2)], []);
    expect(used.credentialId).toBe(id(2));
    expect(output).toHaveLength(32);
  });

  test("cancelling stops: no second sheet", async () => {
    get.mockRejectedValue(Object.assign(new Error("no"), { name: "NotAllowedError" }));
    await expect(startPasskey([entry(1), entry(2)], [])).rejects.toBeInstanceOf(
      PasskeyCancelledError,
    );
    expect(get).toHaveBeenCalledTimes(1);
  });

  test("a combined request without PRF output asks that passkey alone next time", async () => {
    get.mockResolvedValueOnce(assertion(2, false));
    const error = await startPasskey([entry(1), entry(2)], []).catch((cause) => cause);
    expect(error).toBeInstanceOf(PasskeyNeedsRetryError);
    expect((error as PasskeyNeedsRetryError).credentialId).toBe(id(2));

    get.mockResolvedValueOnce(assertion(2));
    await startPasskey([entry(1), entry(2)], [], { only: id(2) });
    const second = get.mock.calls[1]![0] as Options;
    expect(second.publicKey.allowCredentials).toHaveLength(1);
    expect((second.publicKey.extensions as { prf: { eval?: unknown } }).prf.eval).toBeDefined();
  });

  test("a single passkey without PRF output falls back to the password", async () => {
    get.mockResolvedValue(assertion(1, false));
    await expect(startPasskey([entry(1)], [])).rejects.toBeInstanceOf(PrfUnsupportedError);
  });
});

describe("registering a passkey", () => {
  const created = (withPrf: boolean) => ({
    rawId: new Uint8Array([7, 7, 7]).buffer,
    getClientExtensionResults: () =>
      withPrf
        ? { prf: { enabled: true, results: { first: new Uint8Array(32).fill(7).buffer } } }
        : { prf: { enabled: true } },
  });

  test("asks the system at once, not tied to the account, never twice on one device", async () => {
    createFn.mockResolvedValue(created(true));
    const pending = createPasskey([id(1), id(2)]);
    expect(createFn).toHaveBeenCalledTimes(1);
    await pending;
    const options = createFn.mock.calls[0]![0].publicKey;
    expect(options.user.name).toBe("Memoca の金庫");
    expect(new Uint8Array(options.user.id)).toHaveLength(16);
    expect(options.excludeCredentials).toHaveLength(2);
    expect(options.hints).toEqual(["client-device"]);
    // Two registrations never share a user handle.
    createFn.mockResolvedValue(created(true));
    await createPasskey([]);
    const again = createFn.mock.calls[1]![0].publicKey;
    expect(Array.from(new Uint8Array(again.user.id))).not.toEqual(
      Array.from(new Uint8Array(options.user.id)),
    );
  });

  test("a device that already holds one of the vault's passkeys says so", async () => {
    createFn.mockRejectedValue(Object.assign(new Error("x"), { name: "InvalidStateError" }));
    await expect(createPasskey([id(1)])).rejects.toBeInstanceOf(PasskeyAlreadyRegisteredError);
  });

  test("without PRF at creation, the second check is left for the next tap", async () => {
    createFn.mockResolvedValue(created(false));
    const passkey = await createPasskey([]);
    expect(passkey.prfOutput).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  test("saving checks the new wrapping opens the vault, and marks it as this device's", async () => {
    const prepared = await prepareVault("パスワード", FAST_ARGON);
    const record = { ...prepared.record, passkeys: [], version: 1 };
    const raw = await openVaultRaw(record, { password: "パスワード" });
    const add = vi.fn().mockResolvedValue({ status: "ok" });

    const result = await savePasskey(
      add,
      record,
      { credentialId: id(7), prfInput: randomBytes(32) },
      randomBytes(32),
      raw,
    );
    expect(result).toBe("ok");
    expect(add).toHaveBeenCalledTimes(1);
    expect(localPasskeyIds()).toContain(id(7));

    add.mockResolvedValue({ status: "tooMany" });
    expect(
      await savePasskey(add, record, { credentialId: id(8), prfInput: randomBytes(32) }, randomBytes(32), raw),
    ).toBe("tooMany");
    expect(localPasskeyIds()).not.toContain(id(8));
  });
});
