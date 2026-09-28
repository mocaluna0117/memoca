import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { beforeEach, describe, expect, test } from "vitest";
import { CODE_TTL_MS, FRESH_MS, desktopSignIn, sha256 } from "./lib/desktopSignIn";

/** A verifier as the shell makes one: 32 random bytes, as base64url. */
function verifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Db = Record<string, Record<string, unknown>[]>;
let db: Db;
let auth: ReturnType<typeof makeAuth>;

function makeAuth() {
  return betterAuth({
    baseURL: "http://localhost:3000",
    secret: "a-test-secret-that-is-long-enough-for-better-auth",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    plugins: [desktopSignIn()],
  });
}

/** A browser signed in: the headers its requests carry. */
async function browser(email = "someone@example.com"): Promise<Headers> {
  const { headers } = await auth.api.signUpEmail({
    body: { email, password: "a-long-password", name: "someone" },
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  return new Headers({ cookie });
}

// The endpoints read their bodies themselves (lib/desktopSignIn.ts), so their
// types take none.
const code = (headers: Headers, challenge: string) =>
  auth.api.desktopSignInCode({ headers, body: { challenge } } as never) as unknown as Promise<{
    code: string;
  }>;

/** The shell's window, on Memoca's page, takes a code; `headers` as it sends them. */
const exchange = (
  body: { code: string; verifier: string },
  headers = new Headers({ origin: "http://localhost:3000" }),
) =>
  auth.api.desktopSignInExchange({
    body,
    headers,
    returnHeaders: true,
  } as never) as unknown as Promise<{
    headers: Headers;
  }>;

/** Whose session a cookie from an exchange is, and which. */
async function sessionOf(setCookie: string[]) {
  const cookie = setCookie.map((line) => line.split(";")[0]).join("; ");
  return auth.api.getSession({ headers: new Headers({ cookie }) });
}

beforeEach(() => {
  db = { user: [], session: [], account: [], verification: [] };
  auth = makeAuth();
});

describe("signing the desktop shell in", () => {
  test("a code made for the shell's challenge, taken with its verifier, is a session of the shell's own", async () => {
    const headers = await browser();
    const secret = verifier();
    const { code: made } = await code(headers, await sha256(secret));
    expect(made).toMatch(/^[A-Za-z0-9]{32}$/);

    const { headers: back } = await exchange({ code: made, verifier: secret });
    const shell = await sessionOf(back.getSetCookie());
    const own = await auth.api.getSession({ headers });
    expect(shell?.user.email).toBe("someone@example.com");
    // Not the browser's: signing out there leaves the shell signed in.
    expect(shell?.session.token).not.toBe(own?.session.token);
    await auth.api.signOut({ headers });
    expect(await auth.api.getSession({ headers })).toBeNull();
    expect((await sessionOf(back.getSetCookie()))?.user.email).toBe("someone@example.com");
  });

  test("is good once", async () => {
    const headers = await browser();
    const secret = verifier();
    const { code: made } = await code(headers, await sha256(secret));
    await exchange({ code: made, verifier: secret });
    await expect(exchange({ code: made, verifier: secret })).rejects.toThrow("Invalid code");
  });

  test("taken with another verifier (passed on to someone else, or made for another shell), signs nothing in, and goes", async () => {
    const headers = await browser();
    const secret = verifier();
    const { code: made } = await code(headers, await sha256(secret));
    await expect(exchange({ code: made, verifier: verifier() })).rejects.toThrow("Invalid code");
    // The one guess was the code's last.
    await expect(exchange({ code: made, verifier: secret })).rejects.toThrow("Invalid code");
    expect(db.session).toHaveLength(1);
  });

  test("is good for three minutes, and made only for a browser signed in the last ten", async () => {
    expect(CODE_TTL_MS).toBe(3 * 60 * 1000);
    expect(FRESH_MS).toBe(10 * 60 * 1000);
    const headers = await browser();
    // A session opened long ago, on a computer left unlocked say: Google is asked again first.
    db.session[0]!.createdAt = new Date(Date.now() - FRESH_MS);
    await expect(code(headers, await sha256(verifier()))).rejects.toThrow("Sign in again");
    db.session[0]!.createdAt = new Date(Date.now() - FRESH_MS + 60_000);
    await expect(code(headers, await sha256(verifier()))).resolves.toHaveProperty("code");
  });

  test("expires three minutes on", async () => {
    const headers = await browser();
    const secret = verifier();
    const { code: made } = await code(headers, await sha256(secret));
    const row = db.verification.at(-1)!;
    expect((row.expiresAt as Date).getTime() - Date.now()).toBeGreaterThan(CODE_TTL_MS - 5_000);
    expect((row.expiresAt as Date).getTime() - Date.now()).toBeLessThanOrEqual(CODE_TTL_MS);
    row.expiresAt = new Date(Date.now() - 1);
    await expect(exchange({ code: made, verifier: secret })).rejects.toThrow("Invalid code");
  });

  test("is kept only as a hash", async () => {
    const headers = await browser();
    const { code: made } = await code(headers, await sha256(verifier()));
    expect(JSON.stringify(db.verification)).not.toContain(made);
  });

  test("is made only for a browser signed in, and for a challenge of the shell's shape", async () => {
    await expect(code(new Headers(), await sha256(verifier()))).rejects.toThrow();
    const headers = await browser();
    await expect(code(headers, "short")).rejects.toThrow("Invalid challenge");
  });

  test("is taken only from Memoca's own pages", async () => {
    const headers = await browser();
    const secret = verifier();
    const { code: made } = await code(headers, await sha256(secret));
    for (const from of [new Headers(), new Headers({ origin: "https://evil.example" })]) {
      await expect(exchange({ code: made, verifier: secret }, from)).rejects.toThrow(
        "Invalid code",
      );
    }
    // Turned away before it is looked up: still good from Memoca.
    const { headers: back } = await exchange({ code: made, verifier: secret });
    expect((await sessionOf(back.getSetCookie()))?.user.email).toBe("someone@example.com");
  });

  test("takes over from a session the window had, which goes", async () => {
    const headers = await browser();
    const first = verifier();
    const { code: one } = await code(headers, await sha256(first));
    const { headers: back } = await exchange({ code: one, verifier: first });
    const window = new Headers({
      origin: "http://localhost:3000",
      cookie: back
        .getSetCookie()
        .map((line) => line.split(";")[0])
        .join("; "),
    });
    const second = verifier();
    const { code: two } = await code(headers, await sha256(second));
    const { headers: again } = await exchange({ code: two, verifier: second }, window);
    expect(await sessionOf(back.getSetCookie())).toBeNull();
    expect((await sessionOf(again.getSetCookie()))?.user.email).toBe("someone@example.com");
    // The browser's own, and the window's latest.
    expect(db.session).toHaveLength(2);
  });

  test("a verifier of the wrong shape is turned away before the code is looked up", async () => {
    const headers = await browser();
    const secret = verifier();
    const { code: made } = await code(headers, await sha256(secret));
    await expect(exchange({ code: made, verifier: "short" })).rejects.toThrow("Invalid code");
    await expect(exchange({ code: made, verifier: `${secret}=` })).rejects.toThrow("Invalid code");
    // So the code is still there for its own verifier.
    await expect(exchange({ code: made, verifier: secret })).resolves.toBeDefined();
  });

  test("for an account gone since, signs nothing in", async () => {
    const headers = await browser();
    const secret = verifier();
    const { code: made } = await code(headers, await sha256(secret));
    db.user.length = 0;
    await expect(exchange({ code: made, verifier: secret })).rejects.toThrow("Invalid code");
  });

  test("a code or a verifier of the wrong shape is turned away before anything is looked up", async () => {
    await expect(exchange({ code: "not-a-code", verifier: verifier() })).rejects.toThrow(
      "Invalid code",
    );
    await expect(exchange({ code: "a".repeat(32), verifier: "short" })).rejects.toThrow(
      "Invalid code",
    );
  });

  test("the challenge is the verifier's SHA-256, as RFC 7636 writes it", async () => {
    // RFC 7636, appendix B.
    expect(await sha256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});
