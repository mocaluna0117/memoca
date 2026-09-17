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
  constructor(message = "この端末では生体認証によるロック解除に対応していません。") {
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

  if (!created) throw new PrfUnsupportedError("パスキーの作成が取り消されました。");

  const extensions = created.getClientExtensionResults() as PrfExtensionResults;
  if (extensions.prf?.enabled === false) {
    throw new PrfUnsupportedError(
      "この端末のパスキーは、ロック解除に必要な機能（PRF）に対応していません。",
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
          transports: ["internal", "hybrid"],
        },
      ],
      userVerification: "required",
      timeout: 60_000,
      extensions: {
        prf: { eval: { first: toArrayBuffer(prfInput) } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;

  if (!assertion) throw new PrfUnsupportedError("ロック解除が取り消されました。");
  const output = prfResult(assertion);
  if (!output) {
    throw new PrfUnsupportedError(
      "この端末では生体認証からロック解除用の鍵を取り出せませんでした。パスワードで解除してください。",
    );
  }
  return output;
}

export const passkeyBytes = {
  toBase64Url: bufferToBase64Url,
  fromBase64Url: base64UrlToBuffer,
  toBytes,
};
