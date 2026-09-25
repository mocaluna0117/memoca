import type { BrowserContext, CDPSession, Page } from "@playwright/test";

/**
 * A software passkey for Chromium, standing in for Face ID / Touch ID.
 *
 * It is a platform ("internal") authenticator that verifies the user and
 * supports PRF, which is what the vault needs. It lives on one page's CDP
 * session: a second browser context needs its own.
 */
export async function addVirtualPasskey(
  context: BrowserContext,
  page: Page,
): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  });
  return { cdp, authenticatorId };
}

/** Makes the next ceremonies fail user verification, like a cancelled Face ID. */
export async function setUserVerified(
  cdp: CDPSession,
  authenticatorId: string,
  isUserVerified: boolean,
): Promise<void> {
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified });
}

/**
 * Counts navigator.credentials.get calls, so a test can assert that one tap
 * produced exactly one prompt. Install before the page loads.
 */
export async function countCredentialGets(page: Page): Promise<() => Promise<number>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __credentialGets: unknown[] };
    w.__credentialGets = [];
    const original = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = (options?: CredentialRequestOptions) => {
      w.__credentialGets.push(JSON.parse(JSON.stringify(options?.publicKey ?? {}, (_key, value) =>
        value instanceof ArrayBuffer || ArrayBuffer.isView(value) ? "[bytes]" : value,
      )));
      return original(options);
    };
  });
  return () =>
    page.evaluate(
      () => (window as unknown as { __credentialGets: unknown[] }).__credentialGets.length,
    );
}
