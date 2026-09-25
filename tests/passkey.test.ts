import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  PasskeyCancelledError,
  PasskeyNeedsRetryError,
  PrfUnsupportedError,
  buildAssertionOptions,
  passkeyBytes,
  startPasskey,
} from "@/lib/crypto/passkey";

const id = (n: number) => passkeyBytes.toBase64Url(new Uint8Array([n, n, n]).buffer);
const entry = (n: number) => ({ credentialId: id(n), prfInput: new Uint8Array([n]).buffer });

type Options = CredentialRequestOptions & {
  publicKey: PublicKeyCredentialRequestOptions & { hints?: string[] };
};

let get: ReturnType<typeof vi.fn>;

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
  Object.defineProperty(navigator, "credentials", {
    value: { get },
    configurable: true,
  });
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
