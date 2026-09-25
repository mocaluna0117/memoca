"use client";

import { toArrayBuffer, toBytes } from "@/lib/bytes";
import { randomBytes } from "./primitives";

/**
 * Face ID, Touch ID and Android biometrics as a vault unlock method.
 *
 * The passkey is never used to authenticate to the server: sign-in is Google.
 * It is used purely for its PRF extension, which returns a stable secret the
 * authenticator will only reveal after a successful biometric check. That
 * secret derives a wrapping key for the vault key, so the phone's own
 * protection gates the notes without any of it reaching the network.
 */

export class PrfUnsupportedError extends Error {
  constructor(
    message = "この端末またはブラウザは、パスキーで金庫を開く機能に対応していません。パスワードを使ってください。",
  ) {
    super(message);
    this.name = "PrfUnsupportedError";
  }
}

const bufferToBase64Url = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const base64UrlToBuffer = (value: string): ArrayBuffer => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return toArrayBuffer(bytes);
};

export async function platformAuthenticatorAvailable(): Promise<boolean> {
  if (typeof window === "undefined" || !window.PublicKeyCredential) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/**
 * The person closed the system sheet, it timed out, or the page aborted it.
 * Not an error to show: they chose not to continue.
 */
export class PasskeyCancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "PasskeyCancelledError";
  }
}

/**
 * Several passkeys were offered at once and the one used did not return its
 * PRF output, which some browsers only do for a single-credential request.
 * The next tap asks that passkey alone.
 */
export class PasskeyNeedsRetryError extends Error {
  constructor(readonly credentialId: string) {
    super("retry");
    this.name = "PasskeyNeedsRetryError";
  }
}

// WebAuthn Level 3 `hints` is only in the DOM lib's JSON option types.
type RequestOptions = PublicKeyCredentialRequestOptions & { hints?: string[] };

/** A registered passkey as the vault record lists it. */
export type PasskeyEntry = { credentialId: string; prfInput: ArrayBuffer };

/**
 * The single request for one tap.
 *
 * Only passkeys known to be on this device are offered when there are any;
 * offering a passkey that lives elsewhere is what made browsers show their
 * chooser or a QR code for another device. Transports are "internal" only for
 * the same reason, and the client-device hint asks for this device's own
 * authenticator. Each passkey has its own PRF input, so several at once need
 * evalByCredential.
 */
export function buildAssertionOptions(
  entries: PasskeyEntry[],
  localIds: string[],
): { options: RequestOptions; candidates: PasskeyEntry[] } {
  const local = entries.filter((entry) => localIds.includes(entry.credentialId));
  const candidates = local.length > 0 ? local : entries;
  const prf =
    candidates.length === 1
      ? { eval: { first: candidates[0]!.prfInput } }
      : {
          evalByCredential: Object.fromEntries(
            candidates.map((entry) => [entry.credentialId, { first: entry.prfInput }]),
          ),
        };
  return {
    candidates,
    options: {
      challenge: toArrayBuffer(randomBytes(32)),
      rpId: window.location.hostname,
      allowCredentials: candidates.map((entry) => ({
        type: "public-key",
        id: base64UrlToBuffer(entry.credentialId),
        transports: ["internal"],
      })),
      hints: ["client-device"],
      userVerification: "required",
      timeout: 60_000,
      extensions: { prf } as AuthenticationExtensionsClientInputs,
    },
  };
}

/**
 * Shows the Face ID / Touch ID sheet once and returns the PRF output.
 *
 * Call it straight from the tap, with nothing awaited first: WebKit only
 * shows the sheet while the tap still counts as the reason for it. It never
 * retries on its own; a cancel means stop.
 */
export async function startPasskey(
  entries: PasskeyEntry[],
  localIds: string[],
  opts: { signal?: AbortSignal; only?: string } = {},
): Promise<{ entry: PasskeyEntry; output: Uint8Array }> {
  const pool = opts.only ? entries.filter((entry) => entry.credentialId === opts.only) : entries;
  if (pool.length === 0) throw new PrfUnsupportedError();
  const { options, candidates } = buildAssertionOptions(pool, localIds);

  let assertion: PublicKeyCredential | null;
  try {
    assertion = (await navigator.credentials.get({
      publicKey: options,
      signal: opts.signal,
    })) as PublicKeyCredential | null;
  } catch (cause) {
    const name = cause instanceof Error ? cause.name : "";
    if (name === "NotAllowedError" || name === "AbortError") throw new PasskeyCancelledError();
    throw cause;
  }
  if (!assertion) throw new PasskeyCancelledError();

  const usedId = bufferToBase64Url(assertion.rawId);
  const entry = candidates.find((candidate) => candidate.credentialId === usedId);
  if (!entry) throw new PrfUnsupportedError("この端末のパスキーでは金庫を開けませんでした。");
  const output = prfResult(assertion);
  if (!output) {
    if (candidates.length > 1) throw new PasskeyNeedsRetryError(entry.credentialId);
    throw new PrfUnsupportedError(
      "この端末のパスキーでは金庫を開けませんでした。パスワードを使ってください。",
    );
  }
  return { entry, output };
}

type PrfExtensionResults = {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
};

function prfResult(credential: PublicKeyCredential): Uint8Array | null {
  const results = credential.getClientExtensionResults() as PrfExtensionResults;
  const first = results.prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}

export type RegisteredPasskey = {
  credentialId: string;
  prfInput: Uint8Array;
  prfOutput: Uint8Array;
};

/**
 * Creates a platform passkey and reads its PRF output.
 *
 * Some browsers return the PRF value straight from creation and some only from
 * a subsequent assertion, so both paths are tried before giving up. A user
 * whose device cannot do this still has the password and recovery key.
 */
export async function registerPasskey(opts: {
  userId: string;
  userName: string;
  displayName: string;
}): Promise<RegisteredPasskey> {
  if (!(await platformAuthenticatorAvailable())) throw new PrfUnsupportedError();

  const prfInput = randomBytes(32);
  const created = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "Memoca", id: window.location.hostname },
      user: {
        id: toArrayBuffer(new TextEncoder().encode(opts.userId)),
        name: opts.userName,
        displayName: opts.displayName,
      },
      challenge: toArrayBuffer(randomBytes(32)),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "required",
        userVerification: "required",
      },
      timeout: 60_000,
      extensions: {
        prf: { eval: { first: toArrayBuffer(prfInput) } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;

  if (!created) throw new PrfUnsupportedError("登録をキャンセルしました。");

  const extensions = created.getClientExtensionResults() as PrfExtensionResults;
  if (extensions.prf?.enabled === false) {
    throw new PrfUnsupportedError(
      "この端末のパスキーは、金庫を開く機能に対応していません。金庫はパスワードで開けます。",
    );
  }

  const credentialId = bufferToBase64Url(created.rawId);
  const atCreate = prfResult(created);
  if (atCreate) return { credentialId, prfInput, prfOutput: atCreate };

  // Safari does not return PRF at creation time; ask for it with an assertion.
  const prfOutput = await evaluatePrf(credentialId, prfInput);
  return { credentialId, prfInput, prfOutput };
}

/** Asks the authenticator for the PRF output behind a biometric check. */
export async function evaluatePrf(
  credentialId: string,
  prfInput: Uint8Array,
): Promise<Uint8Array> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: toArrayBuffer(randomBytes(32)),
      allowCredentials: [
        {
          type: "public-key",
          id: base64UrlToBuffer(credentialId),
          // Internal only: "hybrid" is what offers another device and a QR code.
          transports: ["internal"],
        },
      ],
      userVerification: "required",
      timeout: 60_000,
      extensions: {
        prf: { eval: { first: toArrayBuffer(prfInput) } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;

  if (!assertion) throw new PrfUnsupportedError("確認をキャンセルしました。");
  const output = prfResult(assertion);
  if (!output) {
    throw new PrfUnsupportedError(
      "この端末のパスキーでは金庫を開けませんでした。パスワードを使ってください。",
    );
  }
  return output;
}

export const passkeyBytes = {
  toBase64Url: bufferToBase64Url,
  fromBase64Url: base64UrlToBuffer,
  toBytes,
};
