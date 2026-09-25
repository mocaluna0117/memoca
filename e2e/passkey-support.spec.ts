import { expect, test } from "@playwright/test";
import { addVirtualPasskey } from "./webauthn";

/**
 * Checks, before any passkey E2E test relies on it, that Chromium's virtual
 * authenticator gives the vault what a real Face ID / Touch ID passkey does:
 * a user-verifying platform authenticator whose PRF extension returns 32 bytes
 * through both `eval` and `evalByCredential`.
 */
test("the virtual authenticator supports what vault passkeys need", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await addVirtualPasskey(context, page);

  const result = await page.evaluate(async () => {
    // WebAuthn Level 3 `hints` is only in the DOM lib's JSON option types.
    type RequestOptions = PublicKeyCredentialRequestOptions & { hints?: string[] };
    const b64u = (bytes: ArrayBuffer) =>
      btoa(String.fromCharCode(...new Uint8Array(bytes)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
    const uvpaa = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();

    const create = async (prfInput: Uint8Array<ArrayBuffer>) => {
      const credential = (await navigator.credentials.create({
        publicKey: {
          challenge: random(32),
          rp: { name: "Memoca", id: location.hostname },
          user: { id: random(16), name: "Memoca の金庫", displayName: "Memoca の金庫" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            residentKey: "required",
            userVerification: "required",
          },
          extensions: { prf: { eval: { first: prfInput } } },
        },
      })) as PublicKeyCredential;
      const prf = credential.getClientExtensionResults().prf;
      return {
        id: b64u(credential.rawId),
        enabled: prf?.enabled ?? null,
        resultAtCreate: prf?.results?.first ? (prf.results.first as ArrayBuffer).byteLength : 0,
      };
    };

    const inputA = random(32);
    const inputB = random(32);
    const a = await create(inputA);
    const b = await create(inputB);
    const toBytes = (id: string) =>
      Uint8Array.from(atob(id.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

    const singleOptions: RequestOptions = {
      challenge: random(32),
      rpId: location.hostname,
      userVerification: "required",
      allowCredentials: [{ type: "public-key", id: toBytes(a.id), transports: ["internal"] }],
      hints: ["client-device"],
      extensions: { prf: { eval: { first: inputA } } },
    };
    const single = (await navigator.credentials.get({
      publicKey: singleOptions,
    })) as PublicKeyCredential;
    const singleBytes = (single.getClientExtensionResults().prf?.results?.first as ArrayBuffer | undefined)?.byteLength ?? 0;

    const manyOptions: RequestOptions = {
      challenge: random(32),
      rpId: location.hostname,
      userVerification: "required",
      allowCredentials: [a, b].map((entry) => ({
        type: "public-key" as const,
        id: toBytes(entry.id),
        transports: ["internal" as const],
      })),
      hints: ["client-device"],
      extensions: {
        prf: { evalByCredential: { [a.id]: { first: inputA }, [b.id]: { first: inputB } } },
      },
    };
    const many = (await navigator.credentials.get({
      publicKey: manyOptions,
    })) as PublicKeyCredential;
    const manyBytes = (many.getClientExtensionResults().prf?.results?.first as ArrayBuffer | undefined)?.byteLength ?? 0;

    return {
      uvpaa,
      created: [a, b].map(({ enabled, resultAtCreate }) => ({ enabled, resultAtCreate })),
      singleBytes,
      manyBytes,
      manyChose: [a.id, b.id].indexOf(b64u(many.rawId)),
    };
  });

  console.log("virtual authenticator:", JSON.stringify(result));
  expect(result.uvpaa).toBe(true);
  expect(result.created.every((entry) => entry.enabled === true)).toBe(true);
  expect(result.singleBytes).toBe(32);
  expect(result.manyBytes).toBe(32);
  expect(result.manyChose).toBeGreaterThanOrEqual(0);
});
