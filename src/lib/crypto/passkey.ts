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

/**
 * This device's authenticator already holds one of the vault's passkeys, so
 * nothing new was made. It can be put to use by opening the vault with it.
 */
export class PasskeyAlreadyRegisteredError extends Error {
  constructor() {
    super("already registered");
    this.name = "PasskeyAlreadyRegisteredError";
  }
}

// WebAuthn Level 3 `hints` is only in the DOM lib's JSON option types.
type CreationOptions = PublicKeyCredentialCreationOptions & { hints?: string[] };

/** The name the passkey is stored under in the device's password manager. */
const PASSKEY_NAME = "Memoca の金庫";

export type CreatedPasskey = {
  credentialId: string;
  prfInput: Uint8Array;
  /**
   * Null when the browser does not return PRF at creation (Safari). The PRF
   * then takes one more sheet, which needs a tap of its own.
   */
  prfOutput: Uint8Array | null;
};

/**
 * Creates a platform passkey for the vault and reads its PRF output if the
 * browser gives it at creation.
 *
 * Call it straight from a tap, with nothing awaited first: WebKit only shows
 * the sheet while the tap still counts, which is why it never asks for the
 * PRF itself afterwards. The passkey is not tied to the account: a random
 * user handle, and a name that says what it is for rather than the email,
 * which made it look like a sign-in passkey. `exclude` lists the vault's
 * passkeys so the same device is not registered twice.
 */
export async function createPasskey(exclude: string[]): Promise<CreatedPasskey> {
  const prfInput = randomBytes(32);
  const options: CreationOptions = {
    rp: { name: "Memoca", id: window.location.hostname },
    user: {
      id: toArrayBuffer(randomBytes(16)),
      name: PASSKEY_NAME,
      displayName: PASSKEY_NAME,
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
    excludeCredentials: exclude.map((id) => ({
      type: "public-key" as const,
      id: base64UrlToBuffer(id),
      transports: ["internal" as const],
    })),
    hints: ["client-device"],
    attestation: "none",
    timeout: 60_000,
    extensions: {
      prf: { eval: { first: toArrayBuffer(prfInput) } },
    } as AuthenticationExtensionsClientInputs,
  };

  let created: PublicKeyCredential | null;
  try {
    created = (await navigator.credentials.create({ publicKey: options })) as PublicKeyCredential | null;
  } catch (cause) {
    const name = cause instanceof Error ? cause.name : "";
    if (name === "InvalidStateError") throw new PasskeyAlreadyRegisteredError();
    if (name === "NotAllowedError" || name === "AbortError") throw new PasskeyCancelledError();
    throw cause;
  }
  if (!created) throw new PasskeyCancelledError();

  const extensions = created.getClientExtensionResults() as PrfExtensionResults;
  if (extensions.prf?.enabled === false) {
    throw new PrfUnsupportedError(
      "この端末のパスキーは、金庫を開く機能に対応していません。金庫はパスワードで開けます。",
    );
  }
  return {
    credentialId: bufferToBase64Url(created.rawId),
    prfInput,
    prfOutput: prfResult(created),
  };
}

export const passkeyBytes = {
  toBase64Url: bufferToBase64Url,
  fromBase64Url: base64UrlToBuffer,
  toBytes,
};
